import { randomUUID } from "node:crypto";
import { decodeWindowId, type WindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { LaunchSessionStore } from "./launchSessionStore";
import { createLaunchSessionRouteHandler } from "./launchSessionRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const globalBridgeSecret = `${"S".repeat(42)}A`;
const windowId: WindowId = decodeWindowId(randomUUID());
const capability = `${"A".repeat(42)}A`;
const now = () => 1_000;

function makeHandler(options?: {
  bridgeSecret?: string | undefined;
  allowedRendererHttpOrigin?: string | null;
}) {
  const store = new LaunchSessionStore({ now });
  const authorityStore = new WindowAuthorityStore();
  const bridgeSecret =
    options && Object.prototype.hasOwnProperty.call(options, "bridgeSecret")
      ? options.bridgeSecret
      : globalBridgeSecret;
  return {
    store,
    authorityStore,
    handler: createLaunchSessionRouteHandler({
      desktopBridgeSecret: bridgeSecret,
      launchSessionStore: store,
      windowAuthorityStore: authorityStore,
      now,
      ...(options !== undefined &&
      Object.prototype.hasOwnProperty.call(options, "allowedRendererHttpOrigin")
        ? { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }
        : {}),
      generateLocalAuthority: () => ({ windowId, capability }),
    }),
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:13773${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("createLaunchSessionRouteHandler — admin create", () => {
  it("creates a launch session for a registered window when the bridge secret matches", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      post(
        "/api/desktop/launch-sessions",
        { windowId, capability },
        { "x-octant-desktop-secret": globalBridgeSecret },
      ),
    );
    expect(response?.status).toBe(201);
    const body = await response?.json();
    expect(body.launchToken).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    expect(body.expiresAt).toBe(301_000);
  });

  it("returns 503 when the desktop bridge secret is unavailable", async () => {
    const { handler } = makeHandler({ bridgeSecret: undefined });
    const response = await handler(post("/api/desktop/launch-sessions", { windowId, capability }));
    expect(response?.status).toBe(503);
  });

  it("rejects a missing or wrong bridge secret as 401 without echoing it", async () => {
    const { handler } = makeHandler();
    const wrong = `${"X".repeat(42)}A`;
    const response = await handler(
      post(
        "/api/desktop/launch-sessions",
        { windowId, capability },
        { "x-octant-desktop-secret": wrong },
      ),
    );
    expect(response?.status).toBe(401);
    const text = await response?.text();
    expect(text).not.toContain(wrong);
  });

  it("rejects a browser origin on the admin route", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      post(
        "/api/desktop/launch-sessions",
        { windowId, capability },
        { "x-octant-desktop-secret": globalBridgeSecret, origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(response?.status).toBe(401);
  });

  it("rejects a non-loopback host", async () => {
    const store = new LaunchSessionStore({ now });
    const h = createLaunchSessionRouteHandler({
      desktopBridgeSecret: globalBridgeSecret,
      launchSessionStore: store,
      windowAuthorityStore: new WindowAuthorityStore(),
      now,
    });
    const response = await h(
      new Request("http://10.0.0.1:13773/api/desktop/launch-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": globalBridgeSecret,
        },
        body: JSON.stringify({ windowId, capability }),
      }),
    );
    expect(response?.status).toBe(401);
  });

  it("rejects an invalid body as 400", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      post(
        "/api/desktop/launch-sessions",
        { windowId, capability: "short" },
        { "x-octant-desktop-secret": globalBridgeSecret },
      ),
    );
    expect(response?.status).toBe(400);
  });
});

