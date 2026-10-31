import { describe, expect, it, vi } from "vitest";
import { startBrowserRuntimeBroker } from "./browserRuntimeBroker";
import { BrowserNavigationBlockedError } from "./browserSurfaceHost";

const contextId = "10000000-0000-4000-8000-000000000001";

function host() {
  return {
    available: () => true,
    act: vi.fn(async () => ({ url: "https://example.com/" })),
    peek: vi.fn(async () => ({
      url: "https://example.com/",
      screenshotDataUrl: "data:image/jpeg;base64,AAAA",
    })),
    closeAll: vi.fn(async () => undefined),
    closeContext: vi.fn(async () => undefined),
    createContext: vi.fn(async () => undefined),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    onContextGone: vi.fn(() => () => undefined),
  };
}

describe("BrowserRuntimeBroker", () => {
  it("accepts only authenticated bounded interactive actions", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: {
            kind: "click",
            point: { x: 0.5, y: 0.25 },
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(surface.act).toHaveBeenCalledWith(contextId, {
        kind: "click",
        point: { x: 0.5, y: 0.25 },
      });

      const invalid = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: { kind: "scroll", deltaY: 2001 },
        }),
      );
      expect(invalid.status).toBe(400);
      expect(surface.act).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("accepts the diagnostics read as a bounded action", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, { contextId, request: { kind: "observe-diagnostics" } }),
      );

      expect(response.status).toBe(200);
      expect(surface.act).toHaveBeenCalledWith(contextId, { kind: "observe-diagnostics" });
    } finally {
      await broker.close();
    }
  });

  it("returns a picture of the page on peek without treating it as an action", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        new Request(new URL("v1/contexts/peek", broker.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-browser-broker-token": broker.token,
          },
          body: JSON.stringify({ contextId }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        url: "https://example.com/",
        screenshotDataUrl: "data:image/jpeg;base64,AAAA",
      });
      expect(surface.peek).toHaveBeenCalledWith(contextId);
      expect(surface.act).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it("reports a refused off-origin navigation as a structured 422", async () => {
    const surface = host();
    surface.act.mockRejectedValueOnce(
      new BrowserNavigationBlockedError("https://www.example.com/"),
    );
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: { kind: "navigate", target: "https://example.com/" },
        }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "navigation-blocked",
        url: "https://www.example.com/",
      });
    } finally {
      await broker.close();
    }
  });

  it("rejects remote or unauthenticated callers", async () => {
    const broker = await startBrowserRuntimeBroker(host() as never);
    try {
      const unauthenticated = new Request(new URL("v1/available", broker.url), {
        method: "POST",
      });
      expect((await broker.fetchForTest(unauthenticated)).status).toBe(401);
      expect(
        (await broker.fetchForTest(request(broker.url, broker.token, {}), "192.0.2.1")).status,
      ).toBe(401);
    } finally {
      await broker.close();
    }
  });
});

function request(url: string, token: string, body: unknown, path = "v1/contexts/act"): Request {
  return new Request(new URL(path, url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-browser-broker-token": token,
    },
    body: JSON.stringify(body),
  });
}

describe("BrowserRuntimeBroker profiles", () => {
  const projectId = "40000000-0000-4000-8000-000000000001";
  function store() {
    return {
      list: vi.fn(async () => [{ profile: { kind: "personal" as const }, sizeBytes: 12 }]),
      clear: vi.fn(async () => undefined),
      syncExtensions: vi.fn(async () => undefined),
      extensionPage: vi.fn(() => undefined),
    };
  }
  const post = (broker: { url: string; token: string }, path: string, body: unknown) =>
    request(broker.url, broker.token, body, path);

  it("lists and clears stored profiles for the authenticated server only", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    try {
      const listed = await broker.fetchForTest(post(broker, "v1/profiles/list", {}));
      expect(await listed.json()).toEqual({
        profiles: [{ profile: { kind: "personal" }, sizeBytes: 12 }],
      });

      const cleared = await broker.fetchForTest(
        post(broker, "v1/profiles/clear", {
          profile: { kind: "project", projectId },
          scope: "cookies",
        }),
      );
      expect(cleared.status).toBe(200);
      expect(profiles.clear).toHaveBeenCalledWith({ kind: "project", projectId }, "cookies");

      const wrongToken = await broker.fetchForTest(
        request(
          broker.url,
          "wrong",
          { profile: { kind: "personal" }, scope: "all" },
          "v1/profiles/clear",
        ),
      );
      expect(wrongToken.status).toBe(401);
      expect(profiles.clear).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("refuses a profile it cannot name or a scope it does not know, clearing nothing", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    try {
      for (const body of [
        { profile: { kind: "private" }, scope: "all" },
        { profile: { kind: "project", projectId: "../../etc" }, scope: "all" },
        { profile: { kind: "personal" }, scope: "everything" },
        { profile: { kind: "personal", partition: "persist:other" }, scope: "all" },
      ]) {
        const response = await broker.fetchForTest(post(broker, "v1/profiles/clear", body));
        expect(response.status).toBe(400);
      }
      expect(profiles.clear).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it("loads the extensions the server names into a stored profile, and refuses anything else", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    try {
      const entry = {
        id: "a".repeat(32),
        path: "/data/browser-extensions/x",
        contentHash: "b".repeat(64),
      };
      const ok = await broker.fetchForTest(
        post(broker, "v1/extensions/sync", { profile: { kind: "personal" }, extensions: [entry] }),
      );
      expect(ok.status).toBe(200);
      expect(profiles.syncExtensions).toHaveBeenCalledWith({ kind: "personal" }, [entry]);

      for (const body of [
        { profile: { kind: "private" }, extensions: [] },
        { profile: { kind: "personal" }, extensions: [{ ...entry, path: "relative/folder" }] },
        { profile: { kind: "personal" }, extensions: [{ ...entry, id: "../../x" }] },
        { profile: { kind: "personal" }, extensions: [{ ...entry, contentHash: "short" }] },
        { profile: { kind: "personal" }, extensions: "all" },
      ]) {
        const response = await broker.fetchForTest(post(broker, "v1/extensions/sync", body));
        expect(response.status).toBe(400);
      }
      expect(profiles.syncExtensions).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("says plainly that profiles are unavailable when the app keeps none", async () => {
    const broker = await startBrowserRuntimeBroker(host() as never);
    try {
      const response = await broker.fetchForTest(post(broker, "v1/profiles/list", {}));
      expect(response.status).toBe(409);
    } finally {
      await broker.close();
    }
  });

  it("accepts a stored profile in a context's policy and refuses a malformed one", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never, store());
    try {
      const policy = (profile: unknown) => ({
        profileMode: "isolated",
        profile,
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      });
      const create = (profile: unknown) =>
        broker.fetchForTest(
          post(broker, "v1/contexts/create", {
            contextId,
            owner: { windowId: "window-a", threadId: contextId },
            policy: policy(profile),
          }),
        );

      expect((await create({ kind: "personal" })).status).toBe(200);
      expect((await create({ kind: "personal", partition: "x" })).status).toBe(400);
      expect((await create({ kind: "everyone" })).status).toBe(400);
      expect(surface.createContext).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });
});
