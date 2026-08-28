import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationRouteHandler } from "./integrationRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const store = { authenticate: vi.fn() };
const service = {
  snapshot: vi.fn(async () => ({ state: "unauthorized", capabilities: [] })),
  execute: vi.fn(),
  executeOperation: vi.fn(async () => ({
    kind: "ok" as const,
    value: { rows: [], hasNextPage: false },
  })),
  completeAuthorization: vi.fn(async () => ({ kind: "stored" as const })),
  putSecret: vi.fn(async () => ({ kind: "stored" as const })),
  deleteSecret: vi.fn(async () => undefined),
};

function request(path = "/api/integrations/linear/authentication", method = "GET") {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { origin: "http://127.0.0.1" },
  });
}

function createHandler() {
  return createIntegrationRouteHandler({
    service: service as never,
    windowAuthorityStore: store as never,
  });
}

function bindLocalWindow(value: Request) {
  bindPrincipalRouteContext(value, {
    principal: { kind: "local-window", windowId: "window", capabilityGeneration: 1 },
    scopeId: "window" as never,
  });
}

describe("integration authentication routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a snapshot to the authenticated local window", async () => {
    const handler = createHandler();
    const value = request();
    bindLocalWindow(value);
    expect((await handler(value))?.status).toBe(200);
    expect(service.snapshot).toHaveBeenCalledWith("linear", expect.anything());
  });

  it("refuses authentication commands from a remote device", async () => {
    const handler = createHandler();
    const value = new Request("http://127.0.0.1/api/integrations/linear/authentication/commands", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ kind: "setup" }),
    });
    bindPrincipalRouteContext(value, {
      principal: {
        kind: "remote-device",
        hostId: "host",
        deviceId: "device",
        credentialGeneration: 1,
        origin: "https://remote.test",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: "session",
      } as never,
      scopeId: "scope" as never,
    });
    expect((await handler(value))?.status).toBe(403);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("stores a personal API key without returning it", async () => {
    const handler = createHandler();
    const value = new Request("http://127.0.0.1/api/integrations/linear/secrets", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({
        kind: "put",
        scope: "personal-api-key",
        credential: "lin_api_abcdefghijklmnop1234",
      }),
    });
    bindLocalWindow(value);
    const response = await handler(value);
    expect(response?.status).toBe(200);
    expect(service.putSecret).toHaveBeenCalledWith(
      "linear",
      "personal-api-key",
      "lin_api_abcdefghijklmnop1234",
    );
    expect(await response?.text()).not.toContain("lin_api_");
  });

  it("routes a read-only issue operation without returning token material", async () => {
    const handler = createHandler();
    const value = new Request("http://127.0.0.1/api/integrations/linear/operations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({
        kind: "operation",
        operationId: "list-issues",
        input: { search: "browse" },
      }),
    });
    bindLocalWindow(value);
    const response = await handler(value);
    expect(response?.status).toBe(200);
    expect(service.executeOperation).toHaveBeenCalledWith(
      "linear",
      { kind: "operation", operationId: "list-issues", input: { search: "browse" } },
      expect.anything(),
    );
    expect(await response?.text()).not.toMatch(/lin_api_|access_token|refresh_token/);
  });

  it("allows a remote device to read issues and refuses authentication-shaped bodies", async () => {
    const handler = createHandler();
    const read = new Request("http://127.0.0.1/api/integrations/linear/operations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ kind: "operation", operationId: "list-issues", input: {} }),
    });
    bindPrincipalRouteContext(read, {
      principal: {
        kind: "remote-device",
        hostId: "host",
        deviceId: "device",
        credentialGeneration: 1,
        origin: "https://remote.test",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: "session",
      } as never,
      scopeId: "scope" as never,
    });
    expect((await handler(read))?.status).toBe(200);

    const invalid = new Request("http://127.0.0.1/api/integrations/linear/operations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ kind: "authenticate", command: { kind: "setup" } }),
    });
    bindLocalWindow(invalid);
    expect((await handler(invalid))?.status).toBe(400);
    expect(service.execute).not.toHaveBeenCalled();
  });
});
