import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryBootstrapClient } from "@octant/client-runtime/repository-bootstrap-client";
import { decodeProjectId, decodeWindowId, type Project } from "@octant/contracts";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { decodeRepositoryBootstrapOperationId } from "@octant/contracts/repository-bootstrap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BindingReceiptStore } from "./bindingReceiptStore";
import { AGENT_ACCESS_ORIGIN, createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { ProjectRootPort } from "./projectRootPort";
import {
  REPOSITORY_BOOTSTRAP_RECEIVING_PATHS,
  REPOSITORY_BOOTSTRAP_SOURCE_PATHS,
  createRepositoryBootstrapRouteHandler,
} from "./repositoryBootstrapRoutes";
import {
  RepositoryBootstrapService,
  type RepositoryBootstrapCloneRunner,
} from "./repositoryBootstrapService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const WINDOW_ID = decodeWindowId("11111111-1111-4111-8111-111111111111");
const DEVICE_ID = "22222222-2222-4222-8222-222222222222" as DeviceId;
const CAPABILITY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROJECT_ID = decodeProjectId("33333333-3333-4333-8333-333333333333");
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const store = new WindowAuthorityStore();
  store.register({ windowId: WINDOW_ID, capability: CAPABILITY, now: 1_000 });
  const service = {
    inspect: vi.fn().mockResolvedValue({
      status: "ok",
      value: {
        projectId: "33333333-3333-4333-8333-333333333333",
        projectName: "demo",
        sourcePath: "/tmp/demo",
        repositoryName: "demo",
        defaultDestinationPath: "~/demo",
        remotes: {
          originUrl: "git@github.com:org/demo.git",
          sshUrl: "git@github.com:org/demo.git",
          httpsUrl: "https://github.com/org/demo.git",
          defaultTransport: "ssh",
        },
        ignoredFiles: [],
        truncated: false,
        omittedCount: 0,
        omittedOversizedCount: 0,
        caps: { maxFiles: 200, maxFileBytes: 2_097_152, maxTotalBytes: 20_971_520 },
      },
    }),
    readIgnoredFile: vi.fn(),
    startClone: vi.fn().mockResolvedValue({
      status: "ok",
      value: {
        operation: {
          state: "cloning",
          operationId: "44444444-4444-4444-8444-444444444444",
          transport: "ssh",
          destinationPath: "~/demo",
          updatedAt: "2026-11-24T20:00:00.000Z",
        },
      },
    }),
    cloneStatus: vi.fn(),
    cancelClone: vi.fn(),
    landFiles: vi.fn(),
  } as unknown as RepositoryBootstrapService;

  const handle = createRepositoryBootstrapRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => 2_000,
  });

  return { handle, service, capability: CAPABILITY };
}

function makeDeviceRequest(
  path: string,
  body: unknown,
  input: { readonly admittedBy: "host-person" | "hub-roster"; readonly origin?: string },
): Request {
  const request = new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  bindPrincipalRouteContext(request, {
    principal: createRemoteDevicePrincipal({
      hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
      deviceId: DEVICE_ID,
      credentialGeneration: 1,
      origin: input.origin ?? "https://octant.example",
      protocolVersion: 1,
      capabilityDigest: "b".repeat(64),
      sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
      admittedBy: input.admittedBy,
    }),
    scopeId: WINDOW_ID,
  });
  return request;
}

