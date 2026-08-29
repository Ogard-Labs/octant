import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubRouteHandler } from "./githubRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const store = { authenticate: vi.fn() } as any;
const service = {
  snapshot: vi.fn(async () => ({ state: "unauthorized", capabilities: [] })),
  execute: vi.fn(),
} as any;
const catalogue = {
  read: vi.fn(async () => ({
    kind: "recent-repositories",
    rows: [],
  })),
  recordRecentRepository: vi.fn(async () => ({
    kind: "recent-repositories",
    rows: [],
  })),
} as any;
function request(path = "/api/github/authentication", method = "GET") {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { origin: "http://127.0.0.1" },
  });
}
function createHandler() {
  return createGithubRouteHandler({ service, catalogue, windowAuthorityStore: store });
}
function jsonRequest(path: string, body: unknown) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify(body),
  });
}
function bindLocalWindow(value: Request) {
  bindPrincipalRouteContext(value, {
    principal: { kind: "local-window", windowId: "window", capabilityGeneration: 1 },
    scopeId: "window" as any,
  });
}

describe("GitHub authentication routes", () => {
  beforeEach(() => vi.clearAllMocks());
  it("falls through when the GitHub integration is not effective", async () => {
    const handler = createGithubRouteHandler({
      service,
      catalogue,
      windowAuthorityStore: store,
      isEffective: () => false,
    });
    const value = request();
    bindPrincipalRouteContext(value, {
      principal: { kind: "local-window", windowId: "window", capabilityGeneration: 1 },
      scopeId: "window" as any,
    });
    expect(await handler(value)).toBeUndefined();
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it("returns a normalized snapshot to the authenticated local window", async () => {
    const handler = createHandler();
    const value = request();
    bindPrincipalRouteContext(value, {
      principal: { kind: "local-window", windowId: "window", capabilityGeneration: 1 },
      scopeId: "window" as any,
    });
    expect((await handler(value))?.status).toBe(200);
    expect(service.snapshot).toHaveBeenCalledOnce();
  });
  it("allows an authenticated paired user to read owning-host account capability state", async () => {
    const handler = createHandler();
    const value = request();
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
      } as any,
      scopeId: "scope" as any,
    });
    expect((await handler(value))?.status).toBe(200);
    expect(service.snapshot).toHaveBeenCalledOnce();
  });

  it("honors the advertised HEAD authentication snapshot route", async () => {
    const handler = createHandler();
    const value = request("/api/github/authentication", "HEAD");
    bindPrincipalRouteContext(value, {
      principal: { kind: "local-window", windowId: "window", capabilityGeneration: 1 },
      scopeId: "window" as any,
    });

    const response = await handler(value);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-methods")).toContain("HEAD");
    expect(service.snapshot).toHaveBeenCalledOnce();
  });

  it("returns invalid rather than unavailable for malformed authentication commands", async () => {
    const handler = createHandler();
    const value = new Request("http://127.0.0.1/api/github/authentication/commands", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ kind: "setup", confirmation: "no" }),
    });
    bindPrincipalRouteContext(value, {
      principal: { kind: "local-window", windowId: "window", capabilityGeneration: 1 },
      scopeId: "window" as any,
    });

    expect((await handler(value))?.status).toBe(400);
    expect(service.execute).not.toHaveBeenCalled();
  });
});

describe("GitHub catalogue routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches a validated catalogue read for the authenticated local window", async () => {
    const handler = createHandler();
    const value = jsonRequest("/api/github/catalogue/reads", {
      kind: "repositories",
      pageSize: 30,
      search: "atlas",
    });
    bindLocalWindow(value);

    const response = await handler(value);

    expect(response?.status).toBe(200);
    expect(catalogue.read).toHaveBeenCalledWith(
      { kind: "repositories", pageSize: 30, search: "atlas" },
      expect.any(AbortSignal),
    );
  });

  it("allows an authenticated paired device to read the owning host's catalogue", async () => {
    const handler = createHandler();
    const value = jsonRequest("/api/github/catalogue/reads", {
      kind: "issues",
      owner: "octant",
      name: "octant",
      pageSize: 10,
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
      } as any,
      scopeId: "scope" as any,
    });

    expect((await handler(value))?.status).toBe(200);
    expect(catalogue.read).toHaveBeenCalledOnce();
  });

  it("rejects non-user principals before any GitHub read", async () => {
    const handler = createHandler();
    const value = jsonRequest("/api/github/catalogue/reads", {
      kind: "repositories",
      pageSize: 30,
    });
    bindPrincipalRouteContext(value, {
      principal: { kind: "provider", providerInstanceId: "provider" } as any,
      scopeId: "scope" as any,
    });

    expect((await handler(value))?.status).toBe(403);
    expect(catalogue.read).not.toHaveBeenCalled();
  });

  it("rejects raw endpoint or field selection as invalid before the service", async () => {
    const handler = createHandler();
    for (const body of [
      { kind: "repositories", pageSize: 30, endpoint: "/user/repos" },
      { kind: "issues", owner: "octant", name: "octant", pageSize: 10, fields: ["x"] },
      { kind: "mutate" },
      "text",
    ]) {
      const value = jsonRequest("/api/github/catalogue/reads", body);
      bindLocalWindow(value);
      expect((await handler(value))?.status).toBe(400);
    }
    expect(catalogue.read).not.toHaveBeenCalled();
  });

  it("only accepts POST for catalogue reads", async () => {
    const handler = createHandler();
    const value = request("/api/github/catalogue/reads", "GET");
    bindLocalWindow(value);
    expect((await handler(value))?.status).toBe(400);
    expect(catalogue.read).not.toHaveBeenCalled();
  });

  it("records an explicit recent selection through the strict command", async () => {
    const handler = createHandler();
    const value = jsonRequest("/api/github/catalogue/recents", {
      kind: "record-recent-repository",
      nodeId: "R_kgDOG8x1Aa",
    });
    bindLocalWindow(value);

    expect((await handler(value))?.status).toBe(200);
    expect(catalogue.recordRecentRepository).toHaveBeenCalledWith(
      { kind: "record-recent-repository", nodeId: "R_kgDOG8x1Aa" },
      expect.any(AbortSignal),
    );
  });

  it("rejects recents commands with extra fields", async () => {
    const handler = createHandler();
    const value = jsonRequest("/api/github/catalogue/recents", {
      kind: "record-recent-repository",
      nodeId: "R_kgDOG8x1Aa",
      cloneUrl: "https://github.com/x/y.git",
    });
    bindLocalWindow(value);

    expect((await handler(value))?.status).toBe(400);
    expect(catalogue.recordRecentRepository).not.toHaveBeenCalled();
  });

  it("returns unavailable when the catalogue service itself fails", async () => {
    catalogue.read.mockRejectedValueOnce(new Error("boom"));
    const handler = createHandler();
    const value = jsonRequest("/api/github/catalogue/reads", {
      kind: "repositories",
      pageSize: 30,
    });
    bindLocalWindow(value);

    expect((await handler(value))?.status).toBe(503);
  });
});
