import { randomBytes } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { BindingReceiptStore } from "./bindingReceiptStore";
import {
  authenticateProjectRequest,
  createProjectBindingRouteHandler,
} from "./projectBindingRoutes";
import { ProjectRootError } from "./projectRootPort";
import { WindowAuthorityError, WindowAuthorityStore } from "./windowAuthorityStore";

const secret = randomBytes(32).toString("base64url");
const capability = randomBytes(32).toString("base64url");
const rendererIdentity = randomBytes(32).toString("base64url");
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000521");

describe("project binding routes", () => {
  it("registers window authority and issues only opaque receipt metadata", async () => {
    const dependencies = routeDependencies(secret);
    const handle = createProjectBindingRouteHandler(dependencies);
    const registration = await handle(
      desktopRequest("/api/desktop/window-authorities", {
        windowId,
        capability,
        rendererIdentity,
      }),
    );
    expect(registration?.status).toBe(204);
    expect(
      dependencies.windowAuthorityStore.authenticateRenderer(capability, rendererIdentity, 0),
    ).toBe(windowId);

    const response = await handle(
      desktopRequest("/api/desktop/project-binding-receipts", {
        windowId,
        projectType: "work",
        path: "/unvalidated/private/path",
      }),
    );
    expect(response?.status).toBe(201);
    const body = await response?.json();
    expect(body).toMatchObject({ projectType: "work" });
    expect(body.receiptId).toHaveLength(43);
    expect(JSON.stringify(body)).not.toContain("unvalidated");
    expect(dependencies.projectRootPort.validate).toHaveBeenCalledWith(
      "work",
      "/unvalidated/private/path",
    );
  });

  it("fails closed for absent or mismatched secrets, renderer origins, foreign hosts, and excess input", async () => {
    for (const [request, status] of [
      [desktopRequest("/api/desktop/window-authorities", { windowId, capability }, "wrong"), 401],
      [
        new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
          method: "POST",
          headers: { origin: "file://", "x-octant-desktop-secret": secret },
          body: JSON.stringify({ windowId, capability }),
        }),
        401,
      ],
      [
        new Request("http://192.168.1.5:13773/api/desktop/window-authorities", {
          method: "POST",
          headers: { "x-octant-desktop-secret": secret },
          body: JSON.stringify({ windowId, capability }),
        }),
        401,
      ],
      [
        desktopRequest("/api/desktop/window-authorities", {
          windowId,
          capability,
          unexpected: true,
        }),
        400,
      ],
    ] as const) {
      const response = await createProjectBindingRouteHandler(routeDependencies(secret))(request);
      expect(response?.status).toBe(status);
      expect(response?.headers.get("access-control-allow-origin")).toBeNull();
      const responseText = await response?.text();
      expect(responseText).not.toContain(secret);
      expect(responseText).not.toContain("/unvalidated");
    }

    const unavailable = await createProjectBindingRouteHandler(routeDependencies(undefined))(
      desktopRequest("/api/desktop/window-authorities", { windowId, capability }),
    );
    expect(unavailable?.status).toBe(503);
  });

  it("revokes a window and enforces the body limit", async () => {
    const onWindowRevoked = vi.fn();
    const dependencies = { ...routeDependencies(secret), onWindowRevoked };
    const handle = createProjectBindingRouteHandler({ ...dependencies, maxRequestBodySize: 256 });
    await handle(desktopRequest("/api/desktop/window-authorities", { windowId, capability }));
    const revoked = await handle(
      new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
        method: "DELETE",
        headers: { "x-octant-desktop-secret": secret },
        body: JSON.stringify({ windowId }),
      }),
    );
    expect(revoked?.status).toBe(204);
    expect(onWindowRevoked).toHaveBeenCalledWith(windowId);
    expect(() => dependencies.windowAuthorityStore.authenticate(capability, 1_001)).toThrow();

    const oversized = await handle(
      desktopRequest("/api/desktop/window-authorities", {
        windowId,
        capability,
        padding: "x".repeat(300),
      }),
    );
    expect(oversized?.status).toBe(413);
  });

  it("returns retryable unavailable when host-time recovery blocks window registration", async () => {
    const unavailableStore = new WindowAuthorityStore(undefined, {
      clockPosture: () => "recovery-required",
    });
    const response = await createProjectBindingRouteHandler({
      ...routeDependencies(secret),
      windowAuthorityStore: unavailableStore,
    })(desktopRequest("/api/desktop/window-authorities", { windowId, capability }));

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      category: "unavailable",
      message: "Desktop Project binding is unavailable while host time recovery is required.",
    });
  });

  it("accepts IPv6 loopback while denying query identities and unsupported methods", async () => {
    const handle = createProjectBindingRouteHandler(routeDependencies(secret));
    const ipv6 = await handle(
      new Request("http://[::1]:13773/api/desktop/window-authorities", {
        method: "POST",
        headers: { "x-octant-desktop-secret": secret },
        body: JSON.stringify({ windowId, capability }),
      }),
    );
    expect(ipv6?.status).toBe(204);

    const queryIdentity = await createProjectBindingRouteHandler(routeDependencies(secret))(
      desktopRequest(`/api/desktop/window-authorities?windowId=${windowId}`, {
        windowId,
        capability,
      }),
    );
    expect(queryIdentity?.status).toBe(400);
    expect(await queryIdentity?.json()).toMatchObject({ category: "invalid" });

    const wrongMethod = await handle(
      new Request("http://[::1]:13773/api/desktop/project-binding-receipts", {
        method: "GET",
        headers: { "x-octant-desktop-secret": secret },
      }),
    );
    expect(wrongMethod?.status).toBe(400);
    expect(await wrongMethod?.json()).toMatchObject({ category: "unsupported" });
  });

  it("derives Project window identity from capability and rejects caller-supplied identities", () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const request = new Request("http://127.0.0.1:13773/api/projects/commands", {
      headers: { "x-octant-window-capability": capability },
    });

    expect(authenticateProjectRequest({ request, body: { kind: "command" }, store, now: 1 })).toBe(
      windowId,
    );
    expect(() =>
      authenticateProjectRequest({ request, body: { kind: "command", windowId }, store, now: 1 }),
    ).toThrow();
    expect(() =>
      authenticateProjectRequest({
        request: new Request(`http://127.0.0.1:13773/api/projects/commands?windowId=${windowId}`, {
          headers: { "x-octant-window-capability": capability },
        }),
        body: { kind: "command" },
        store,
        now: 1,
      }),
    ).toThrow();
    expect(() =>
      authenticateProjectRequest({
        request: new Request("http://127.0.0.1:13773/api/projects/commands", {
          headers: { "x-octant-window-capability": "forged" },
        }),
        body: {},
        store,
        now: 1,
      }),
    ).toThrow();
  });

  it("returns 400 when Code root validation rejects a selected folder", async () => {
    const dependencies = routeDependencies(secret);
    dependencies.projectRootPort.validate = vi.fn(async () => {
      throw new ProjectRootError();
    });
    const response = await createProjectBindingRouteHandler(dependencies)(
      desktopRequest("/api/desktop/project-binding-receipts", {
        windowId,
        projectType: "code",
        path: "/unvalidated/private/path",
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      category: "unavailable",
      message: "The selected Project root is unavailable.",
    });
  });

  it("preserves invalid capability authority errors instead of rewriting them as identity errors", () => {
    const store = new WindowAuthorityStore();
    vi.spyOn(store, "authenticate").mockImplementation(() => {
      throw new WindowAuthorityError("invalid", "Window capability token is invalid.");
    });

    expect(() =>
      authenticateProjectRequest({
        request: new Request("http://127.0.0.1:13773/api/projects/commands", {
          headers: { "x-octant-window-capability": "forged" },
        }),
        body: { kind: "command" },
        store,
        now: 1,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "WindowAuthorityError",
        category: "invalid",
        message: "Window capability token is invalid.",
      }),
    );
  });
});

function routeDependencies(desktopBridgeSecret: string | undefined) {
  return {
    desktopBridgeSecret,
    windowAuthorityStore: new WindowAuthorityStore(),
    bindingReceiptStore: new BindingReceiptStore(),
    projectRootPort: {
      validate: vi.fn(async () => ({ canonicalRoot: "/canonical/project" })),
    },
    now: () => 1_000,
  };
}

function desktopRequest(path: string, body: unknown, providedSecret = secret): Request {
  return new Request(`http://127.0.0.1:13773${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": providedSecret,
    },
    body: JSON.stringify(body),
  });
}
