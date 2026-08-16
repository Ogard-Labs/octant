import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubCloneRouteHandler } from "./githubCloneRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const store = {
  authenticate: vi.fn(() => {
    throw new Error("unauthorized");
  }),
} as never;
const service = {
  execute: vi.fn(async () => ({ kind: "refused", reason: "not-found" }) as const),
  list: vi.fn(() => ({ operations: [] })),
};

const requestCommand = {
  kind: "request-clone",
  requestId: "11111111-2222-4333-8444-555555555555",
  nodeId: "R_kgDOAbc123",
  expectedOwner: "octant",
  expectedName: "octant",
};

function createHandler() {
  return createGithubCloneRouteHandler({ service, windowAuthorityStore: store });
}

function commandRequest(body: unknown, url = "http://127.0.0.1/api/github/clone/commands") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify(body),
  });
}

function operationsRequest(method = "GET") {
  return new Request("http://127.0.0.1/api/github/clone/operations", {
    method,
    headers: { origin: "http://127.0.0.1" },
  });
}

function bindLocalWindow(value: Request) {
  bindPrincipalRouteContext(value, {
    principal: { kind: "local-window", windowId: "window", capabilityGeneration: 1 },
    scopeId: "window" as never,
  });
}

describe("GitHub clone routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches a validated clone command with the authenticated window scope", async () => {
    const handler = createHandler();
    const value = commandRequest(requestCommand);
    bindLocalWindow(value);
    const response = await handler(value);
    expect(response?.status).toBe(200);
    expect(service.execute).toHaveBeenCalledOnce();
    const [command, context] = service.execute.mock.calls[0] as unknown as [
      unknown,
      { windowId: string },
    ];
    expect(command).toEqual(requestCommand);
    expect(context.windowId).toBe("window");
  });

  it("rejects malformed commands before any service effect", async () => {
    const handler = createHandler();
    const hostile = commandRequest({
      kind: "confirm-clone",
      requestId: "11111111-2222-4333-8444-555555555555",
      nodeId: "R_kgDOAbc123",
      confirmation: "yes",
      destinationDigest: "a".repeat(64),
    });
    bindLocalWindow(hostile);
    expect((await handler(hostile))?.status).toBe(400);
    const traversal = commandRequest({
      ...requestCommand,
      expectedName: "../escape",
    });
    bindLocalWindow(traversal);
    expect((await handler(traversal))?.status).toBe(400);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("requires an authenticated user principal", async () => {
    const handler = createHandler();
    const unauthenticated = commandRequest(requestCommand);
    expect((await handler(unauthenticated))?.status).toBe(401);
    const agent = commandRequest(requestCommand);
    bindPrincipalRouteContext(agent, {
      principal: { kind: "provider" } as never,
      scopeId: "scope" as never,
    });
    expect((await handler(agent))?.status).toBe(403);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("rejects non-loopback hosts, foreign origins, query strings, and wrong methods", async () => {
    const handler = createHandler();
    const remote = new Request("http://example.com/api/github/clone/commands", {
      method: "POST",
      headers: { origin: "http://example.com" },
      body: "{}",
    });
    expect((await handler(remote))?.status).toBe(400);
    const query = commandRequest(requestCommand, "http://127.0.0.1/api/github/clone/commands?x=1");
    bindLocalWindow(query);
    expect((await handler(query))?.status).toBe(400);
    const wrongMethod = operationsRequest("POST");
    bindLocalWindow(wrongMethod);
    expect((await handler(wrongMethod))?.status).toBe(400);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("lists operations for the authenticated window", async () => {
    const handler = createHandler();
    const value = operationsRequest();
    bindLocalWindow(value);
    const response = await handler(value);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ operations: [] });
    expect(service.list).toHaveBeenCalledOnce();
  });

  it("ignores unrelated routes and answers preflight", async () => {
    const handler = createHandler();
    expect(await handler(new Request("http://127.0.0.1/api/other"))).toBeUndefined();
    const preflight = new Request("http://127.0.0.1/api/github/clone/commands", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1" },
    });
    expect((await handler(preflight))?.status).toBe(204);
  });

  it("maps service throws to an unavailable failure without details", async () => {
    service.execute.mockRejectedValueOnce(new Error("boom ghp_0123456789abcdefghij"));
    const handler = createHandler();
    const value = commandRequest(requestCommand);
    bindLocalWindow(value);
    const response = await handler(value);
    expect(response?.status).toBe(503);
    expect(JSON.stringify(await response?.json())).not.toContain("ghp_");
  });
});
