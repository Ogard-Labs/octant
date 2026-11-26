import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import {
  editMobileQueuedMessage,
  queueMobileFollowUp,
  readMobileThreadMessageQueue,
  removeMobileQueuedMessage,
} from "./mobileThreadMessageQueueClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const threadId = "00000000-0000-4000-8000-000000000201";
const messageId = "00000000-0000-4000-8000-000000000301";
const scope = { mode: "work" as const, threadId };

function snapshot(items: ReadonlyArray<unknown> = []) {
  return { scope, version: 3, paused: false, items };
}

function transportAnswering(answer: (body: unknown) => unknown) {
  const sent: Array<{ readonly method: string; readonly path: string; readonly body?: unknown }> =
    [];
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: vi.fn(async (input) => {
      const body = typeof input.body === "string" ? JSON.parse(input.body) : undefined;
      sent.push({ method: input.method, path: input.path, body });
      return new Response(JSON.stringify(answer(body)), { status: 200 });
    }),
  };
  return { transport, sent };
}

describe("the thread message queue from a phone", () => {
  it("a follow-up sent during a running turn joins the host queue", async () => {
    const { transport, sent } = transportAnswering((body) => ({
      status: "applied",
      requestId: (body as { requestId: string }).requestId,
      snapshot: snapshot([
        { messageId, status: "queued", revision: 4, createdAt: "2026-11-26T09:00:00.000Z" },
      ]),
    }));
    const result = await queueMobileFollowUp({
      transport,
      scope,
      expectedVersion: 3,
      prompt: "Also update the docs",
      typedByPerson: true,
    });
    expect(result.items).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/api/thread-message-queue/commands",
      body: {
        kind: "enqueue",
        scope,
        expectedVersion: 3,
        payload: { mode: "work", prompt: "Also update the docs", typedByPerson: true },
      },
    });
  });

  it("a queued message can be removed from the phone", async () => {
    const { transport, sent } = transportAnswering((body) => ({
      status: "applied",
      requestId: (body as { requestId: string }).requestId,
      snapshot: snapshot(),
    }));
    const result = await removeMobileQueuedMessage({
      transport,
      scope,
      expectedVersion: 4,
      messageId,
    });
    expect(result.items).toEqual([]);
    expect(sent[0]?.body).toMatchObject({ kind: "remove", messageId, expectedVersion: 4 });
  });

  it("edits a queued message's words", async () => {
    const { transport, sent } = transportAnswering((body) => ({
      status: "applied",
      requestId: (body as { requestId: string }).requestId,
      snapshot: snapshot(),
    }));
    await editMobileQueuedMessage({
      transport,
      scope,
      expectedVersion: 4,
      messageId,
      prompt: "Update the docs too",
    });
    expect(sent[0]?.body).toMatchObject({ kind: "edit", messageId, prompt: "Update the docs too" });
  });

  it("reads the queue and says why when the host refuses a change", async () => {
    const read = transportAnswering(() => ({ status: "ready", snapshot: snapshot() }));
    await expect(readMobileThreadMessageQueue(read.transport, scope)).resolves.toMatchObject({
      version: 3,
    });
    expect(read.sent[0]).toMatchObject({ method: "GET", path: "/api/thread-message-queue" });

    const refused = transportAnswering((body) => ({
      status: "refused",
      requestId: (body as { requestId: string }).requestId,
      reason: "not-editable",
    }));
    await expect(
      removeMobileQueuedMessage({
        transport: refused.transport,
        scope,
        expectedVersion: 4,
        messageId,
      }),
    ).rejects.toThrow("That message is already on its way and can no longer change.");
  });
});
