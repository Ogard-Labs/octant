import { describe, expect, it, vi } from "vitest";
import { createHostControlClient, HostControlClientError } from "./hostControlClient";

const statusBody = {
  identity: { hostId: "host-1", instanceId: "instance-1", serviceMode: "service" },
  versions: { server: "1.2.3", wire: "9" },
  policy: { kind: "known", enabled: true, updatedAt: "2026-08-11T12:00:00.000Z" },
  readiness: {
    store: { state: "ready", integrity: "verified" },
    replay: { journalHead: 42, projections: 42 },
    clientsConnected: 2,
    uptimeSeconds: 3600,
  },
  capabilities: ["platform:systemd-user-units"],
  work: { active: 1, attentionRequired: false },
  lifecycle: {
    stop: { kind: "available" },
    restart: { kind: "available" },
    enable: { kind: "available" },
    disable: { kind: "available" },
  },
};

const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";

function fetchReturning(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("createHostControlClient", () => {
  it("fetches status with the window capability header and decodes the report", async () => {
    const fetchImpl = fetchReturning(200, statusBody);
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    const status = await client.status();

    expect(status.identity.hostId).toBe("host-1");
    expect(status.policy.kind).toBe("known");
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4100/api/host-control/status");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(capability);
  });

  it("fetches the data map with the window capability header and decodes the report", async () => {
    const dataMapBody = {
      host: {
        hostId: "host-1",
        displayName: "This computer",
        kind: "desktop",
        serviceMode: "desktop",
        journal: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
        },
        projections: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
        },
        artifacts: [],
        caches: [],
        credentials: { kind: "unknown" },
        outbound: [
          {
            kind: "known",
            category: "provider-calls",
            leavesMachine: true,
            purpose: "Requests you send to a configured provider leave this machine.",
          },
        ],
      },
      projects: { kind: "known", projects: [] },
      related: [
        { kind: "thread-retention", settings: { section: "data", setting: "thread-retention" } },
      ],
    };
    const fetchImpl = fetchReturning(200, dataMapBody);
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    const report = await client.readDataMap();

    expect(report.host.kind).toBe("desktop");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4100/api/host-control/data-map");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(capability);
  });

  it("posts a lifecycle action and decodes an accepted outcome", async () => {
    const fetchImpl = fetchReturning(200, {
      kind: "accepted",
      action: "restart",
      message: "The host is draining; the service manager will start it again.",
    });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    const outcome = await client.lifecycle("restart");

    expect(outcome.kind).toBe("accepted");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4100/api/host-control/lifecycle");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ action: "restart" });
  });

  it("decodes a refused lifecycle outcome without throwing", async () => {
    const fetchImpl = fetchReturning(200, {
      kind: "refused",
      action: "restart",
      code: "restart-unavailable",
      guidance: "Run octant server restart from a terminal on this host.",
    });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    const outcome = await client.lifecycle("restart");
    expect(outcome.kind).toBe("refused");
  });

  it("posts a backup request with an optional label and decodes the receipt", async () => {
    const fetchImpl = fetchReturning(200, {
      kind: "created",
      label: "pre-upgrade",
      migrationVersion: 4,
      journalHead: 42,
      byteLength: 2048,
    });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    const outcome = await client.backup("pre-upgrade");

    expect(outcome.kind).toBe("created");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4100/api/host-control/backup");
    expect(JSON.parse(init.body as string)).toEqual({ label: "pre-upgrade" });
  });

  it("decodes a failed backup outcome from a service-unavailable response", async () => {
    const fetchImpl = fetchReturning(503, { kind: "failed", code: "backup-failed" });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    const outcome = await client.backup();
    expect(outcome).toEqual({ kind: "failed", code: "backup-failed" });
  });

  it("decodes the honest online-restore refusal", async () => {
    const fetchImpl = fetchReturning(200, {
      kind: "refused-online",
      guidance: "Stop the Octant host, then run the offline restore command with --confirm.",
    });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    const outcome = await client.restore();
    expect(outcome.kind).toBe("refused-online");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4100/api/host-control/restore");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("throws a client error for an unauthorized response instead of decoding it", async () => {
    const fetchImpl = fetchReturning(401, { error: "Host control is unauthorized." });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: "bad",
    });

    await expect(client.status()).rejects.toBeInstanceOf(HostControlClientError);
  });

  it("throws a client error when the host is still starting", async () => {
    const fetchImpl = fetchReturning(503, {
      error: "Host control is unavailable while the owner is starting.",
    });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    await expect(client.status()).rejects.toBeInstanceOf(HostControlClientError);
  });

  it("throws a client error when the transport itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    await expect(client.lifecycle("stop")).rejects.toBeInstanceOf(HostControlClientError);
  });

  it("throws a client error when the response body is not a valid contract", async () => {
    const fetchImpl = fetchReturning(200, { unexpected: true });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });

    await expect(client.status()).rejects.toBeInstanceOf(HostControlClientError);
  });

  it("refuses a host export the server will not cut", async () => {
    const fetchImpl = fetchReturning(403, { kind: "refused", reason: "local-owner-only" });
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });
    await expect(client.exportHost()).resolves.toEqual({
      kind: "refused",
      reason: "local-owner-only",
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(call?.[0]).toBe("http://127.0.0.1:4100/api/host-control/export");
    expect(call?.[1].method).toBe("GET");
  });

  it("returns the streamed payload when a host export assembles", async () => {
    const payload = [
      JSON.stringify({
        kind: "header",
        octant: {
          format: "octant.host-export/1",
          hostId: "local",
          generatedAt: "2026-08-19T12:00:00.000Z",
          threadCount: 0,
        },
      }),
      JSON.stringify({
        kind: "settings",
        settings: { chatEnabled: true, workEnabled: false, themeMode: "dark" },
      }),
      JSON.stringify({
        kind: "omissions",
        omissions: [
          {
            subject: "credentials",
            reason: "Secrets, tokens, and credential material are unrepresentable.",
          },
        ],
      }),
      JSON.stringify({ kind: "complete", threadCount: 0 }),
    ].join("\n");
    const fetchImpl = vi.fn(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });
    const result = await client.exportHost();
    expect(result).toEqual({
      kind: "exported",
      payload,
      bundle: {
        octant: {
          format: "octant.host-export/1",
          hostId: "local",
          generatedAt: "2026-08-19T12:00:00.000Z",
          threadCount: 0,
        },
        threads: [],
        projects: [],
        projectMemory: [],
        canvases: [],
        settings: { chatEnabled: true, workEnabled: false, themeMode: "dark" },
        usage: [],
        retention: { windows: [], tombstones: [] },
        omissions: [
          {
            subject: "credentials",
            reason: "Secrets, tokens, and credential material are unrepresentable.",
          },
        ],
      },
    });
  });

  it("does not attach a payload when assemble refuses the stream", async () => {
    const payload = JSON.stringify({
      kind: "header",
      octant: {
        format: "octant.host-export/1",
        hostId: "local",
        generatedAt: "2026-08-19T12:00:00.000Z",
        threadCount: 0,
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    const client = createHostControlClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: capability,
    });
    await expect(client.exportHost()).resolves.toEqual({
      kind: "refused",
      reason: "incomplete",
    });
  });
});
