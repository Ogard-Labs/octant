import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  type ProviderInstance,
  type ProviderRegistryCommand,
} from "@octant/contracts";
import { canLocateRuntimeBinary } from "@octant/domain";
import { DISCOVERY_DESCRIPTORS } from "@octant/provider-sdk/discovery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPluginImportReceiptStore } from "../extensions/localPluginImportReceiptStore";
import type { SeatbeltConfinementPort } from "../process/seatbeltProfile";
import { createDiscoveryRouteHandler } from "./discoveryRoutes";
import { makeDiscoveryService, type DiscoveryService } from "./discoveryService";
import type { WindowAuthorityStore } from "../windowAuthorityStore";

const fakeSnapshot = {
  hostId: "local",
  candidates: [
    {
      driverKind: "codex",
      displayName: "Codex CLI",
      binaryPath: "/usr/local/bin/codex",
      version: "codex-cli 0.1.0",
      readiness: "ready",
      pathSummary: "/usr/local/bin/codex",
      onboardingGuidance: "Run codex login.",
      detectedAt: "2026-07-25T10:00:00.000Z",
    },
  ],
  scannedAt: "2026-07-25T10:00:00.000Z",
  scanDurationMs: 200,
  status: "completed",
};

const duplicateFamilySnapshot = {
  ...fakeSnapshot,
  candidates: [
    fakeSnapshot.candidates[0]!,
    {
      ...fakeSnapshot.candidates[0]!,
      binaryPath: "/usr/local/bin/codex",
      pathSummary: "/usr/local/bin/codex",
      detectedAt: "2026-07-25T10:00:01.000Z",
    },
  ],
};

function makeFakeWindowAuthorityStore(): WindowAuthorityStore {
  return {
    authenticate: () => "test-window-id",
  } as unknown as WindowAuthorityStore;
}

function makeFakeDiscoveryService(snapshot = fakeSnapshot): DiscoveryService {
  return {
    scan: async () => snapshot as any,
    getLastScanCandidates: () => snapshot.candidates as any,
    checkPickedBinary: async () => {
      throw new Error("These cases never check a picked binary.");
    },
  };
}

function makeRequest(
  path: string,
  options: { method?: string; body?: unknown; origin?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "x-octant-window-capability": "test-capability",
  };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = {
    method: options.method ?? "POST",
    headers,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

describe("discoveryRoutes", () => {
  it("returns undefined for non-discovery paths", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
    });
    const result = await handler(makeRequest("/api/providers/bootstrap"));
    expect(result).toBeUndefined();
  });

  it("handles OPTIONS preflight", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
    });
    const result = await handler(
      makeRequest("/api/providers/discovery/scan", { method: "OPTIONS" }),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(204);
  });

  it("rejects non-loopback hostnames", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
    });
    const request = new Request("http://evil.example.com/api/providers/discovery/scan", {
      method: "POST",
      headers: { "x-octant-window-capability": "test" },
    });
    const result = await handler(request);
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  it("rejects non-POST methods for scan", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
    });
    const result = await handler(makeRequest("/api/providers/discovery/scan", { method: "GET" }));
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  it("returns scan results for valid scan request", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
    });
    const result = await handler(makeRequest("/api/providers/discovery/scan"));
    expect(result).toBeDefined();
    expect(result!.status).toBe(200);
    const body = await result!.json();
    expect(body.kind).toBe("scan-completed");
    expect(body.snapshot.candidates).toHaveLength(1);
    expect(body.snapshot.candidates[0].driverKind).toBe("codex");
  });

  it("auto-registers one first-run Codex CLI instance enabled per discovered family after scan", async () => {
    const listInstances = vi.fn(async () => []);
    const createFromDiscovery = vi.fn(async () => ({
      instanceId: decodeProviderInstanceId("00000000-0000-4000-8000-000000000902"),
    }));
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(duplicateFamilySnapshot),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
      listInstances,
      createFromDiscovery,
      readFirstRunOnboarding: () => "pending",
    });

    const result = await handler(makeRequest("/api/providers/discovery/scan"));

    expect(result).toBeDefined();
    expect(result!.status).toBe(200);
    const body = await result!.json();
    expect(body.snapshot.autoRegisteredInstanceIds).toEqual([
      "00000000-0000-4000-8000-000000000902",
    ]);
    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/usr/local/bin/codex" }),
      "test-window-id",
      { enabled: true },
    );
    expect(listInstances).toHaveBeenCalledWith("test-window-id");
  });

  it("auto-registers a detected Claude Code instance disabled after first run has been answered", async () => {
    const createFromDiscovery = vi.fn(async () => ({
      instanceId: decodeProviderInstanceId("00000000-0000-4000-8000-000000000903"),
    }));
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService({
        ...fakeSnapshot,
        candidates: [
          {
            ...fakeSnapshot.candidates[0]!,
            driverKind: "claude",
            displayName: "Claude Code",
            binaryPath: "/usr/local/bin/claude",
            pathSummary: "/usr/local/bin/claude",
          },
        ],
      }),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
      listInstances: async () => [],
      createFromDiscovery,
      readFirstRunOnboarding: () => "completed",
    });

    const result = await handler(makeRequest("/api/providers/discovery/scan"));

    expect(result).toBeDefined();
    expect(result!.status).toBe(200);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "claude" }),
      "test-window-id",
      { enabled: false },
    );
  });

  it("rejects connect without onConnect handler", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
    });
    const result = await handler(
      makeRequest("/api/providers/discovery/connect", {
        body: {
          kind: "connect",
          driverKind: "codex",
          binaryPath: "/usr/local/bin/codex",
          displayName: "Codex CLI",
        },
      }),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(503);
  });

  it("handles connect with onConnect handler", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
      onConnect: async () => ({ instanceId: "00000000-0000-4000-8000-000000000901" }),
    });
    const result = await handler(
      makeRequest("/api/providers/discovery/connect", {
        body: {
          kind: "connect",
          driverKind: "codex",
          binaryPath: "/usr/local/bin/codex",
          displayName: "Codex CLI",
        },
      }),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(200);
    const body = await result!.json();
    expect(body.kind).toBe("candidate-connected");
    expect(body.instanceId).toBe("00000000-0000-4000-8000-000000000901");
  });

  it("rejects invalid connect command body", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
      onConnect: async () => ({ instanceId: "00000000-0000-4000-8000-000000000901" }),
    });
    const result = await handler(
      makeRequest("/api/providers/discovery/connect", {
        body: { kind: "scan" },
      }),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  it("rejects query strings", async () => {
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
    });
    const request = new Request("http://127.0.0.1:3000/api/providers/discovery/scan?foo=bar", {
      method: "POST",
      headers: { "x-octant-window-capability": "test" },
    });
    const result = await handler(request);
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });
});

