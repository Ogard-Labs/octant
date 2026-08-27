import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationRouteHandler } from "./integrationRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const store = { authenticate: vi.fn() };
const service = {
  snapshot: vi.fn(async () => ({ state: "unauthorized", capabilities: [] })),
  execute: vi.fn(),
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

  it("completes a loopback OAuth callback without echoing the code in later API responses", async () => {
    const handler = createHandler();
    const value = new Request(
      "http://127.0.0.1/oauth/integrations/linear/callback?code=secret-code&state=csrf-state",
    );
    const response = await handler(value);
    expect(response?.status).toBe(200);
    expect(service.completeAuthorization).toHaveBeenCalledWith("linear", {
      code: "secret-code",
      state: "csrf-state",
    });
    const text = (await response?.text()) ?? "";
    expect(text).toContain("Linear is connected");
    expect(text).not.toContain("secret-code");
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
});
