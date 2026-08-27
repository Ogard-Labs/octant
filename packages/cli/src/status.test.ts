import { describe, expect, it, vi } from "vitest";
import { runStatusCommand, formatStatusReport } from "./status";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("runStatusCommand", () => {
  it("reports ready when the host is healthy", async () => {
    const fetch = mockFetch(async () =>
      jsonResponse({
        product: "Octant",
        status: "ok",
        storage: "ready",
        version: "0.0.0-dev",
        instanceId: "instance-1",
      }),
    );
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const report = await runStatusCommand({ fetch, stdout });
    expect(report.status).toBe("ready");
    expect(report.instanceId).toBe("instance-1");
    expect(report.secretStore).toBeDefined();
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Secret store:"));
  });

  it("reports disabled when storage is not ready", async () => {
    const fetch = mockFetch(async () =>
      jsonResponse({
        product: "Octant",
        status: "ok",
        storage: "starting",
        version: "0.0.0-dev",
        instanceId: "instance-2",
      }),
    );
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const report = await runStatusCommand({ fetch, stdout });
    expect(report.status).toBe("disabled");
    expect(report.secretStore).toBeDefined();
  });

  it("reports unreachable when the host cannot be contacted", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const report = await runStatusCommand({ fetch, stdout });
    expect(report.status).toBe("unreachable");
    expect(report.secretStore).toBeDefined();
  });

  it("omits local secret-store status when inspecting a remote host", async () => {
    const fetch = mockFetch(async () =>
      jsonResponse({
        product: "Octant",
        status: "ok",
        storage: "ready",
        version: "0.0.0-dev",
        instanceId: "remote-instance",
      }),
    );
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const report = await runStatusCommand({
      hostname: "station.example",
      fetch,
      stdout,
    });
    expect(report.secretStore).toBeUndefined();
    expect(stdout.write).toHaveBeenCalledWith(expect.not.stringContaining("Secret store:"));
  });
});

describe("formatStatusReport", () => {
  it("includes endpoint, instance, and version", () => {
    const text = formatStatusReport({
      status: "ready",
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
      secretStore: "available",
    });
    expect(text).toContain("Endpoint: http://127.0.0.1:13773");
    expect(text).toContain("Instance: instance-1");
    expect(text).toContain("Version: 0.0.0-dev");
    expect(text).toContain("Secret store: available");
  });
});