it("rejects connect for unknown candidates", async () => {
  const handler = createDiscoveryRouteHandler({
    discoveryService: makeFakeDiscoveryService(),
    windowAuthorityStore: makeFakeWindowAuthorityStore(),
    onConnect: async () => ({ instanceId: "00000000-0000-4000-8000-000000000901" }),
  });
  const result = await handler(
    makeRequest("/api/providers/discovery/connect", {
      body: {
        kind: "connect",
        driverKind: "codex",
        binaryPath: "/tmp/not-from-scan/codex",
        displayName: "Codex CLI",
      },
    }),
  );
  expect(result).toBeDefined();
  expect(result!.status).toBe(400);
  const body = await result!.json();
  expect(body.category).toBe("unknown-candidate");
});

describe("locate binary", () => {
  const desktopSecret = "desktop-bridge-secret";
  const windowId = "44000000-0000-4000-8000-000000000001";
  const instanceId = decodeProviderInstanceId("7d444840-9dc0-11d1-b245-5ffdce74fad2");
  // The version probe runs the stub for real; only the Seatbelt wrapper is
  // left out, because the live builder refuses on a host without sandbox-exec.
  const passthroughConfinement: SeatbeltConfinementPort = {
    prepare: (input) => ({ command: input.executable, args: input.args }),
  };
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "octant-locate-binary-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function stub(name: string, script: string, mode = 0o755): string {
    const path = join(directory, name);
    writeFileSync(path, script);
    chmodSync(path, mode);
    return path;
  }

  function codexInstance(binaryPath: string): ProviderInstance {
    return {
      id: instanceId,
      displayName: "Codex",
      enabled: false,
      environmentPolicy: "inherit-host",
      version: 3,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath },
    } as ProviderInstance;
  }

  function setup(instance: ProviderInstance = codexInstance("/opt/homebrew/bin/codex")) {
    const applied: Array<{ windowId: string; command: ProviderRegistryCommand }> = [];
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeDiscoveryService({
        versionProbeConfinement: passthroughConfinement,
        environment: { PATH: "/usr/bin:/bin", HOME: directory },
      }),
      // Each capability authenticates as its own window.
      windowAuthorityStore: {
        authenticate: (capability: string) =>
          capability === "other-window-capability" ? "other-window-id" : windowId,
      } as unknown as WindowAuthorityStore,
      desktopBridgeSecret: desktopSecret,
      binaryReceipts: new LocalPluginImportReceiptStore(),
      readInstance: (id) => (String(id) === String(instance.id) ? instance : undefined),
      applyProviderCommand: async (appliedWindowId, command) => {
        applied.push({ windowId: appliedWindowId, command });
        return {};
      },
    });

    async function pick(absolutePath: string): Promise<string> {
      const response = await handler(
        new Request("http://127.0.0.1:3000/api/providers/discovery/binary-receipts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-desktop-secret": desktopSecret },
          body: JSON.stringify({ windowId, absolutePath }),
        }),
      );
      expect(response?.status).toBe(201);
      return ((await response!.json()) as { receiptId: string }).receiptId;
    }

    async function locate(body: unknown, capability = "window-capability") {
      const response = await handler(
        new Request("http://127.0.0.1:3000/api/providers/discovery/locate-binary", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
            origin: "http://127.0.0.1:5173",
          },
          body: JSON.stringify(body),
        }),
      );
      return {
        status: response!.status,
        body: (await response!.json()) as Record<string, unknown>,
      };
    }

    return { handler, applied, pick, locate };
  }

  it("points the runtime at a picked executable that answers the version probe", async () => {
    const binary = stub("codex", '#!/bin/sh\necho "codex-cli 0.48.0"\n');
    const { pick, locate, applied } = setup();

    const result = await locate({
      kind: "locate-binary",
      instanceId,
      receiptId: await pick(binary),
    });

    expect(result).toEqual({
      status: 200,
      body: { kind: "binary-located", instanceId, version: "codex-cli 0.48.0" },
    });
    expect(applied).toEqual([
      {
        windowId,
        command: {
          kind: "change-provider-binary",
          instanceId,
          expectedVersion: 3,
          binaryPath: binary,
        },
      },
    ]);
  });

  it("keeps an ACP runtime's authentication when it moves the binary", async () => {
    const binary = stub("gemini", '#!/bin/sh\necho "0.10.0"\n');
    const gemini = {
      ...codexInstance("/opt/homebrew/bin/gemini"),
      driverKind: "gemini",
      configuration: {
        kind: "gemini-acp",
        binaryPath: "/opt/homebrew/bin/gemini",
        authentication: "api-key",
      },
    } as ProviderInstance;
    const { pick, locate, applied } = setup(gemini);

    const result = await locate({
      kind: "locate-binary",
      instanceId,
      receiptId: await pick(binary),
    });

    expect(result.status).toBe(200);
    expect(applied[0]?.command).toEqual({
      kind: "change-gemini-configuration",
      instanceId,
      expectedVersion: 3,
      configuration: { kind: "gemini-acp", binaryPath: binary, authentication: "api-key" },
    });
  });

  it("refuses a picked file that is not executable", async () => {
    const notes = stub("codex", '#!/bin/sh\necho "codex-cli 0.48.0"\n', 0o644);
    const { pick, locate, applied } = setup();

    const result = await locate({
      kind: "locate-binary",
      instanceId,
      receiptId: await pick(notes),
    });

    expect(result).toEqual({
      status: 400,
      body: {
        category: "invalid-configuration",
        message: "The chosen file is not an executable program.",
      },
    });
    expect(applied).toEqual([]);
  });

  it("refuses the wrong program, whose version probe fails", async () => {
    const failing = stub("not-codex", "#!/bin/sh\necho 'unknown option' >&2\nexit 2\n");
    const echoing = stub("echoes", '#!/bin/sh\necho "$@"\n');
    const { pick, locate, applied } = setup();

    for (const binary of [failing, echoing]) {
      const result = await locate({
        kind: "locate-binary",
        instanceId,
        receiptId: await pick(binary),
      });
      expect(result).toEqual({
        status: 400,
        body: {
          category: "invalid-configuration",
          message: "The chosen file did not answer Codex CLI's version check.",
        },
      });
    }
    expect(applied).toEqual([]);
  });

  it("refuses any path the picker did not return to this window", async () => {
    const binary = stub("codex", '#!/bin/sh\necho "codex-cli 0.48.0"\n');
    const { handler, pick, locate, applied } = setup();

    // The renderer cannot name a path: the command has no field for one.
    const named = await locate({ kind: "locate-binary", instanceId, binaryPath: binary });
    expect(named.status).toBe(400);
    // A receipt the picker never issued.
    const forged = await locate({ kind: "locate-binary", instanceId, receiptId: "A".repeat(43) });
    expect(forged.status).toBe(401);
    // A receipt issued to another window.
    const elsewhere = await locate(
      { kind: "locate-binary", instanceId, receiptId: await pick(binary) },
      "other-window-capability",
    );
    expect(elsewhere.status).toBe(401);
    // A receipt already used once.
    const receiptId = await pick(binary);
    expect((await locate({ kind: "locate-binary", instanceId, receiptId })).status).toBe(200);
    expect((await locate({ kind: "locate-binary", instanceId, receiptId })).status).toBe(401);
    // A renderer cannot mint its own receipt: issuing one needs the desktop secret.
    const minted = await handler(
      new Request("http://127.0.0.1:3000/api/providers/discovery/binary-receipts", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ windowId, absolutePath: binary }),
      }),
    );
    expect(minted?.status).toBe(401);
    expect(applied).toHaveLength(1);
  });

  it("offers Locate binary only for runtimes whose version probe the host can run", () => {
    for (const descriptor of DISCOVERY_DESCRIPTORS) {
      if (!canLocateRuntimeBinary(descriptor.driverKind)) continue;
      expect(descriptor.isDirectEndpoint, descriptor.driverKind).toBe(false);
      expect(descriptor.versionProbeArgs.length, descriptor.driverKind).toBeGreaterThan(0);
    }
    expect(canLocateRuntimeBinary("glm")).toBe(false);
  });
});
