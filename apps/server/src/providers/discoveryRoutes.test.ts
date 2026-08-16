import { decodeProviderInstanceId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDiscoveryRouteHandler, type DiscoveryRouteDependencies } from "./discoveryRoutes";
import type { DiscoveryService } from "./discoveryService";
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

  it("auto-registers one disabled provider per discovered family after scan", async () => {
    const listInstances = vi.fn(async () => []);
    const createDisabled = vi.fn(async () => ({
      instanceId: decodeProviderInstanceId("00000000-0000-4000-8000-000000000902"),
    }));
    const handler = createDiscoveryRouteHandler({
      discoveryService: makeFakeDiscoveryService(duplicateFamilySnapshot),
      windowAuthorityStore: makeFakeWindowAuthorityStore(),
      listInstances,
      createDisabled,
    });

    const result = await handler(makeRequest("/api/providers/discovery/scan"));

    expect(result).toBeDefined();
    expect(result!.status).toBe(200);
    const body = await result!.json();
    expect(body.snapshot.autoRegisteredInstanceIds).toEqual([
      "00000000-0000-4000-8000-000000000902",
    ]);
    expect(createDisabled).toHaveBeenCalledTimes(1);
    expect(createDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/usr/local/bin/codex" }),
      "test-window-id",
    );
    expect(listInstances).toHaveBeenCalledWith("test-window-id");
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
