import { describe, expect, it, vi } from "vitest";
import {
  decodeMentionableThreadId,
  decodeThreadMentionRequestId,
  type MentionableThreadId,
} from "@octant/contracts";
import { createThreadMentionClient, ThreadMentionClientFailure } from "./threadMentionClient";

const baseUrl = "http://127.0.0.1:4318";
const windowCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const requestId = decodeThreadMentionRequestId("00000000-0000-4000-8000-000000000001");
const threadId: MentionableThreadId = decodeMentionableThreadId(
  "00000000-0000-4000-8000-000000000101",
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof globalThis.fetch) {
  return createThreadMentionClient({ baseUrl, fetch: fetchImpl, windowCapability });
}

const candidate = {
  threadId,
  mode: "chat",
  title: "Release notes",
  placement: { kind: "unfiled" },
  updatedAt: "2026-08-14T10:00:00.000Z",
};

describe("createThreadMentionClient", () => {
  it("refuses a non-loopback base URL", () => {
    expect(() =>
      createThreadMentionClient({
        baseUrl: "https://example.com",
        fetch: globalThis.fetch,
        windowCapability,
      }),
    ).toThrow(ThreadMentionClientFailure);
  });

  it("carries the window capability and returns server candidates", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ kind: "mentions-searched", requestId, candidates: [candidate] }),
      );

    const candidates = await client(fetchImpl as never).search(requestId, "rel");

    expect(candidates).toHaveLength(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(
      windowCapability,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "search-mentions",
      requestId,
      query: "rel",
    });
  });

  it("resolves nothing locally when the thread id list is empty", async () => {
    const fetchImpl = vi.fn();

    expect(await client(fetchImpl as never).resolve(requestId, [])).toEqual({
      mentions: [],
      unavailable: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks every requested mention unavailable when the server refuses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ kind: "failed", requestId, reason: "unauthorized" }));

    const resolved = await client(fetchImpl as never).resolve(requestId, [threadId]);

    expect(resolved.mentions).toEqual([]);
    expect(resolved.unavailable).toEqual([{ threadId, reason: "unauthorized" }]);
  });

  it("throws rather than inventing a sidecar when Side Chat is refused", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ kind: "failed", requestId, reason: "unauthorized" }));

    await expect(client(fetchImpl as never).openSideChat(requestId, threadId)).rejects.toThrow(
      ThreadMentionClientFailure,
    );
  });

  it("returns the server's sidecar linkage verbatim", async () => {
    const sidecar = {
      sourceThreadId: threadId,
      sourceMode: "work",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
      title: "Side Chat about Release notes",
      createdAt: "2026-08-14T10:00:00.000Z",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ kind: "side-chat-opened", requestId, sidecar, created: true }),
      );

    const opened = await client(fetchImpl as never).openSideChat(requestId, threadId);

    expect(opened).toEqual({ sidecar, created: true });
  });

  it("surfaces the host's message on a failed request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Thread mention request is unauthorized." }, 401));

    await expect(client(fetchImpl as never).search(requestId, "rel")).rejects.toMatchObject({
      status: 401,
      message: "Thread mention request is unauthorized.",
    });
  });

  it("reports transport failure as unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(client(fetchImpl as never).search(requestId, "rel")).rejects.toMatchObject({
      status: 0,
    });
  });
});
