import { describe, expect, it, vi } from "vitest";
import { decodeMentionableThreadId, decodeThreadMessageQueueCommand } from "@octant/contracts";
import { createThreadMessageQueueClient } from "./threadMessageQueueClient";

const threadId = decodeMentionableThreadId("11111111-1111-4111-8111-111111111111");
describe("the host message queue connection", () => {
  it("authenticates reads and refuses an unavailable host instead of inventing a queue", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Missing", { status: 404 }));
    const client = createThreadMessageQueueClient({
      serverUrl: "http://localhost:4310",
      windowCapability: "window-proof",
      fetch: fetcher,
    });
    await expect(client.read({ mode: "chat", threadId })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4310/api/thread-message-queue?mode=chat&threadId=" + threadId,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-octant-window-capability": "window-proof" }),
      }),
    );
  });
  it("reads the authenticated envelope and posts the exact nested-scope command", async () => {
    const scope = { mode: "chat" as const, threadId };
    const snapshot = { scope, version: 0, paused: false, items: [] };
    const command = decodeThreadMessageQueueCommand({
      kind: "enqueue",
      scope,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      payload: { mode: "chat", prompt: "Keep the exact draft" },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "ready", snapshot }))
      .mockResolvedValueOnce(
        Response.json({
          status: "applied",
          requestId: command.requestId,
          snapshot: { ...snapshot, version: 1 },
        }),
      );
    const client = createThreadMessageQueueClient({
      serverUrl: "http://localhost:4310/",
      windowCapability: "window-proof",
      fetch: fetcher,
    });
    expect(await client.read(scope)).toEqual(snapshot);
    expect((await client.execute(command)).status).toBe("applied");
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4310/api/thread-message-queue/commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(command),
        headers: {
          "x-octant-window-capability": "window-proof",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("refuses a snapshot for another thread instead of exposing it in this composer", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "ready",
        snapshot: {
          scope: { mode: "chat", threadId: "22222222-2222-4222-8222-222222222222" },
          version: 0,
          paused: false,
          items: [],
        },
      }),
    );
    const client = createThreadMessageQueueClient({
      serverUrl: "http://localhost:4310",
      windowCapability: "window-proof",
      fetch: fetcher,
    });
    await expect(client.read({ mode: "chat", threadId })).rejects.toThrow("different thread");
  });
});
