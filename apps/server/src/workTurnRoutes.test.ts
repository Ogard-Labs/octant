import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createWorkTurnRouteHandler } from "./workTurnRoutes";
import { WorkTurnServiceError } from "./work/workTurnService";

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

describe("Work turn live stream route", () => {
  it("streams cursor-ordered Work response frames from the authorized thread", async () => {
    const subscribe = vi.fn(async function* () {
      yield {
        kind: "response-delta" as const,
        sequence: 5,
        threadId,
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        text: "Immediate text",
      };
    });
    const route = routeFixture({ subscribe });

    const response = await route(
      request(`/api/work/turns/stream/${threadId}?afterSequence=4`, { method: "GET" }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/x-ndjson");
    await expect(response?.text()).resolves.toContain('"text":"Immediate text"');
    expect(subscribe).toHaveBeenCalledWith(windowId, threadId, 4, expect.any(AbortSignal));
  });

  it("rejects a stream query that omits the afterSequence key", async () => {
    const subscribe = vi.fn(async function* () {});
    const route = routeFixture({ subscribe });

    const response = await route(
      request(`/api/work/turns/stream/${threadId}?unexpected=4`, { method: "GET" }),
    );

    expect(response?.status).toBe(400);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("Work transcript window route", () => {
  const before = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const emptyWindow = {
    version: 1,
    threadId,
    turns: [],
    liveCursor: 7,
    hasEarlier: true,
    hasLater: true,
  };

  it("answers one page of the thread for the authorized window and is never cached", async () => {
    const transcriptWindow = vi.fn(async () => emptyWindow);
    const route = routeFixture({ transcriptWindow });

    const response = await route(
      request(`/api/work/turns/window/${threadId}?limit=30&before=${before}`, { method: "GET" }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response!.json()).toEqual(emptyWindow);
    expect(transcriptWindow).toHaveBeenCalledWith(windowId, threadId, { limit: 30, before });
  });

  it("refuses a window anchored on a turn the thread does not hold", async () => {
    const transcriptWindow = vi.fn(async () => {
      throw new WorkTurnServiceError({
        category: "stale",
        message: "That Work turn is no longer in this thread.",
      });
    });
    const route = routeFixture({ transcriptWindow });

    const response = await route(
      request(`/api/work/turns/window/${threadId}?limit=30&before=${before}`, { method: "GET" }),
    );

    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ category: "stale" });
  });

  it("refuses a window query it does not define before reading the thread", async () => {
    const transcriptWindow = vi.fn(async () => emptyWindow);
    const route = routeFixture({ transcriptWindow });

    for (const query of [
      "",
      "?limit=0",
      "?limit=65",
      "?limit=3.5",
      "?limit=30&limit=20",
      "?limit=30&after=" + before,
      "?limit=30&before=not-a-turn",
      "?limit=30&windowId=00000000-0000-4000-8000-000000000901",
    ]) {
      const response = await route(
        request(`/api/work/turns/window/${threadId}${query}`, { method: "GET" }),
      );
      expect(response?.status, query).toBe(400);
    }
    expect(transcriptWindow).not.toHaveBeenCalled();
  });

  it("refuses a window read without a window capability", async () => {
    const transcriptWindow = vi.fn(async () => emptyWindow);
    const route = routeFixture({ transcriptWindow });

    const response = await route(
      new Request(`http://127.0.0.1/api/work/turns/window/${threadId}?limit=30`),
    );

    expect(response?.status).toBe(401);
    expect(transcriptWindow).not.toHaveBeenCalled();
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
