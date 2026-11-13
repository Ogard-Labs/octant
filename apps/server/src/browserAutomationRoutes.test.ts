import { BrowserFlowRuns } from "./browser/browserFlowRuns";
import { decodeBrowserFlow, decodeBrowserThreadId } from "@octant/contracts";
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
    takeOver: ReturnType<typeof vi.fn>;
    handBack: ReturnType<typeof vi.fn>;
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
      takeOver: vi.fn(() => ({ ...snapshot, waitingForPerson: "take-over" })),
      handBack: vi.fn(() => snapshot),
    };
    handler = createBrowserAutomationRouteHandler({
      service: service as any,
      authority: { canAccessWindow: () => true, resolve: () => authority },
      windowAuthorityStore: store,
      maxRequestBodySize: 64_000,
    });
  });

  it("reads Browser admission only after the window can inspect its thread", async () => {
    const availability = vi.fn(() => ({
      status: "omitted" as const,
      reason: "no-tool-transport" as const,
    }));
    let admitted = true;
    const read = createBrowserAutomationRouteHandler({
      service: {
        create: async () => snapshot,
        act: async () => snapshot,
        cancel: async () => snapshot,
        stop: async () => snapshot,
        inspect: () => snapshot,
        inspectThread: () => snapshot,
        releaseThread: async () => snapshot,
      },
      agentAvailability: availability,
      authority: { canAccessWindow: () => admitted, resolve: () => authority },
      windowAuthorityStore: store,
      maxRequestBodySize: 64_000,
    });
    const request = () =>
      new Request("http://127.0.0.1/api/browser/contexts/current", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({ threadId }),
      });
    const response = await read(request());
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      agentAvailability: { status: "omitted", reason: "no-tool-transport" },
    });
    expect(availability).toHaveBeenCalledTimes(1);
    admitted = false;
    expect((await read(request()))?.status).toBe(403);
    expect(availability).toHaveBeenCalledTimes(1);
  });

  describe("task default profile transaction", () => {
    const choice = { threadId, mode: "work", expectedVersion: 1, profile: "personal" };
    const post = (path: string, value: unknown) =>
      new Request(`http://127.0.0.1/api/browser/${path}`, {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify(value),
      });
    function fixture() {
      let version = 1;
      let model = "model-a";
      let profile = "private" as "private" | "personal";
      const save = vi.fn(async (_windowId, _command, commit) => {
        commit(() => {
          version += 1;
          profile = "personal";
        });
        return { status: "saved" as const };
      });
      const bind = vi.fn();
      const switchTaskProfile = vi.fn(async (input) => {
        expect(input.isCurrent()).toBe(true);
        expect(input.profile).toEqual({ kind: "personal" });
        const saved = await input.save((persist: () => void) => {
          persist();
          return true;
        });
        if (saved.status === "refused") return saved;
        input.bind(contextId, authority);
        return { status: "changed", browser: snapshot };
      });
      const read = vi.fn(() => ({ version: version as never, modelId: model, profile }));
      const handler = createBrowserAutomationRouteHandler({
        service: { ...service, switchTaskProfile } as any,
        taskProfiles: { read, save, bind },
        authority: { canAccessWindow: () => true, resolve: () => authority },
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      return {
        handler,
        save,
        bind,
        read,
        switchTaskProfile,
        edit: () => {
          version += 1;
          model = "model-b";
        },
      };
    }
    it("reads only the task selection and saves through the shared switch boundary", async () => {
      const f = fixture();
      const current = await f.handler(post("task-profile/current", { threadId, mode: "work" }));
      expect(await current?.json()).toMatchObject({ threadId, version: 1, profile: "private" });
      const changed = await f.handler(post("task-profile", choice));
      expect(changed?.status).toBe(200);
      expect(await changed?.json()).toMatchObject({
        selection: { profile: "personal", version: 2 },
      });
      expect(f.save).toHaveBeenCalledOnce();
      expect(f.bind).toHaveBeenCalledWith(contextId, "model-a", authority);
    });
    it("detects a concurrent task/model edit while staging", async () => {
      const f = fixture();
      f.switchTaskProfile.mockImplementationOnce(async (input) => {
        f.edit();
        expect(input.isCurrent()).toBe(false);
        return {
          status: "refused",
          failure: { category: "stale", message: "Task changed." },
        } as any;
      });
      expect((await f.handler(post("task-profile", choice)))?.status).toBe(409);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
    });
    it("refuses stale versions and strict extra fields before creating any context", async () => {
      const f = fixture();
      expect(
        (await f.handler(post("task-profile", { ...choice, expectedVersion: 2 })))?.status,
      ).toBe(409);
      expect((await f.handler(post("task-profile", { ...choice, cookies: "never" })))?.status).toBe(
        400,
      );
      expect(f.switchTaskProfile).not.toHaveBeenCalled();
    });
    it("refuses paired devices before reading the stored selection", async () => {
      const f = fixture();
      const request = post("task-profile/current", { threadId, mode: "work" });
      bindPrincipalRouteContext(request, {
        principal: createRemoteDevicePrincipal({
          deviceId: "90000000-0000-4000-8000-000000000001" as never,
          hostId: "local" as never,
          credentialGeneration: 1,
          origin: "https://octant.example",
          protocolVersion: 1,
          capabilityDigest: "a".repeat(64),
          sessionId: "a1000000-0000-4000-8000-000000000001" as never,
        }),
        scopeId: windowId,
      } as any);
      expect((await f.handler(request))?.status).toBe(403);
      expect(f.read).not.toHaveBeenCalled();
    });
  });

  it("keeps login-permission commands local, authenticated and strictly decoded", async () => {
    const execute = vi.fn(async () => ({ kind: "browser-credential-grants" as const, grants: [] }));
    const login = createBrowserAutomationRouteHandler({
      service: {
        create: async () => snapshot,
        act: async () => snapshot,
        cancel: async () => snapshot,
        stop: async () => snapshot,
        inspect: () => snapshot,
        inspectThread: () => snapshot,
        releaseThread: async () => snapshot,
      },
      credentialUse: { execute },
      authority: { canAccessWindow: () => true, resolve: () => authority },
      windowAuthorityStore: store,
      maxRequestBodySize: 4096,
    });
    const payload = { kind: "list-browser-credential-grants", contextId, threadId, mode: "work" };
    const request = (host: string, authenticated = true, data: object = payload) =>
      new Request(`http://${host}/api/browser/credential-use`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { "x-octant-window-capability": capability } : {}),
        },
        body: JSON.stringify(data),
      });
    expect((await login(request("127.0.0.1", false)))?.status).toBe(401);
    expect((await login(request("outside.example")))?.status).toBe(403);
    const paired = request("127.0.0.1");
    bindPrincipalRouteContext(paired, {
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
    expect((await login(paired))?.status).toBe(403);
    expect(
      (await login(request("127.0.0.1", true, { ...payload, topOrigin: "https://forged.example" })))
        ?.status,
    ).toBe(400);
    expect(
      (
        await login(
          request("127.0.0.1", true, {
            kind: "confirm-browser-credential-fill",
            contextId,
            threadId,
            mode: "work",
            planId: contextId,
            password: "fixture-private",
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await login(
          request("127.0.0.1", true, {
            kind: "stage-browser-credential-fill",
            contextId,
            threadId,
            mode: "work",
            planId: contextId,
          }),
        )
      )?.status,
    ).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    const response = await login(request("127.0.0.1"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ kind: "browser-credential-grants", grants: [] });
    expect(execute).toHaveBeenCalledWith(windowId, payload, expect.any(AbortSignal));
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

  it("rejects a scope and context create from a window without that thread Project", async () => {
    const isolatedHandler = createBrowserAutomationRouteHandler({
      service: service as any,
      authority: { canAccessWindow: () => false, resolve: () => authority },
      windowAuthorityStore: store,
      maxRequestBodySize: 64_000,
    });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const scope = await isolatedHandler(
      new Request("http://127.0.0.1/api/browser/scope", {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId, mode: "work" }),
      }),
    );
    expect(scope?.status).toBe(403);

    const created = await isolatedHandler(
      new Request("http://127.0.0.1/api/browser/contexts", {
        method: "POST",
        headers,
        body: JSON.stringify(body()),
      }),
    );
    expect(created?.status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();

    const current = await isolatedHandler(
      new Request("http://127.0.0.1/api/browser/contexts/current", {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId }),
      }),
    );
    expect(current?.status).toBe(403);
    expect(service.inspectThread).not.toHaveBeenCalled();
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

  it("takes a fresh picture of the thread's page unless the read opts out of one", async () => {
    const peekThread = vi.fn(async () => snapshot);
    const peeking = createBrowserAutomationRouteHandler({
      service: { ...service, peekThread } as any,
      authority: { canAccessWindow: () => true, resolve: () => authority },
      windowAuthorityStore: store,
      maxRequestBodySize: 64_000,
    });
    const read = (payload: object) =>
      peeking(
        new Request("http://127.0.0.1/api/browser/contexts/current", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify(payload),
        }),
      );

    expect((await read({ threadId }))?.status).toBe(200);
    expect(peekThread).toHaveBeenCalledOnce();
    expect(service.inspectThread).not.toHaveBeenCalled();

    expect((await read({ threadId, freshPicture: false }))?.status).toBe(200);
    expect(peekThread).toHaveBeenCalledOnce();
    expect(service.inspectThread).toHaveBeenCalledOnce();
  });

  it("lists and decides a browser origin approval under the authenticated window", async () => {
    const approvals = {
      list: vi.fn(
        () =>
          [
            {
              approvalId: "90000000-0000-4000-8000-000000000001",
              threadId,
              mode: "chat",
              origin: "https://example.com",
              requestedAt: "2026-09-09T10:00:00.000Z",
            },
          ] as never,
      ),
      decide: vi.fn(() => true),
    };
    const approvalHandler = createBrowserAutomationRouteHandler({
      service: service as any,
      authority: { canAccessWindow: () => true, resolve: () => authority },
      approvals,
      windowAuthorityStore: store,
      maxRequestBodySize: 64_000,
    });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const listed = await approvalHandler(
      new Request("http://127.0.0.1/api/browser/approvals", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "list" }),
      }),
    );
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toHaveLength(1);
    const decided = await approvalHandler(
      new Request("http://127.0.0.1/api/browser/approvals", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "decide",
          approvalId: "90000000-0000-4000-8000-000000000001",
          decision: "approved",
        }),
      }),
    );
    expect(decided?.status).toBe(200);
    expect(approvals.decide).toHaveBeenCalledWith(windowId, {
      approvalId: "90000000-0000-4000-8000-000000000001",
      decision: "approved",
    });
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

  it("lets a hub-introduced device act inside the page but never drive the host's browser, and a device the host's own person paired navigate and type", async () => {
    function pairedRequest(kind: string, admittedBy?: "host-person" | "hub-roster"): Request {
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
          ...(admittedBy === undefined ? {} : { admittedBy }),
        }),
        scopeId: windowId,
      });
      return request;
    }

    expect((await handler(pairedRequest("click")))?.status).toBe(200);
    expect(service.act).toHaveBeenCalledOnce();

    for (const kind of ["navigate", "type", "close-tab"]) {
      expect((await handler(pairedRequest(kind)))?.status).toBe(403);
      expect((await handler(pairedRequest(kind, "hub-roster")))?.status).toBe(403);
    }
    expect(service.act).toHaveBeenCalledOnce();

    for (const kind of ["navigate", "type"]) {
      expect((await handler(pairedRequest(kind, "host-person")))?.status).toBe(200);
    }
    expect(service.act).toHaveBeenCalledTimes(3);
  });

  it("refuses a paired device that asks to record the host's page", async () => {
    for (const kind of ["record-start", "record-stop"]) {
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
      const response = await handler(request);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({
        message: "Recording the host's browser is not a remote action.",
      });
    }
    expect(service.act).not.toHaveBeenCalled();
  });

  describe("taking the page over from the agent", () => {
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const takeOver = "/api/browser/contexts/take-over";
    const handBack = "/api/browser/contexts/hand-back";
    const paths = [takeOver, handBack];
    const post = (path: string, extra: Record<string, unknown> = {}) =>
      new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId, ...extra }),
      });

    it("asks the service under the authenticated window and the named thread", async () => {
      const taken = await handler(post(takeOver));
      expect(taken?.status).toBe(200);
      const held = (await taken?.json()) as { waitingForPerson?: string } | undefined;
      expect(held?.waitingForPerson).toBe("take-over");
      expect(service.takeOver).toHaveBeenCalledWith(windowId, threadId);
      expect((await handler(post(handBack)))?.status).toBe(200);
      expect(service.handBack).toHaveBeenCalledWith(windowId, threadId);
    });

    it("refuses without the window's capability, and malformed input", async () => {
      for (const path of paths) {
        const bare = await handler(
          new Request(`http://127.0.0.1${path}`, {
            method: "POST",
            body: JSON.stringify({ threadId }),
          }),
        );
        expect(bare?.status).toBe(401);
        expect((await handler(post(path, { extra: true })))?.status).toBe(400);
      }
      expect(service.takeOver).not.toHaveBeenCalled();
      expect(service.handBack).not.toHaveBeenCalled();
    });

    it("refuses a window that cannot see the thread before the service is asked", async () => {
      const elsewhere = createBrowserAutomationRouteHandler({
        service: service as any,
        authority: { canAccessWindow: () => false, resolve: () => authority },
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      for (const path of paths) expect((await elsewhere(post(path)))?.status).toBe(403);
      expect(service.takeOver).not.toHaveBeenCalled();
      expect(service.handBack).not.toHaveBeenCalled();
    });

    it("refuses a paired device even where it could tap the page", async () => {
      for (const path of paths) {
        const request = post(path);
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
        expect((await handler(request))?.status).toBe(403);
      }
      expect(service.takeOver).not.toHaveBeenCalled();
      expect(service.handBack).not.toHaveBeenCalled();
    });

    it("passes the service's refusal on: no page, a routine, or the agent's own sign-in ask", async () => {
      service.takeOver.mockReturnValueOnce({
        status: "failed",
        threadId,
        evidence: [],
        failure: { category: "unavailable", message: "There is no page to take over." },
      });
      const none = await handler(post(takeOver));
      expect(none?.status).toBe(409);
      service.takeOver.mockReturnValueOnce({
        status: "failed",
        threadId,
        evidence: [],
        failure: {
          category: "unauthorized",
          message: "A routine has no person to take over a page.",
        },
      });
      expect((await handler(post(takeOver)))?.status).toBe(403);
    });
  });

  describe("thread captures", () => {
    const captureId = "b0000000-0000-4000-8000-000000000001";
    const capture = {
      captureId,
      threadId,
      origin: "https://example.com",
      url: "https://example.com/",
      hash: "a".repeat(64),
      size: 4,
      mime: "image/png",
      capturedAt: "2026-10-12T09:00:00.000Z",
    };
    const step = {
      stepId: "b0000000-0000-4000-8000-000000000020",
      threadId,
      operation: "click",
      origin: "https://example.com",
      path: "/",
      recordedAt: "2026-10-12T09:00:00.000Z",
    };
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };

    // Live Browser authority and being able to open the thread are separate
    // facts: an archived thread has lost the first and kept the second.
    function withCaptures(canAccessWindow = true, canOpenThread = canAccessWindow) {
      const captures = {
        list: vi.fn(() => [capture] as never),
        listSteps: vi.fn(() => [step] as never),
        read: vi.fn(async (_thread: unknown, id: unknown) =>
          String(id) === captureId
            ? { capture, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }
            : undefined,
        ),
      };
      return {
        captures,
        handler: createBrowserAutomationRouteHandler({
          service: service as any,
          captures: captures as never,
          windowCanOpenThread: async () => canOpenThread,
          authority: {
            canAccessWindow: () => canAccessWindow,
            resolve: () => authority,
          },
          windowAuthorityStore: store,
          maxRequestBodySize: 64_000,
        }),
      };
    }

    const post = (path: string, payload: unknown, extra: Record<string, string> = {}) =>
      new Request(`http://127.0.0.1/api/browser/captures${path}`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(payload),
      });

    function asPairedDevice(request: Request): Request {
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

    it("lists a thread's captures and serves one as an image for a window that can open the thread", async () => {
      const { captures, handler: capturing } = withCaptures();
      const listed = await capturing(post("", { threadId }));
      expect(listed?.status).toBe(200);
      expect(await listed?.json()).toEqual({ captures: [capture] });
      expect(captures.list).toHaveBeenCalledWith(threadId);

      const image = await capturing(post("/image", { threadId, captureId }));
      expect(image?.status).toBe(200);
      expect(await image?.json()).toEqual({
        captureId,
        dataUrl: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`,
      });
    });

    it("lists a thread's steps for a window that can open the thread, and refuses everyone else", async () => {
      const allowed = withCaptures();
      const listed = await allowed.handler(
        new Request("http://127.0.0.1/api/browser/steps", {
          method: "POST",
          headers,
          body: JSON.stringify({ threadId }),
        }),
      );
      expect(listed?.status).toBe(200);
      expect(await listed?.json()).toEqual({ steps: [step] });

      const refused = withCaptures(false);
      const stepsRequest = () =>
        new Request("http://127.0.0.1/api/browser/steps", {
          method: "POST",
          headers,
          body: JSON.stringify({ threadId }),
        });
      expect((await refused.handler(stepsRequest()))?.status).toBe(403);
      // A paired device reads no part of the proof, as it reads no capture.
      expect((await allowed.handler(asPairedDevice(stepsRequest())))?.status).toBe(403);
      const wrong = await allowed.handler(
        new Request("http://127.0.0.1/api/browser/steps", {
          method: "POST",
          headers: { ...headers, "x-octant-window-capability": "wrong" },
          body: JSON.stringify({ threadId }),
        }),
      );
      expect(wrong?.status).toBe(401);
      expect(refused.captures.listSteps).not.toHaveBeenCalled();
      expect(allowed.captures.listSteps).toHaveBeenCalledOnce();
    });

    it("refuses a caller with no window capability", async () => {
      const { captures, handler: capturing } = withCaptures();
      for (const [path, payload] of [
        ["", { threadId }],
        ["/image", { threadId, captureId }],
      ] as const) {
        const response = await capturing(
          post(path, payload, { "x-octant-window-capability": "wrong" }),
        );
        expect(response?.status).toBe(401);
      }
      expect(captures.list).not.toHaveBeenCalled();
      expect(captures.read).not.toHaveBeenCalled();
    });

    it("refuses a window that cannot open the thread", async () => {
      const { captures, handler: capturing } = withCaptures(false);
      expect((await capturing(post("", { threadId })))?.status).toBe(403);
      expect((await capturing(post("/image", { threadId, captureId })))?.status).toBe(403);
      expect(captures.list).not.toHaveBeenCalled();
      expect(captures.read).not.toHaveBeenCalled();
    });

    it("still shows an archived thread's captures to a window that can open it, but takes no new one", async () => {
      const { captures, handler: capturing } = withCaptures(false, true);
      const listed = await capturing(post("", { threadId }));
      expect(listed?.status).toBe(200);
      expect(await listed?.json()).toEqual({ captures: [capture] });
      expect((await capturing(post("/image", { threadId, captureId })))?.status).toBe(200);
      expect(captures.read).toHaveBeenCalledOnce();

      const taken = await capturing(
        post("/take", {
          threadId,
          request: {
            actionId: "70000000-0000-4000-8000-000000000001",
            contextId,
            correlationId: "80000000-0000-4000-8000-000000000001",
            authority,
            kind: "screenshot",
          },
        }),
      );
      expect(taken?.status).toBe(403);
    });

    it("refuses to read captures when the host cannot say which threads a window opens", async () => {
      const captures = { list: vi.fn(() => [capture] as never), read: vi.fn() };
      const capturing = createBrowserAutomationRouteHandler({
        service: service as any,
        captures: captures as never,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      expect((await capturing(post("", { threadId })))?.status).toBe(403);
      expect((await capturing(post("/image", { threadId, captureId })))?.status).toBe(403);
      expect(captures.list).not.toHaveBeenCalled();
      expect(captures.read).not.toHaveBeenCalled();
    });

    it("refuses a paired device even for a thread its host window can open", async () => {
      const { captures, handler: capturing } = withCaptures();
      expect((await capturing(asPairedDevice(post("", { threadId }))))?.status).toBe(403);
      expect(
        (await capturing(asPairedDevice(post("/image", { threadId, captureId }))))?.status,
      ).toBe(403);
      expect(captures.list).not.toHaveBeenCalled();
      expect(captures.read).not.toHaveBeenCalled();
    });

    it("does not serve a capture id the thread does not own", async () => {
      const { handler: capturing } = withCaptures();
      const response = await capturing(
        post("/image", {
          threadId,
          captureId: "b0000000-0000-4000-8000-0000000000ff",
        }),
      );
      expect(response?.status).toBe(404);
    });

    const screenshotRequest = {
      actionId: "70000000-0000-4000-8000-000000000001",
      contextId,
      correlationId: "80000000-0000-4000-8000-000000000001",
      authority,
      kind: "screenshot",
    };

    it("keeps nothing for an ordinary screenshot action, so refreshing a preview saves no picture", async () => {
      const response = await handler(
        new Request("http://127.0.0.1/api/browser/actions", {
          method: "POST",
          headers,
          body: JSON.stringify(screenshotRequest),
        }),
      );
      expect(response?.status).toBe(200);
      expect(service.act.mock.lastCall?.[0]).not.toHaveProperty("capturedBy");
    });

    it("brings a picture back with a person's click on a page they see only as a picture", async () => {
      const response = await handler(
        new Request("http://127.0.0.1/api/browser/actions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...screenshotRequest,
            kind: "click",
            target: "#go",
          }),
        }),
      );
      expect(response?.status).toBe(200);
      expect(service.act.mock.lastCall?.[0]).toMatchObject({
        request: { kind: "click", include: ["screenshot"] },
      });
    });

    it("keeps a screenshot as the person's only through the explicit take route", async () => {
      const { handler: capturing } = withCaptures();
      const response = await capturing(post("/take", { threadId, request: screenshotRequest }));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual(snapshot);
      expect(service.act).toHaveBeenLastCalledWith(
        expect.objectContaining({
          windowId,
          capturedBy: "person",
          // The capture is journaled as whoever took it.
          capturedByActor: expect.objectContaining({ kind: "local-user" }),
        }),
      );
    });

    it("refuses to take a capture of anything but a screenshot", async () => {
      const { handler: capturing } = withCaptures();
      const response = await capturing(
        post("/take", {
          threadId,
          request: { ...screenshotRequest, kind: "navigate" },
        }),
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ category: "invalid" });
      expect(service.act).not.toHaveBeenCalled();
    });

    it("refuses to take a capture without capability, for another thread's window, or from a paired device", async () => {
      const { handler: capturing } = withCaptures();
      const body = { threadId, request: screenshotRequest };
      expect(
        (await capturing(post("/take", body, { "x-octant-window-capability": "wrong" })))?.status,
      ).toBe(401);
      expect((await capturing(asPairedDevice(post("/take", body))))?.status).toBe(403);
      const { handler: isolated } = withCaptures(false);
      expect((await isolated(post("/take", body)))?.status).toBe(403);
      expect(service.act).not.toHaveBeenCalled();
    });

    it("refuses to take a capture through a context that belongs to another thread", async () => {
      service.inspect.mockReturnValue({
        status: "failed",
        threadId,
        evidence: [],
        failure: {
          category: "unauthorized",
          message: "Browser context is not owned.",
        },
      });
      const { handler: capturing } = withCaptures();
      const response = await capturing(post("/take", { threadId, request: screenshotRequest }));
      expect(response?.status).toBe(403);
      expect(service.act).not.toHaveBeenCalled();
    });
  });

  it("carries a Project browser command with the window and caller the host proved", async () => {
    const projectBrowsers = {
      execute: vi.fn(async () => ({
        kind: "project-browser-refused" as const,
        reason: "unauthorized" as const,
        message: "Not here.",
      })),
    };
    const withProjects = createBrowserAutomationRouteHandler({
      service: service as any,
      authority: { canAccessWindow: () => true, resolve: () => authority },
      projectBrowsers,
      windowAuthorityStore: store,
      maxRequestBodySize: 64_000,
    });
    const command = {
      kind: "open",
      projectId: "40000000-0000-4000-8000-000000000001",
      url: "https://example.com/",
    };
    const post = (value: unknown, headers: Record<string, string> = {}) =>
      new Request("http://127.0.0.1/api/browser/project-contexts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
          ...headers,
        },
        body: JSON.stringify(value),
      });

    const response = await withProjects(post(command));
    expect(response?.status).toBe(200);
    expect(projectBrowsers.execute).toHaveBeenCalledWith(windowId, "local-window", command);

    // A caller cannot name a thread's context or its origin approval here.
    expect((await withProjects(post({ ...command, threadId })))?.status).toBe(400);
    expect(
      (await withProjects(post(command, { "x-octant-window-capability": "wrong" })))?.status,
    ).toBe(401);
    expect(projectBrowsers.execute).toHaveBeenCalledOnce();

    const paired = post(command);
    bindPrincipalRouteContext(paired, {
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
    await withProjects(paired);
    expect(projectBrowsers.execute).toHaveBeenLastCalledWith(windowId, "remote-device", command);

    const without = await handler(post(command));
    expect(without?.status).toBe(503);
  });

  describe("Browser profiles", () => {
    const profileContext = {
      contextId,
      threadId,
      actionId: "70000000-0000-4000-8000-000000000001",
      correlationId: "80000000-0000-4000-8000-000000000001",
      authority,
      policy: {
        profileMode: "isolated",
        profile: { kind: "personal" },
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
      state: "active",
      createdAt: "2026-10-31T12:00:00.000Z",
    };
    const signedInSnapshot = {
      status: "running",
      threadId,
      context: profileContext,
      observation: {
        contextId,
        actionId: profileContext.actionId,
        correlationId: profileContext.correlationId,
        authority,
        url: "https://example.com/account",
        title: "Your account",
        extractedText: "Signed in as the person",
        screenshotDataUrl: "data:image/png;base64,AAAA",
        observedAt: "2026-10-31T12:00:00.000Z",
        stale: false,
      },
      evidence: [],
    } as unknown as BrowserAutomationSnapshot;
    const post = (path: string, value: unknown, paired = false) => {
      const request = new Request(`http://127.0.0.1/api/browser/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(value),
      });
      if (paired) {
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
      }
      return request;
    };

    it("carries a profile command with the caller the host proved", async () => {
      const profiles = {
        execute: vi.fn(async () => ({
          kind: "browser-profiles" as const,
          profiles: [],
        })),
      };
      const withProfiles = createBrowserAutomationRouteHandler({
        service: service as any,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        profiles,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      const clear = {
        kind: "clear",
        profile: { kind: "personal" },
        scope: "all",
      };

      // The route names who asked, so the service journals a change as theirs.
      const pairedDeviceId = "90000000-0000-4000-8000-000000000001";
      expect((await withProfiles(post("profiles", clear)))?.status).toBe(200);
      expect(profiles.execute).toHaveBeenLastCalledWith(
        "local-window",
        clear,
        expect.objectContaining({ kind: "local-user" }),
      );
      await withProfiles(post("profiles", clear, true));
      expect(profiles.execute).toHaveBeenLastCalledWith("remote-device", clear, {
        kind: "remote-device",
        actorId: pairedDeviceId,
        deviceId: pairedDeviceId,
      });
      // A profile cannot be named by a caller that decides its own scope or store path.
      expect(
        (await withProfiles(post("profiles", { ...clear, partition: "persist:other" })))?.status,
      ).toBe(400);
      expect((await handler(post("profiles", clear)))?.status).toBe(503);
    });

    it("lets a device the host's own person paired review session, upload and download permissions under its own scope, and refuses a hub-introduced device", async () => {
      const deviceId = "90000000-0000-4000-8000-000000000002";
      const fromDevice = (path: string, admittedBy: "host-person" | "hub-roster") => {
        const request = new Request(`http://127.0.0.1/api/browser/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "list" }),
        });
        bindPrincipalRouteContext(request, {
          principal: createRemoteDevicePrincipal({
            hostId: "local" as never,
            deviceId: deviceId as never,
            credentialGeneration: 1,
            origin: "https://octant.example",
            protocolVersion: 1,
            capabilityDigest: "a".repeat(64),
            sessionId: "a1000000-0000-4000-8000-000000000002" as never,
            admittedBy,
          }),
          scopeId: deviceId as never,
        });
        return request;
      };
      const sessionGrants = {
        execute: vi.fn(async () => ({ kind: "browser-session-grants" as const, grants: [] })),
      };
      const uploadPermissions = {
        execute: vi.fn(async () => ({ kind: "upload-permissions" as const, permissions: [] })),
      };
      const downloadPermissions = {
        execute: vi.fn(async () => ({ kind: "download-permissions" as const, permissions: [] })),
      };
      const route = createBrowserAutomationRouteHandler({
        service: service as never,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        sessionGrants,
        uploadPermissions,
        downloadPermissions,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });

      for (const [path, port] of [
        ["session-grants", sessionGrants],
        ["upload-permissions", uploadPermissions],
        ["download-permissions", downloadPermissions],
      ] as const) {
        expect(await (await route(fromDevice(path, "hub-roster")))?.json()).toMatchObject({
          reason: "not-local",
        });
        expect(port.execute).not.toHaveBeenCalled();
        expect((await route(fromDevice(path, "host-person")))?.status).toBe(200);
        // The device's own scope is what the permission's record names.
        expect(port.execute).toHaveBeenCalledWith(deviceId, { kind: "list" });
      }
    });

    it("admits only authenticated local session-permission commands and strictly decodes their scope", async () => {
      const sessionGrants = {
        execute: vi.fn(async () => ({ kind: "browser-session-grants" as const, grants: [] })),
      };
      const route = createBrowserAutomationRouteHandler({
        service: service as never,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        sessionGrants,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      expect(await (await route(post("session-grants", { kind: "list" })))?.json()).toEqual({
        kind: "browser-session-grants",
        grants: [],
      });
      expect(sessionGrants.execute).toHaveBeenCalledOnce();
      expect(
        await (await route(post("session-grants", { kind: "list" }, true)))?.json(),
      ).toMatchObject({ reason: "not-local" });
      expect(
        (await route(post("session-grants", { kind: "list", target: "injected" })))?.status,
      ).toBe(400);
      expect(
        (
          await route(
            new Request("http://127.0.0.1/api/browser/session-grants", {
              method: "POST",
              body: JSON.stringify({ kind: "list" }),
            }),
          )
        )?.status,
      ).toBe(401);
      expect(sessionGrants.execute).toHaveBeenCalledOnce();
    });

    it("admits only authenticated local upload-manifest commands and strictly decodes their scope", async () => {
      const uploadPermissions = {
        execute: vi.fn(async () => ({ kind: "upload-permissions" as const, permissions: [] })),
      };
      const route = createBrowserAutomationRouteHandler({
        service: service as never,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        uploadPermissions,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      expect(await (await route(post("upload-permissions", { kind: "list" })))?.json()).toEqual({
        kind: "upload-permissions",
        permissions: [],
      });
      expect(uploadPermissions.execute).toHaveBeenCalledOnce();
      expect(
        await (await route(post("upload-permissions", { kind: "list" }, true)))?.json(),
      ).toMatchObject({ reason: "not-local" });
      expect(
        (await route(post("upload-permissions", { kind: "list", target: "injected" })))?.status,
      ).toBe(400);
      expect(
        (
          await route(
            new Request("http://127.0.0.1/api/browser/upload-permissions", {
              method: "POST",
              body: JSON.stringify({ kind: "list" }),
            }),
          )
        )?.status,
      ).toBe(401);
      expect(uploadPermissions.execute).toHaveBeenCalledOnce();
    });

    it("admits only authenticated local download-manifest commands and strictly decodes their scope", async () => {
      const downloadPermissions = {
        execute: vi.fn(async () => ({ kind: "download-permissions" as const, permissions: [] })),
      };
      const route = createBrowserAutomationRouteHandler({
        service: service as never,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        downloadPermissions,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      expect(await (await route(post("download-permissions", { kind: "list" })))?.json()).toEqual({
        kind: "download-permissions",
        permissions: [],
      });
      expect(downloadPermissions.execute).toHaveBeenCalledOnce();
      expect(
        await (await route(post("download-permissions", { kind: "list" }, true)))?.json(),
      ).toMatchObject({ reason: "not-local" });
      expect(
        (await route(post("download-permissions", { kind: "list", target: "injected" })))?.status,
      ).toBe(400);
      expect(
        (
          await route(
            new Request("http://127.0.0.1/api/browser/download-permissions", {
              method: "POST",
              body: JSON.stringify({ kind: "list" }),
            }),
          )
        )?.status,
      ).toBe(401);
      expect(downloadPermissions.execute).toHaveBeenCalledOnce();
    });

    it("lists and deletes saved flows for a local window and refuses a paired device", async () => {
      const flowProject = "40000000-0000-4000-8000-000000000001";
      const flows = {
        summaries: vi.fn(() => []),
        delete: vi.fn((_project: unknown, name: string) => name === "Order check"),
      };
      const withFlows = createBrowserAutomationRouteHandler({
        service: service as any,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        flows: flows as never,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      const body = async (response: Response | undefined) => response?.json();

      expect(await body(await withFlows(post("flows", { kind: "list" })))).toEqual({
        kind: "browser-flows",
        flows: [],
      });
      const remove = { kind: "delete", projectId: flowProject, name: "Order check" };
      expect(await body(await withFlows(post("flows", remove)))).toMatchObject({
        kind: "browser-flow-deleted",
      });
      expect(flows.delete).toHaveBeenLastCalledWith(
        flowProject,
        "Order check",
        expect.objectContaining({ kind: "local-user" }),
      );
      expect(await body(await withFlows(post("flows", { ...remove, name: "Gone" })))).toMatchObject(
        { kind: "browser-flows-refused", reason: "not-found" },
      );

      flows.delete.mockClear();
      expect(await body(await withFlows(post("flows", remove, true)))).toMatchObject({
        kind: "browser-flows-refused",
        reason: "not-local",
      });
      expect(await body(await withFlows(post("flows", { kind: "list" }, true)))).toMatchObject({
        reason: "not-local",
      });
      expect(flows.delete).not.toHaveBeenCalled();
      expect((await handler(post("flows", { kind: "list" })))?.status).toBe(503);
    });

    it("binds reviewed flow effects to the authenticated local window and refuses remote or unreviewed starts", async () => {
      const flowProject = authority.projectId;
      if (flowProject === undefined) throw Error("Project fixture missing");
      const task = {
        threadId: decodeBrowserThreadId(threadId),
        mode: "work" as const,
        title: "Check",
        modelId: "synthetic" as never,
        accessLabel: "Ask first",
        profileLabel: "Private",
      };
      const flow = decodeBrowserFlow({
        name: "Check",
        savedAt: new Date().toISOString(),
        steps: [
          {
            operation: "navigate",
            input: { operation: "navigate", url: "https://example.com/" },
            expect: { path: "/" },
          },
        ],
      });
      const execute = vi.fn(async () => ({
        isError: false,
        result: { page: { url: "https://example.com/" } },
      }));
      const runs = new BrowserFlowRuns({
        readFlow: () => flow,
        tasks: () => [task],
        bindTask: () => ({
          fingerprint: "current",
          refs: () => [],
          execute,
          claim: () => ({ release: () => undefined }),
        }),
        uuid: () => contextId,
        now: Date.now,
      });
      const handler = createBrowserAutomationRouteHandler({
        service: service as never,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        flows: { summaries: () => [], delete: () => false },
        flowRuns: runs,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      try {
        const review = {
          kind: "review-run",
          projectId: flowProject,
          threadId,
          mode: "work",
          name: "Check",
        };
        expect(await (await handler(post("flows", review, true)))?.json()).toMatchObject({
          reason: "not-local",
        });
        expect(
          await (
            await handler(post("flows", { kind: "start-run", runId: contextId, values: [] }))
          )?.json(),
        ).toMatchObject({ reason: "not-found" });
        expect((await handler(post("flows", { ...review, authority })))?.status).toBe(400);
        expect(execute).not.toHaveBeenCalled();
        expect(await (await handler(post("flows", review)))?.json()).toMatchObject({
          kind: "browser-flow-run",
          run: { state: "review" },
        });
        expect(execute).not.toHaveBeenCalled();
        expect(
          await (
            await handler(post("flows", { kind: "start-run", runId: contextId, values: [] }, true))
          )?.json(),
        ).toMatchObject({ reason: "not-local" });
        expect(execute).not.toHaveBeenCalled();
        await handler(post("flows", { kind: "start-run", runId: contextId, values: [] }));
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      } finally {
        runs.close();
      }
    });

    it("carries an extensions command with the window and the caller the host proved", async () => {
      const extensions = {
        execute: vi.fn(async () => ({
          kind: "browser-extensions" as const,
          extensions: [],
        })),
      };
      const withExtensions = createBrowserAutomationRouteHandler({
        service: service as any,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        extensions,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      const list = { kind: "list" };

      const pairedDeviceId = "90000000-0000-4000-8000-000000000001";
      expect((await withExtensions(post("extensions", list)))?.status).toBe(200);
      expect(extensions.execute).toHaveBeenLastCalledWith(
        windowId,
        "local-window",
        list,
        expect.objectContaining({ kind: "local-user" }),
      );
      await withExtensions(post("extensions", list, true));
      expect(extensions.execute).toHaveBeenLastCalledWith(windowId, "remote-device", list, {
        kind: "remote-device",
        actorId: pairedDeviceId,
        deviceId: pairedDeviceId,
      });
      // A folder path is never accepted from the caller; only a picker receipt is.
      expect(
        (await withExtensions(post("extensions", { kind: "install", path: "/Users/x/ext" })))
          ?.status,
      ).toBe(400);
      expect((await handler(post("extensions", list)))?.status).toBe(503);
    });

    it("withholds a signed-in page from a paired device and shows it to the local window", async () => {
      service.inspectThread.mockReturnValue(signedInSnapshot);
      const current = { threadId };

      const local = await handler(post("contexts/current", current));
      const paired = await handler(post("contexts/current", current, true));

      expect(await local?.json()).toMatchObject({
        observation: {
          title: "Your account",
          extractedText: "Signed in as the person",
        },
      });
      const withheld = await paired?.json();
      expect(withheld).toMatchObject({
        failure: {
          reason: "profile-not-local",
          message: "Signed-in page — open it on this Mac.",
        },
      });
      expect(JSON.stringify(withheld)).not.toContain("Your account");
      expect(JSON.stringify(withheld)).not.toContain("Signed in as the person");
      expect(JSON.stringify(withheld)).not.toContain("data:image");
    });

    it("refuses a paired device's tap on a signed-in page without reaching the service", async () => {
      const action = {
        actionId: profileContext.actionId,
        contextId,
        correlationId: profileContext.correlationId,
        authority,
        kind: "click",
        point: { x: 0.5, y: 0.5 },
      };
      const withProfileOf = createBrowserAutomationRouteHandler({
        service: { ...service, profileOf: () => ({ kind: "personal" }) } as any,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });

      const refused = await withProfileOf(post("actions", action, true));

      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toMatchObject({
        reason: "profile-not-local",
      });
      expect(service.act).not.toHaveBeenCalled();
    });
  });

  describe("the Project's live agent pages", () => {
    const projectId = "40000000-0000-4000-8000-000000000001";
    const otherThread = "20000000-0000-4000-8000-000000000002";
    const page = (id: string, extra: Record<string, unknown> = {}) => ({
      threadId: id,
      contextId,
      threadTitle: "Research pricing",
      agentActive: true,
      ...extra,
    });

    function listing(
      options: {
        readonly canOpenProject?: boolean;
        readonly canAccessThread?: (id: string) => boolean;
      } = {},
    ) {
      const listProjectAgentPages = vi.fn(
        (input: { readonly threadTitle: (id: never) => unknown }) => {
          // The route decides which threads the window may name.
          const named = [threadId, otherThread].filter(
            (id) => input.threadTitle(id as never) !== undefined,
          );
          return named.map((id) => page(id));
        },
      );
      const handlerWithPages = createBrowserAutomationRouteHandler({
        service: { ...service, listProjectAgentPages } as any,
        authority: {
          canAccessWindow: (_window, id) => options.canAccessThread?.(String(id)) ?? true,
          resolve: () => authority,
        },
        projectAgentPages: {
          windowCanOpenProject: async () => options.canOpenProject ?? true,
          threadTitle: (id) => `Title of ${String(id).slice(-1)}`,
        },
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      const post = (value: unknown, pair = false) => {
        const request = new Request("http://127.0.0.1/api/browser/project-agent-pages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify(value),
        });
        if (pair) {
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
        }
        return request;
      };
      return { handlerWithPages, listProjectAgentPages, post };
    }

    it("lists a Project's pages for a window that holds the Project and each thread", async () => {
      const { handlerWithPages, listProjectAgentPages, post } = listing();
      const response = await handlerWithPages(post({ projectId, mode: "work" }));
      expect(response?.status).toBe(200);
      const answer = (await response?.json()) as {
        pages: ReadonlyArray<{ threadId: string }>;
      };
      expect(answer.pages.map((entry) => entry.threadId)).toEqual([threadId, otherThread]);
      expect(listProjectAgentPages).toHaveBeenCalledWith(
        expect.objectContaining({
          windowId,
          projectId,
          mode: "work",
          remote: false,
        }),
      );
    });

    it("leaves out a thread the window cannot see and refuses a Project it cannot open", async () => {
      const hidden = listing({ canAccessThread: (id) => id === threadId });
      const some = await hidden.handlerWithPages(hidden.post({ projectId, mode: "work" }));
      const answer = (await some?.json()) as {
        pages: ReadonlyArray<{ threadId: string }>;
      };
      expect(answer.pages.map((entry) => entry.threadId)).toEqual([threadId]);

      const closed = listing({ canOpenProject: false });
      const refused = await closed.handlerWithPages(closed.post({ projectId, mode: "work" }));
      expect(refused?.status).toBe(403);
      expect(closed.listProjectAgentPages).not.toHaveBeenCalled();
    });

    it("tells the service a paired device asked, and refuses bad input and bad capability", async () => {
      const { handlerWithPages, listProjectAgentPages, post } = listing();
      expect((await handlerWithPages(post({ projectId, mode: "work" }, true)))?.status).toBe(200);
      expect(listProjectAgentPages).toHaveBeenCalledWith(expect.objectContaining({ remote: true }));
      listProjectAgentPages.mockClear();

      expect((await handlerWithPages(post({ projectId, mode: "chat" })))?.status).toBe(400);
      expect((await handlerWithPages(post({ projectId, mode: "work", threadId })))?.status).toBe(
        400,
      );
      const unauthenticated = new Request("http://127.0.0.1/api/browser/project-agent-pages", {
        method: "POST",
        body: JSON.stringify({ projectId, mode: "work" }),
      });
      expect((await handlerWithPages(unauthenticated))?.status).toBe(401);
      expect(listProjectAgentPages).not.toHaveBeenCalled();
    });

    it("is unavailable on a host with no Project threads to name", async () => {
      const bare = createBrowserAutomationRouteHandler({
        service: service as any,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      const response = await bare(
        new Request("http://127.0.0.1/api/browser/project-agent-pages", {
          method: "POST",
          headers: { "x-octant-window-capability": capability },
          body: JSON.stringify({ projectId, mode: "work" }),
        }),
      );
      expect(response?.status).toBe(503);
    });
  });
});