describe("repository bootstrap routes authorization", () => {
  it("refuses hub-introduced devices without host-person standing and refuses agent grants on every route", async () => {
    const { handle } = setup();
    const allPaths = [
      ...REPOSITORY_BOOTSTRAP_SOURCE_PATHS,
      ...REPOSITORY_BOOTSTRAP_RECEIVING_PATHS,
    ];

    for (const path of allPaths) {
      const hubIntroduced = await handle(makeDeviceRequest(path, {}, { admittedBy: "hub-roster" }));
      expect(hubIntroduced?.status).toBe(403);
      expect(await hubIntroduced?.json()).toMatchObject({ code: "unauthorized" });

      const agentGrant = await handle(
        makeDeviceRequest(path, {}, { admittedBy: "host-person", origin: AGENT_ACCESS_ORIGIN }),
      );
      expect(agentGrant?.status).toBe(403);
      expect(await agentGrant?.json()).toMatchObject({ code: "unauthorized" });
    }
  });

  it("admits a local window for source inspection and a host-person paired device for cloning", async () => {
    const { handle, capability, service } = setup();

    const inspectResponse = await handle(
      new Request("http://127.0.0.1/api/projects/repository-bootstrap/inspect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ projectId: "33333333-3333-4333-8333-333333333333" }),
      }),
    );
    expect(inspectResponse?.status).toBe(200);
    expect(service.inspect).toHaveBeenCalledTimes(1);

    const cloneResponse = await handle(
      makeDeviceRequest(
        "/api/projects/repository-bootstrap/clone",
        {
          operationId: "44444444-4444-4444-8444-444444444444",
          remoteUrl: "git@github.com:org/demo.git",
          transport: "ssh",
          destinationPath: "~/demo",
        },
        { admittedBy: "host-person" },
      ),
    );
    expect(cloneResponse?.status).toBe(200);
    expect(service.startClone).toHaveBeenCalledTimes(1);
  });

  it("allows packaged desktop Origin: null preflight and POST requests on loopback", async () => {
    const { handle, capability } = setup();

    const preflight = await handle(
      new Request("http://127.0.0.1/api/projects/repository-bootstrap/inspect", {
        method: "OPTIONS",
        headers: { origin: "null" },
      }),
    );
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("access-control-allow-origin")).toBe("null");

    const post = await handle(
      new Request("http://127.0.0.1/api/projects/repository-bootstrap/inspect", {
        method: "POST",
        headers: {
          origin: "null",
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ projectId: "33333333-3333-4333-8333-333333333333" }),
      }),
    );
    expect(post?.status).toBe(200);
  });

  it("transfers chosen ignored files end-to-end across source and receiving route handlers and issues a valid binding receipt", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "octant-two-host-src-"));
    const destHome = mkdtempSync(join(tmpdir(), "octant-two-host-dst-"));
    tempRoots.push(sourceRoot, destHome);

    execFileSync("git", ["init", "-q", "-b", "main", sourceRoot]);
    execFileSync("git", ["-C", sourceRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", sourceRoot, "config", "user.name", "Test"]);
    writeFileSync(join(sourceRoot, "README.md"), "# paired\n");
    writeFileSync(join(sourceRoot, ".gitignore"), ".env\n");
    execFileSync("git", ["-C", sourceRoot, "add", "README.md", ".gitignore"]);
    execFileSync("git", ["-C", sourceRoot, "commit", "-q", "-m", "init"]);
    execFileSync("git", [
      "-C",
      sourceRoot,
      "remote",
      "add",
      "origin",
      "git@github.com:org/paired.git",
    ]);
    writeFileSync(join(sourceRoot, ".env"), "SECRET_KEY=paired-value\n");
    chmodSync(join(sourceRoot, ".env"), 0o600);

    const sourceStore = new WindowAuthorityStore();
    sourceStore.register({ windowId: WINDOW_ID, capability: CAPABILITY, now: 1_000 });
    const sourceService = new RepositoryBootstrapService({
      readProject: (id) =>
        String(id) === String(PROJECT_ID)
          ? ({
              type: "code",
              id: PROJECT_ID,
              name: "paired",
              lifecycle: "active",
              pinned: false,
              rank: "a0",
              createdAt: "2026-11-24T20:00:00.000Z",
              binding: { canonicalRoot: sourceRoot },
              bindingHistory: [],
            } as unknown as Project)
          : undefined,
      bindingReceiptStore: new BindingReceiptStore(),
      projectRootPort: new ProjectRootPort(),
      homeDir: sourceRoot,
    });
    const sourceHandler = createRepositoryBootstrapRouteHandler({
      service: sourceService,
      windowAuthorityStore: sourceStore,
      now: () => 2_000,
    });

    const destReceiptStore = new BindingReceiptStore();
    const destRunner: RepositoryBootstrapCloneRunner = {
      clone: async ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        execFileSync("git", ["clone", "-q", sourceRoot, stagingPath]);
        return { kind: "completed" };
      },
      verifyNonBareCheckout: async () => true,
      close: () => undefined,
    };
    const destService = new RepositoryBootstrapService({
      readProject: () => undefined,
      bindingReceiptStore: destReceiptStore,
      projectRootPort: new ProjectRootPort(),
      homeDir: destHome,
      cloneRunner: destRunner,
    });
    const destHandler = createRepositoryBootstrapRouteHandler({
      service: destService,
      windowAuthorityStore: new WindowAuthorityStore(),
      now: () => 2_000,
    });

    try {
      const sourceClient = createRepositoryBootstrapClient({
        baseUrl: "http://127.0.0.1",
        windowCapability: CAPABILITY,
        fetch: Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            const response = await sourceHandler(new Request(input, init));
            if (response === undefined) throw new Error("Unhandled source request");
            return response;
          },
          { preconnect: () => undefined },
        ),
      });
      const destClient = createRepositoryBootstrapClient({
        baseUrl: "http://127.0.0.1",
        windowCapability: "",
        fetch: Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            const req = new Request(input, init);
            bindPrincipalRouteContext(req, {
              principal: createRemoteDevicePrincipal({
                hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
                deviceId: DEVICE_ID,
                credentialGeneration: 1,
                origin: "https://octant.example",
                protocolVersion: 1,
                capabilityDigest: "b".repeat(64),
                sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
                admittedBy: "host-person",
              }),
              scopeId: WINDOW_ID,
            });
            const response = await destHandler(req);
            if (response === undefined) throw new Error("Unhandled destination request");
            return response;
          },
          { preconnect: () => undefined },
        ),
      });

      const inspected = await sourceClient.inspect({ projectId: PROJECT_ID });
      expect(inspected.ignoredFiles.map((file) => file.path)).toEqual([".env"]);

      const operationId = decodeRepositoryBootstrapOperationId(
        "99999999-9999-4999-8999-999999999999",
      );
      await destClient.startClone({
        operationId,
        remoteUrl: inspected.remotes.sshUrl ?? "",
        transport: "ssh",
        destinationPath: "~/paired",
      });
      let op = (await destClient.cloneStatus({ operationId })).operation;
      for (let attempt = 0; attempt < 20 && op.state === "cloning"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        op = (await destClient.cloneStatus({ operationId })).operation;
      }
      expect(op.state).toBe("cloned");
      if (op.state !== "cloned") throw new Error("Expected cloned operation");

      const filePayload = await sourceClient.readIgnoredFile({
        projectId: PROJECT_ID,
        relativePath: ".env",
      });
      const landed = await destClient.landFiles({
        operationId,
        files: [filePayload],
      });
      expect(landed).toEqual({ status: "landed", landed: [".env"], failed: [] });

      const consumed = destReceiptStore.consume({
        receiptId: op.receiptId,
        authenticatedWindowId: WINDOW_ID,
        projectType: "code",
        now: 3_000,
      });
      expect(consumed.canonicalRoot).toBe(op.canonicalDestination);
      const copiedEnvPath = join(op.canonicalDestination, ".env");
      expect(readFileSync(copiedEnvPath, "utf8")).toBe("SECRET_KEY=paired-value\n");
      expect(statSync(copiedEnvPath).mode & 0o777).toBe(0o600);
    } finally {
      sourceService.close();
      destService.close();
    }
  });
});
