import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import {
  loadMobileMessageQueue,
  queueMobileMessage,
  removeMobileQueuedMessage,
  stopMobileCodeTurn,
  stopMobileWorkTurn,
} from "./mobileTurnControlClient";

const threadId = "60000000-0000-4000-8000-000000000001";
const turnId = "60000000-0000-4000-8000-000000000002";
const requestId = "60000000-0000-4000-8000-000000000003";
const checkoutId = "60000000-0000-4000-8000-000000000004";
const messageId = "60000000-0000-4000-8000-000000000005";
const scope = { mode: "code" as const, threadId };
const at = "2026-11-25T08:00:00.000Z";
const snapshot = (version: number, prompts: ReadonlyArray<string> = []) => ({
  scope,
  version,
  paused: false,
  items: prompts.map((prompt, index) => ({
    messageId: index === 0 ? messageId : `60000000-0000-4000-8000-0000000000${10 + index}`,
    status: "queued",
    revision: 0,
    createdAt: at,
    payload: { mode: "code", prompt },
  })),
});

type Sent = { readonly path: string; readonly body: Record<string, unknown> };
function host(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const transport: MobileRemoteTransport = {
    hostId: "host",
    authenticatedFetch: async ({ path, body }) => {
      const entry = { path, body: body === undefined ? {} : JSON.parse(String(body)) } as Sent;
      sent.push(entry);
      return answer(entry);
    },
  };
  return { sent, transport };
}

describe("stopping a turn from the phone", () => {
  it("names the Work turn the person saw running", async () => {
    const { sent, transport } = host(() =>
      Response.json({ kind: "turn-cancelled", requestId, threadId, turnId, status: "cancelled" }),
    );
    expect(await stopMobileWorkTurn({ transport, threadId, turnId, requestId })).toEqual({
      status: "stopped",
    });
    expect(sent).toEqual([
      {
        path: "/api/work/turns/cancel",
        body: { kind: "cancel-work-turn", requestId, threadId, turnId },
      },
    ]);
  });

  it("names the Code turn, so a late Stop cannot end the turn after it", async () => {
    const { sent, transport } = host((entry) =>
      Response.json({
        kind: "operation-accepted",
        operationId: entry.body.operationId,
        operation: "cancel-provider-turn",
      }),
    );
    await stopMobileCodeTurn({ transport, threadId, checkoutId, turnOperationId: turnId });
    expect(sent[0]?.body).toMatchObject({
      kind: "cancel-provider-turn",
      threadId,
      checkoutId,
      turnOperationId: turnId,
    });
  });

  it("gives the reason when the computer refuses", async () => {
    const { transport } = host(() =>
      Response.json({ message: "This device may not stop turns here." }, { status: 403 }),
    );
    expect(await stopMobileWorkTurn({ transport, threadId, turnId, requestId })).toEqual({
      status: "refused",
      message: "This device may not stop turns here.",
    });
  });
});

describe("queueing a message from the phone", () => {
  it("queues on the version the phone read, and returns what the computer holds", async () => {
    const { sent, transport } = host((entry) =>
      Response.json({
        status: "applied",
        requestId: entry.body.requestId,
        snapshot: snapshot(5, ["And the docs"]),
      }),
    );
    const result = await queueMobileMessage({
      transport,
      snapshot: snapshot(4) as never,
      prompt: "And the docs",
    });
    expect(result.status).toBe("queued");
    expect(sent[0]).toMatchObject({
      path: "/api/thread-message-queue/commands",
      body: {
        kind: "enqueue",
        scope,
        expectedVersion: 4,
        payload: { mode: "code", prompt: "And the docs" },
      },
    });
  });

  it("queues once more on the computer's version when another client got there first", async () => {
    let calls = 0;
    const { sent, transport } = host((entry) => {
      calls += 1;
      return Response.json({
        status: calls === 1 ? "conflict" : "applied",
        requestId: entry.body.requestId,
        snapshot: snapshot(calls === 1 ? 7 : 8, ["x"]),
      });
    });
    const result = await queueMobileMessage({
      transport,
      snapshot: snapshot(4) as never,
      prompt: "x",
    });
    expect(result.status).toBe("queued");
    expect(sent.map((entry) => entry.body.expectedVersion)).toEqual([4, 7]);
    // The same message, so it can never be queued twice.
    expect(sent[0]?.body.messageId).toBe(sent[1]?.body.messageId);
  });

  it("takes a lost answer as queued only when the computer holds the message", async () => {
    const prompt = "x";
    for (const held of [true, false]) {
      let queued = "";
      const { transport } = host((entry) => {
        if (entry.path.endsWith("/commands")) {
          queued = String(entry.body.messageId);
          throw new TypeError("Network request failed");
        }
        const read = snapshot(5, held ? [prompt] : []);
        return Response.json({
          status: "ready",
          snapshot: {
            ...read,
            items: read.items.map((item) => ({ ...item, messageId: queued })),
          },
        });
      });
      const result = await queueMobileMessage({
        transport,
        snapshot: snapshot(4) as never,
        prompt,
      });
      expect(result.status).toBe(held ? "queued" : "refused");
    }
  });

  it("says why the computer refused, and refuses an answer about another thread", async () => {
    const refusing = host((entry) =>
      Response.json({
        status: "refused",
        requestId: entry.body.requestId,
        reason: "queue-full",
      }),
    );
    expect(
      await queueMobileMessage({
        transport: refusing.transport,
        snapshot: snapshot(4) as never,
        prompt: "x",
      }),
    ).toEqual({ status: "refused", message: "The queue is full." });
    const other = host(() =>
      Response.json({
        status: "ready",
        snapshot: { ...snapshot(1), scope: { mode: "code", threadId: turnId } },
      }),
    );
    await expect(loadMobileMessageQueue(other.transport, scope)).rejects.toThrow();
  });

  it("removes a message that still waits", async () => {
    const { sent, transport } = host((entry) =>
      Response.json({ status: "applied", requestId: entry.body.requestId, snapshot: snapshot(6) }),
    );
    const result = await removeMobileQueuedMessage({
      transport,
      snapshot: snapshot(5, ["x"]) as never,
      messageId,
    });
    expect(result).toMatchObject({ status: "queued", snapshot: { version: 6, items: [] } });
    expect(sent[0]?.body).toMatchObject({ kind: "remove", messageId, expectedVersion: 5 });
  });
});
