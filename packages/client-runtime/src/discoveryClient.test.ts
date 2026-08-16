import { describe, expect, it, vi } from "vitest";
import { createDiscoveryClient, DiscoveryClientFailure } from "./discoveryClient";

const scanResponse = {
  kind: "scan-completed",
  snapshot: {
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
  },
};

const connectResponse = {
  kind: "candidate-connected",
  instanceId: "00000000-0000-4000-8000-000000000901",
};

function makeFakeFetch(response: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof globalThis.fetch;
}

describe("discoveryClient", () => {
  it("scans and returns a discovery snapshot", async () => {
    const client = createDiscoveryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: makeFakeFetch(scanResponse),
      windowCapability: "test-cap",
    });
    const snapshot = await client.scan();
    expect(snapshot.hostId).toBe("local");
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]!.driverKind).toBe("codex");
  });

  it("connects a candidate and returns the instance ID", async () => {
    const client = createDiscoveryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: makeFakeFetch(connectResponse),
      windowCapability: "test-cap",
    });
    const result = await client.connect({
      kind: "connect",
      driverKind: "codex",
      binaryPath: "/usr/local/bin/codex",
      displayName: "Codex CLI",
    });
    expect(result.kind).toBe("candidate-connected");
  });

  it("throws DiscoveryClientFailure on network error", async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof globalThis.fetch;
    const client = createDiscoveryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: failingFetch,
      windowCapability: "test-cap",
    });
    await expect(client.scan()).rejects.toThrow(DiscoveryClientFailure);
    await expect(client.scan()).rejects.toThrow("Discovery service is unavailable.");
  });

  it("throws DiscoveryClientFailure on non-ok response", async () => {
    const client = createDiscoveryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: makeFakeFetch({ category: "unauthorized", message: "Not authorized." }, 401),
      windowCapability: "test-cap",
    });
    await expect(client.scan()).rejects.toThrow(DiscoveryClientFailure);
    try {
      await client.scan();
    } catch (error) {
      expect((error as DiscoveryClientFailure).category).toBe("unauthorized");
    }
  });

  it("throws DiscoveryClientFailure on invalid JSON response", async () => {
    const badFetch = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = createDiscoveryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: badFetch,
      windowCapability: "test-cap",
    });
    await expect(client.scan()).rejects.toThrow(DiscoveryClientFailure);
  });

  it("sends the window capability header", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify(scanResponse), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const client = createDiscoveryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: fetchSpy,
      windowCapability: "my-capability",
    });
    await client.scan();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-octant-window-capability": "my-capability",
        }),
      }),
    );
  });
});
