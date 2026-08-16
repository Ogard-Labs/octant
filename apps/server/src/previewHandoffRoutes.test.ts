import { describe, expect, it, vi } from "vitest";
import { decodePreviewTargetId } from "@octant/contracts/previews";
import { createPreviewHandoffBridgeRouteHandler } from "./previewHandoffRoutes";

const secret = "desktop-secret";
const ids = {
  windowId: "10000000-0000-4000-8000-000000000001",
  target: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  host: "33333333-3333-4333-8333-333333333333",
} as const;

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetId: ids.target,
    projectId: ids.project,
    hostId: ids.host,
    kind: "file",
    opaqueRef: "opaque-token-1",
    displayName: "notes.md",
    ...overrides,
  };
}

function request(
  body: unknown,
  token: string | undefined = secret,
  origin: string | undefined = undefined,
  url = "http://127.0.0.1/api/desktop/preview-handoff",
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["x-octant-desktop-secret"] = token;
  if (origin !== undefined) headers.origin = origin;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("Preview handoff desktop bridge route", () => {
  it("returns the confined export path only to the authenticated desktop", async () => {
    const resolve = vi.fn(async () => ({
      kind: "resolved" as const,
      absolutePath: "/private/repo/exports/notes.pdf",
      handoffKind: "open-external" as const,
      displayName: "notes.pdf",
    }));
    const handle = createPreviewHandoffBridgeRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(
      request({ windowId: ids.windowId, target: target(), kind: "open-external" }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      handoffKind: "open-external",
      path: "/private/repo/exports/notes.pdf",
    });
    expect(resolve).toHaveBeenCalledWith({
      windowId: ids.windowId,
      target: target(),
      kind: "open-external",
      signal: expect.any(AbortSignal),
    });
  });

  it("resolves every handoff kind", async () => {
    for (const kind of ["reveal-in-finder", "quick-look", "open-external"] as const) {
      const resolve = vi.fn(async () => ({
        kind: "resolved" as const,
        absolutePath: "/private/repo/notes.md",
        handoffKind: kind,
        displayName: "notes.md",
      }));
      const handle = createPreviewHandoffBridgeRouteHandler({
        desktopBridgeSecret: secret,
        resolve,
      });
      const response = await handle(request({ windowId: ids.windowId, target: target(), kind }));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ handoffKind: kind, path: "/private/repo/notes.md" });
    }
  });

  it.each([
    ["wrong secret", "forged"],
    ["no secret configured", undefined],
    ["renderer origin header", undefined],
  ] as const)("rejects forged or renderer-originated requests (%s)", async (label, token) => {
    const resolve = vi.fn();
    const handle = createPreviewHandoffBridgeRouteHandler({
      desktopBridgeSecret: token === undefined ? undefined : secret,
      resolve,
    });
    const response = await handle(
      request(
        { windowId: ids.windowId, target: target(), kind: "quick-look" },
        token,
        label === "renderer origin header" ? "http://127.0.0.1:5173" : undefined,
      ),
    );
    expect(response?.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects excess fields including any path", async () => {
    const resolve = vi.fn();
    const handle = createPreviewHandoffBridgeRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(
      request({
        windowId: ids.windowId,
        target: target(),
        kind: "quick-look",
        path: "/private/repo/notes.md",
      }),
    );
    expect(response?.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a malformed target or unknown kind without resolving", async () => {
    const resolve = vi.fn();
    const handle = createPreviewHandoffBridgeRouteHandler({ desktopBridgeSecret: secret, resolve });
    const malformed = await handle(
      request({ windowId: ids.windowId, target: target({ opaqueRef: "a/b" }), kind: "quick-look" }),
    );
    expect(malformed?.status).toBe(400);
    const unknownKind = await handle(
      request({ windowId: ids.windowId, target: target(), kind: "shell-open" }),
    );
    expect(unknownKind?.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("masks unauthorized and unavailable resolutions as 404 without leaking a path", async () => {
    const resolve = vi.fn(async () => ({
      kind: "unauthorized" as const,
      targetId: decodePreviewTargetId(ids.target),
    }));
    const handle = createPreviewHandoffBridgeRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(
      request({ windowId: ids.windowId, target: target(), kind: "reveal-in-finder" }),
    );
    expect(response?.status).toBe(404);
    const body = await response?.json();
    expect(body).toEqual({ category: "unavailable", message: "Preview handoff is unavailable." });
    expect(JSON.stringify(body)).not.toContain("/private");
    expect(JSON.stringify(body)).not.toContain(ids.target);
  });

  it("masks failed resolutions as 503 without leaking a path", async () => {
    const resolve = vi.fn(async () => ({
      kind: "failed" as const,
      reason: "read-failed" as const,
    }));
    const handle = createPreviewHandoffBridgeRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(
      request({ windowId: ids.windowId, target: target(), kind: "quick-look" }),
    );
    expect(response?.status).toBe(503);
    const body = await response?.json();
    expect(JSON.stringify(body)).not.toContain("/private");
  });

  it("reports resolver failures as unavailable without leaking resolver details", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("/private/repo/notes.md disappeared");
    });
    const handle = createPreviewHandoffBridgeRouteHandler({ desktopBridgeSecret: secret, resolve });
    const response = await handle(
      request({ windowId: ids.windowId, target: target(), kind: "open-external" }),
    );
    expect(response?.status).toBe(503);
    const body = await response?.json();
    expect(JSON.stringify(body)).not.toContain("/private");
    expect(JSON.stringify(body)).not.toContain("notes.md");
  });
});
