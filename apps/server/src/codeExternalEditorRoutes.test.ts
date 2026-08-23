import { describe, expect, it, vi } from "vitest";
import {
  createCodeCheckoutOpenRouteHandler,
  createCodeExternalEditorRouteHandler,
  isCodeCheckoutOpenTargetCurrent,
  isCodeExternalEditorTargetCurrent,
} from "./codeExternalEditorRoutes";

const secret = "desktop-secret";
const ids = {
  windowId: "10000000-0000-4000-8000-000000000001",
  threadId: "20000000-0000-4000-8000-000000000001",
  checkoutId: "30000000-0000-4000-8000-000000000001",
  fileId: "40000000-0000-4000-8000-000000000001",
};

describe("Code external editor desktop route", () => {
  it("returns the authoritative target only to the authenticated desktop", async () => {
    const resolve = vi.fn(async () => ({
      file: "/private/repo/src/app.ts",
      editor: { executable: "/usr/local/bin/code", arguments: ["--goto", "{file}"] },
    }));
    const handle = createCodeExternalEditorRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(request(ids));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      file: "/private/repo/src/app.ts",
      line: 12,
      column: 4,
      editor: { executable: "/usr/local/bin/code", arguments: ["--goto", "{file}"] },
    });
    expect(resolve).toHaveBeenCalledWith(ids);
  });

  it.each([
    ["wrong", undefined, 401],
    [secret, "file://", 401],
  ])("rejects forged or renderer-originated requests", async (token, origin, status) => {
    const resolve = vi.fn();
    const handle = createCodeExternalEditorRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(request(ids, token, origin));
    expect(response?.status).toBe(status);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects paths and excess authority fields", async () => {
    const resolve = vi.fn();
    const handle = createCodeExternalEditorRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(request({ ...ids, path: "/private/repo", prompt: "edit it" }));
    expect(response?.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reports resolver failures as unavailable without leaking resolver details", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("/private/repo/src/app.ts disappeared");
    });
    const handle = createCodeExternalEditorRouteHandler({ desktopBridgeSecret: secret, resolve });

    const response = await handle(request(ids));

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      category: "unavailable",
      message: "Code external editor target is unavailable.",
    });
  });

  it.each([
    ["active available", "active", "available", "available", true],
    ["archived thread", "archived", "available", "available", false],
    ["waiting checkout", "active", "waiting", "available", false],
    ["stale file reference", "active", "available", "conflict", false],
    ["missing relative path", "active", "available", "completed", false],
  ] as const)(
    "accepts only a current target (%s)",
    (label, lifecycle, availability, fileState, expected) => {
      const current = isCodeExternalEditorTargetCurrent({
        thread: {
          id: ids.threadId,
          checkoutId: ids.checkoutId,
          lifecycle,
        } as never,
        checkout: { id: ids.checkoutId, availability } as never,
        reference: {
          id: ids.fileId,
          threadId: ids.threadId,
          checkoutId: ids.checkoutId,
          relativePath: label === "missing relative path" ? undefined : "src/app.ts",
          state: fileState,
        } as never,
      });

      expect(current).toBe(expected);
    },
  );
});

describe("Code checkout Open in desktop route", () => {
  it("returns a confined checkout root only to the authenticated desktop", async () => {
    const resolve = vi.fn(async () => ({ checkoutRoot: "/private/repo" }));
    const handle = createCodeCheckoutOpenRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(
      checkoutRequest({ windowId: ids.windowId, threadId: ids.threadId }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ checkoutRoot: "/private/repo" });
    expect(resolve).toHaveBeenCalledWith({ windowId: ids.windowId, threadId: ids.threadId });
  });

  it("rejects renderer origins, excess target fields, and unavailable checkouts", async () => {
    const resolve = vi.fn();
    const handle = createCodeCheckoutOpenRouteHandler({ desktopBridgeSecret: secret, resolve });

    expect((await handle(checkoutRequest(ids, secret, "file://")))?.status).toBe(401);
    expect((await handle(checkoutRequest({ ...ids, path: "/private/repo" })))?.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["active", "available", true],
    ["archived", "available", false],
    ["active", "waiting", false],
  ] as const)("accepts only an active available checkout", (lifecycle, availability, expected) => {
    expect(
      isCodeCheckoutOpenTargetCurrent({
        checkout: { id: ids.checkoutId, availability } as never,
        thread: { checkoutId: ids.checkoutId, lifecycle } as never,
      }),
    ).toBe(expected);
  });
});

function request(body: unknown, token = secret, origin?: string): Request {
  return new Request("http://127.0.0.1:13773/api/desktop/code-external-editor-target", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": token,
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify({ ...(body as object), line: 12, column: 4 }),
  });
}

function checkoutRequest(body: unknown, token = secret, origin?: string): Request {
  const record = body as Record<string, unknown>;
  return new Request("http://127.0.0.1:13773/api/desktop/code-checkout-open-target", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": token,
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify({ windowId: record.windowId, threadId: record.threadId, ...record }),
  });
}
