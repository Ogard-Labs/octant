import { decodeWindowId } from "@octant/contracts";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ACCESS_ORIGIN, createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import {
  REPOSITORY_BOOTSTRAP_RECEIVING_PATHS,
  REPOSITORY_BOOTSTRAP_SOURCE_PATHS,
  createRepositoryBootstrapRouteHandler,
} from "./repositoryBootstrapRoutes";
import type { RepositoryBootstrapService } from "./repositoryBootstrapService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const WINDOW_ID = decodeWindowId("11111111-1111-4111-8111-111111111111");
const DEVICE_ID = "22222222-2222-4222-8222-222222222222" as DeviceId;
const CAPABILITY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function setup() {
  const store = new WindowAuthorityStore();
  store.register({ windowId: WINDOW_ID, capability: CAPABILITY, now: 1_000 });
  const service = {
    inspect: vi.fn().mockResolvedValue({
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
    }),
    readIgnoredFile: vi.fn(),
    startClone: vi.fn().mockResolvedValue({
      operation: {
        state: "cloning",
        operationId: "44444444-4444-4444-8444-444444444444",
        transport: "ssh",
        destinationPath: "~/demo",
        updatedAt: "2026-11-24T20:00:00.000Z",
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
});
