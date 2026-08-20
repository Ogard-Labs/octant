import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createWorkTurnRouteHandler } from "./workTurnRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const threadId = "00000000-0000-4000-8000-000000000902";
const attachmentId = "00000000-0000-4000-8000-000000000910";

describe("Work turn attachment routes", () => {
  it("stages a pasted image and discards it by thread and attachment identity", async () => {
    const stageAttachment = vi.fn(async () => ({
      attachmentId,
      displayName: "pasted.png",
      mediaType: "image/png" as const,
      byteLength: 3,
      digest: "a".repeat(64),
    }));
    const discardAttachment = vi.fn(async () => undefined);
    const route = routeFixture({ stageAttachment, discardAttachment });

    const staged = await route(
      request("/api/work/attachments", {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-octant-work-thread-id": threadId,
          "x-octant-work-attachment-id": attachmentId,
          "x-octant-work-display-name": encodeURIComponent("pasted.png"),
        },
        body: new Uint8Array([137, 80, 78]),
      }),
    );

    expect(staged?.status).toBe(200);
    expect(await staged!.json()).toMatchObject({
      attachmentId,
      displayName: "pasted.png",
      mediaType: "image/png",
    });
    expect(stageAttachment).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({
        threadId,
        attachmentId,
        displayName: "pasted.png",
        mediaType: "image/png",
      }),
    );

    const discarded = await route(
      request(`/api/work/attachments?thread=${threadId}&attachment=${attachmentId}`, {
        method: "DELETE",
      }),
    );
    expect(discarded?.status).toBe(200);
    expect(discardAttachment).toHaveBeenCalledWith(windowId, threadId, attachmentId);
  });

  it("does not stage an attachment without a window capability", async () => {
    const stageAttachment = vi.fn();
    const route = routeFixture({ stageAttachment });

    const response = await route(
      new Request("http://127.0.0.1/api/work/attachments", {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-octant-work-thread-id": threadId,
          "x-octant-work-attachment-id": attachmentId,
          "x-octant-work-display-name": "pasted.png",
        },
        body: new Uint8Array([137, 80, 78]),
      }),
    );

    expect(response?.status).toBe(401);
    expect(stageAttachment).not.toHaveBeenCalled();
  });
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-octant-window-capability")) {
    headers.set("x-octant-window-capability", capability);
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

function routeFixture(overrides: Record<string, unknown> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createWorkTurnRouteHandler({
    service: {
      startFirstTurn: vi.fn(),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(),
      ...overrides,
    } as never,
    windowAuthorityStore: store,
    now: () => 1,
  });
}