describe("createLaunchSessionRouteHandler — renderer exchange", () => {
  it("exchanges a valid launch token for the window capability from an allowed renderer origin", async () => {
    const { handler, store } = makeHandler();
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ windowId, capability });
  });

  it("registers the exchanged capability in the window authority store", async () => {
    const { handler, store, authorityStore } = makeHandler();
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(response?.status).toBe(200);
    expect(authorityStore.authenticate(capability, now())).toBe(windowId);
  });

  it("refreshes an existing desktop-registered authority instead of failing on conflict", async () => {
    const { handler, store, authorityStore } = makeHandler();
    authorityStore.register({ windowId, capability, now: now() });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(response?.status).toBe(200);
    expect(authorityStore.authenticate(capability, now())).toBe(windowId);
  });

  it("checks clock recovery before consuming a launch token so it can be retried", async () => {
    let posture: "ok" | "recovery-required" = "ok";
    const store = new LaunchSessionStore({ now });
    const authorityStore = new WindowAuthorityStore(undefined, {
      clockPosture: () => posture,
    });
    const handler = createLaunchSessionRouteHandler({
      desktopBridgeSecret: globalBridgeSecret,
      launchSessionStore: store,
      windowAuthorityStore: authorityStore,
      now,
    });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    posture = "recovery-required";

    const unavailable = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(unavailable?.status).toBe(503);
    expect(await unavailable?.json()).toMatchObject({ category: "unavailable" });

    posture = "ok";
    const retried = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(retried?.status).toBe(200);
  });

  it("rolls back an exchange when recovery starts during authority registration", async () => {
    let posture: "ok" | "recovery-required" = "ok";
    let clampCalls = 0;
    const store = new LaunchSessionStore({
      now,
      clampNow: (rawNow) => {
        clampCalls += 1;
        // Token creation is the first clock observation. Its exchange makes
        // the authority store reject, exercising the former consume-then-fail
        // race at the actual route boundary.
        if (clampCalls === 2) posture = "recovery-required";
        return rawNow;
      },
    });
    const authorityStore = new WindowAuthorityStore(undefined, {
      clockPosture: () => posture,
    });
    const handler = createLaunchSessionRouteHandler({
      desktopBridgeSecret: globalBridgeSecret,
      launchSessionStore: store,
      windowAuthorityStore: authorityStore,
      now,
    });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });

    const unavailable = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(unavailable?.status).toBe(503);

    posture = "ok";
    const retried = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(retried?.status).toBe(200);
  });

  it("emits CORS headers for an allowed loopback renderer origin", async () => {
    const { handler, store } = makeHandler();
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(response?.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("exchanges a launch token from a packaged opaque origin", async () => {
    const { handler, store, authorityStore } = makeHandler({ allowedRendererHttpOrigin: null });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      post("/api/shell/launch-session", { launchToken: receipt.launchToken }, { origin: "null" }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe("null");
    expect(authorityStore.authenticate(capability, now())).toBe(windowId);
  });

  it("keeps loopback browser clients available when Electron is packaged", async () => {
    const { handler, store } = makeHandler({ allowedRendererHttpOrigin: null });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("handles an OPTIONS preflight for the renderer exchange route", async () => {
    const { handler, store } = makeHandler();
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      new Request(`http://127.0.0.1:13773/api/shell/launch-session?token=${receipt.launchToken}`, {
        method: "OPTIONS",
        headers: { origin: "http://127.0.0.1:13773" },
      }),
    );
    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rejects a non-loopback renderer host", async () => {
    const { handler, store } = makeHandler();
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      new Request("http://10.0.0.1:13773/api/shell/launch-session", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://10.0.0.1:13773" },
        body: JSON.stringify({ launchToken: receipt.launchToken }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects a disallowed renderer origin", async () => {
    const { handler, store } = makeHandler();
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const response = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://example.com" },
      ),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects an already-consumed token as 400", async () => {
    const { handler, store } = makeHandler();
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    const response = await handler(
      post(
        "/api/shell/launch-session",
        { launchToken: receipt.launchToken },
        { origin: "http://127.0.0.1:13773" },
      ),
    );
    expect(response?.status).toBe(400);
  });

  it("returns undefined for unrelated paths", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      new Request("http://127.0.0.1:13773/api/other", { method: "GET" }),
    );
    expect(response).toBeUndefined();
  });
});

describe("createLaunchSessionRouteHandler — local client bootstrap", () => {
  it("creates and registers local client context directly on the canonical host", async () => {
    const { handler, authorityStore } = makeHandler();
    const response = await handler(
      post("/api/shell/local-session", {}, { origin: "http://127.0.0.1:13773" }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      windowId,
      capability,
      authentication: "local-session",
    });
    expect(authorityStore.authenticate(capability, now())).toBe(windowId);
  });

  it("keeps the canonical host available while a Vite renderer is configured", async () => {
    const { handler } = makeHandler({ allowedRendererHttpOrigin: "http://localhost:5173" });
    const response = await handler(
      post("/api/shell/local-session", {}, { origin: "http://127.0.0.1:13773" }),
    );

    expect(response?.status).toBe(200);
  });

  it("reuses a Vite client context only from the explicitly configured renderer origin", async () => {
    const { handler, authorityStore } = makeHandler({
      allowedRendererHttpOrigin: "http://127.0.0.1:5173",
    });
    await handler(post("/api/shell/local-session", {}, { origin: "http://127.0.0.1:5173" }));

    const response = await handler(
      post(
        "/api/shell/local-session",
        { windowId, capability },
        { origin: "http://127.0.0.1:5173" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      windowId,
      capability,
      authentication: "local-session",
    });
    expect(authorityStore.size()).toBe(1);
  });

  it("admits another loopback renderer as the same local-user trust class", async () => {
    const { handler } = makeHandler();

    const response = await handler(
      post("/api/shell/local-session", {}, { origin: "http://127.0.0.1:9999" }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:9999");
  });

  it("rejects a non-loopback request host and a disallowed renderer origin", async () => {
    const { handler } = makeHandler();
    const remote = await handler(
      new Request("http://10.0.0.1:13773/api/shell/local-session", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: "{}",
      }),
    );
    const foreignOrigin = await handler(
      post("/api/shell/local-session", {}, { origin: "https://example.com" }),
    );
    const electronOrigin = await handler(
      post("/api/shell/local-session", {}, { origin: "file://" }),
    );

    expect(remote?.status).toBe(400);
    expect(foreignOrigin?.status).toBe(400);
    expect(electronOrigin?.status).toBe(400);
  });
});
