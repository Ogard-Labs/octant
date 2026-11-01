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
      authority: { canAccessWindow: () => true, resolve: () => authority },
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
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };

    // Live Browser authority and being able to open the thread are separate
    // facts: an archived thread has lost the first and kept the second.
    function withCaptures(canAccessWindow = true, canOpenThread = canAccessWindow) {
      const captures = {
        list: vi.fn(() => [capture] as never),
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
          authority: { canAccessWindow: () => canAccessWindow, resolve: () => authority },
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
        post("/image", { threadId, captureId: "b0000000-0000-4000-8000-0000000000ff" }),
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
          body: JSON.stringify({ ...screenshotRequest, kind: "click", target: "#go" }),
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
        expect.objectContaining({ windowId, capturedBy: "person" }),
      );
    });

    it("refuses to take a capture of anything but a screenshot", async () => {
      const { handler: capturing } = withCaptures();
      const response = await capturing(
        post("/take", { threadId, request: { ...screenshotRequest, kind: "navigate" } }),
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
        failure: { category: "unauthorized", message: "Browser context is not owned." },
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
        execute: vi.fn(async () => ({ kind: "browser-profiles" as const, profiles: [] })),
      };
      const withProfiles = createBrowserAutomationRouteHandler({
        service: service as any,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        profiles,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      const clear = { kind: "clear", profile: { kind: "personal" }, scope: "all" };

      expect((await withProfiles(post("profiles", clear)))?.status).toBe(200);
      expect(profiles.execute).toHaveBeenLastCalledWith("local-window", clear);
      await withProfiles(post("profiles", clear, true));
      expect(profiles.execute).toHaveBeenLastCalledWith("remote-device", clear);
      // A profile cannot be named by a caller that decides its own scope or store path.
      expect(
        (await withProfiles(post("profiles", { ...clear, partition: "persist:other" })))?.status,
      ).toBe(400);
      expect((await handler(post("profiles", clear)))?.status).toBe(503);
    });

    it("carries an extensions command with the window and the caller the host proved", async () => {
      const extensions = {
        execute: vi.fn(async () => ({ kind: "browser-extensions" as const, extensions: [] })),
      };
      const withExtensions = createBrowserAutomationRouteHandler({
        service: service as any,
        authority: { canAccessWindow: () => true, resolve: () => authority },
        extensions,
        windowAuthorityStore: store,
        maxRequestBodySize: 64_000,
      });
      const list = { kind: "list" };

      expect((await withExtensions(post("extensions", list)))?.status).toBe(200);
      expect(extensions.execute).toHaveBeenLastCalledWith(windowId, "local-window", list);
      await withExtensions(post("extensions", list, true));
      expect(extensions.execute).toHaveBeenLastCalledWith(windowId, "remote-device", list);
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
        observation: { title: "Your account", extractedText: "Signed in as the person" },
      });
      const withheld = await paired?.json();
      expect(withheld).toMatchObject({
        failure: { reason: "profile-not-local", message: "Signed-in page — open it on this Mac." },
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
      expect(await refused?.json()).toMatchObject({ reason: "profile-not-local" });
      expect(service.act).not.toHaveBeenCalled();
    });
  });
});
