import type { BrowserAutomationSnapshot, ToolActionAuthority, WindowId } from "@octant/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserAutomationRouteHandler } from "./browserAutomationRoutes";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const threadId = "20000000-0000-4000-8000-000000000001";
const contextId = "25000000-0000-4000-8000-000000000001";
const authority: ToolActionAuthority = {
  hostId: "30000000-0000-4000-8000-000000000001" as any,
  mode: "work",
  projectId: "40000000-0000-4000-8000-000000000001" as any,
  rootId: "50000000-0000-4000-8000-000000000001" as any,
  providerInstanceId: "60000000-0000-4000-8000-000000000001" as any,
  extension: { kind: "core" },
};
const snapshot: BrowserAutomationSnapshot = {
  status: "running",
  threadId: threadId as any,
  evidence: [],
};

function body() {
  return {
    threadId,
    action: {
      actionId: "70000000-0000-4000-8000-000000000001",
      correlationId: "80000000-0000-4000-8000-000000000001",
      capability: { id: "browser-automation", version: 1 },
      authority,
      intent: "Open an isolated browser context.",
      approval: { kind: "not-required" },
    },
    policy: {
      profileMode: "isolated",
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 1,
      sessionTimeoutMs: 300_000,
    },
  };
}

describe("browser automation routes", () => {
  let store: WindowAuthorityStore;
  let service: {
    create: ReturnType<typeof vi.fn>;
    act: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    inspectThread: ReturnType<typeof vi.fn>;
    releaseThread: ReturnType<typeof vi.fn>;
  };
  let handler: ReturnType<typeof createBrowserAutomationRouteHandler>;

  beforeEach(() => {
    store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: Date.now() });
    service = {
      create: vi.fn(async () => snapshot),
      act: vi.fn(async () => snapshot),
      cancel: vi.fn(async () => snapshot),
      stop: vi.fn(async () => snapshot),
      inspect: vi.fn(() => snapshot),
      inspectThread: vi.fn(() => snapshot),
      releaseThread: vi.fn(async () => ({ status: "ready", threadId, evidence: [] })),
    };
    handler = createBrowserAutomationRouteHandler({
      service: service as any,
      authority: { resolve: () => authority },
      windowAuthorityStore: store,
      maxRequestBodySize: 64_000,
    });
  });

  it("rejects an unauthenticated browser scope request", async () => {
    const response = await handler(
      new Request("http://127.0.0.1/api/browser/scope", {
        method: "POST",
        body: JSON.stringify({ threadId, mode: "work" }),
      }),
    );
    expect(response?.status).toBe(401);
  });

  it("returns only the server-resolved authority for an authenticated thread", async () => {
    const response = await handler(
      new Request("http://127.0.0.1/api/browser/scope", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ threadId, mode: "work" }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ threadId, authority });
  });

  it("dispatches a strict create command under the authenticated window", async () => {
    const response = await handler(
      new Request("http://127.0.0.1/api/browser/contexts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(body()),
      }),
    );
    expect(response?.status).toBe(200);
    expect(service.create).toHaveBeenCalledWith({ windowId, ...body() });
    expect(await response?.json()).toEqual(snapshot);
  });

  it("dispatches inspect and stop with the authenticated window and owning thread", async () => {
    for (const [path, method] of [
      ["inspect", service.inspect],
      ["stop", service.stop],
    ] as const) {
      const response = await handler(
        new Request(`http://127.0.0.1/api/browser/contexts/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({ contextId, threadId }),
        }),
      );
      expect(response?.status).toBe(200);
      expect(method).toHaveBeenCalledWith(windowId, threadId, contextId);
    }
  });

  it("dispatches thread-scoped reconnect and release under the authenticated window", async () => {
    for (const [path, method] of [
      ["current", service.inspectThread],
      ["release", service.releaseThread],
    ] as const) {
      const response = await handler(
        new Request(`http://127.0.0.1/api/browser/contexts/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({ threadId }),
        }),
      );
      expect(response?.status).toBe(200);
      expect(method).toHaveBeenCalledWith(windowId, threadId);
    }
  });

  it("rejects malformed commands without invoking the runtime", async () => {
    const response = await handler(
      new Request("http://127.0.0.1/api/browser/contexts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ threadId }),
      }),
    );
    expect(response?.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("lets a paired device act inside the page but never drive the host's browser", async () => {
    function pairedRequest(kind: string): Request {
      const request = new Request("http://127.0.0.1/api/browser/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          actionId: "70000000-0000-4000-8000-000000000001",
          contextId,
          correlationId: "80000000-0000-4000-8000-000000000001",
          authority,
          kind,
          ...(kind === "click" ? { point: { x: 0.5, y: 0.5 } } : {}),
          ...(kind === "navigate" ? { target: "https://example.com/" } : {}),
          ...(kind === "type" ? { target: "#field", value: "text" } : {}),
        }),
      });
      bindPrincipalRouteContext(request, {
        principal: createRemoteDevicePrincipal({
          hostId: "local" as never,
          deviceId: "90000000-0000-4000-8000-000000000001" as never,
          credentialGeneration: 1,
          origin: "https://octant.example",
          protocolVersion: 1,
          capabilityDigest: "a".repeat(64),
          sessionId: "a1000000-0000-4000-8000-000000000001" as never,
        }),
        scopeId: windowId,
      });
      return request;
    }

    expect((await handler(pairedRequest("click")))?.status).toBe(200);
    expect(service.act).toHaveBeenCalledOnce();

    for (const kind of ["navigate", "type", "close-tab"]) {
      const response = await handler(pairedRequest(kind));
      expect(response?.status).toBe(403);
    }
    expect(service.act).toHaveBeenCalledOnce();
  });
});
