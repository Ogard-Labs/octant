import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import {
  editMobileQueuedMessage,
  loadMobileMessageQueue,
  queueMobileMessage,
  removeMobileQueuedMessage,
  sendMobileQueuedMessageNow,
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

  it("does not call a stop that came too late a stop", async () => {
    const { transport } = host((entry) =>
      Response.json({
        kind: "provider-turn-state",
        operationId: entry.body.operationId,
        state: "failed",
        failure: { category: "failed", message: "That turn has already ended." },
      }),
    );
    expect(
      await stopMobileCodeTurn({ transport, threadId, checkoutId, turnOperationId: turnId }),
    ).toMatchObject({ status: "refused" });
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

describe("sending a message through the thread's queue", () => {
  const ready = (version: number, prompts: ReadonlyArray<string> = []) =>
    Response.json({ status: "ready", snapshot: snapshot(version, prompts) });
  const isCommand = (sent: Sent) => sent.path.endsWith("/commands");
  const sendTo = (transport: MobileRemoteTransport) =>
    queueMobileMessage({ transport, scope, messageId, prompt: "And the docs" });

  it("queues on the version the computer is at, and returns what it holds", async () => {
    const { sent, transport } = host((entry) =>
      isCommand(entry)
        ? Response.json({
            status: "applied",
            requestId: entry.body.requestId,
            snapshot: snapshot(5, ["And the docs"]),
          })
        : ready(4),
    );
    expect((await sendTo(transport)).status).toBe("queued");
    expect(sent[1]).toMatchObject({
      path: "/api/thread-message-queue/commands",
      body: {
        kind: "enqueue",
        scope,
        messageId,
        expectedVersion: 4,
        payload: { mode: "code", prompt: "And the docs" },
      },
    });
  });

  it("queues once more on the computer's version when another client got there first", async () => {
    let commands = 0;
    const { sent, transport } = host((entry) => {
      if (!isCommand(entry)) return ready(4);
      commands += 1;
      return Response.json({
        status: commands === 1 ? "conflict" : "applied",
        requestId: entry.body.requestId,
        snapshot: snapshot(commands === 1 ? 7 : 8),
      });
    });
    expect((await sendTo(transport)).status).toBe("queued");
    expect(sent.filter(isCommand).map((entry) => entry.body.expectedVersion)).toEqual([4, 7]);
  });

  it("asks again with the same id when the answer is lost, and takes a repeat as sent", async () => {
    let commands = 0;
    const { sent, transport } = host((entry) => {
      if (!isCommand(entry)) return ready(4);
      commands += 1;
      if (commands === 1) throw new TypeError("Network request failed");
      // Accepted the first time, and already out of the queue.
      return Response.json({
        status: "duplicate",
        requestId: entry.body.requestId,
        snapshot: snapshot(6),
      });
    });
    expect((await sendTo(transport)).status).toBe("queued");
    expect(sent.filter(isCommand).map((entry) => entry.body.messageId)).toEqual([
      messageId,
      messageId,
    ]);
  });

  it("does not send a message the person took back while the queue was read", async () => {
    let wanted = true;
    const { sent, transport } = host((entry) => {
      wanted = false;
      return isCommand(entry) ? new Response("", { status: 500 }) : ready(4);
    });
    expect(
      await queueMobileMessage({
        transport,
        scope,
        messageId,
        prompt: "And the docs",
        stillWanted: () => wanted,
      }),
    ).toEqual({ status: "withdrawn" });
    expect(sent.filter(isCommand)).toEqual([]);
  });

  it("says nothing of a message while the computer cannot be reached", async () => {
    for (const answer of [
      () => {
        throw new TypeError("Network request failed");
      },
      () => new Response("", { status: 503 }),
    ])
      expect((await sendTo(host(answer).transport)).status).toBe("unreachable");
  });

  it("says why the computer refused, and refuses where it offers no queue", async () => {
    const refusing = host((entry) =>
      isCommand(entry)
        ? Response.json({
            status: "refused",
            requestId: entry.body.requestId,
            reason: "queue-full",
          })
        : ready(4),
    );
    expect(await sendTo(refusing.transport)).toEqual({
      status: "refused",
      message: "The queue is full.",
    });
    expect((await sendTo(host(() => new Response("", { status: 403 })).transport)).status).toBe(
      "refused",
    );
  });

  it("refuses an answer about another thread", async () => {
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

  it("says the person typed a message, and sends it again without that to a computer that predates it", async () => {
    let commands = 0;
    const { sent, transport } = host((entry) => {
      if (!isCommand(entry)) return ready(4);
      commands += 1;
      return commands === 1
        ? new Response("{}", { status: 400 })
        : Response.json({
            status: "applied",
            requestId: entry.body.requestId,
            snapshot: snapshot(5, ["And the docs"]),
          });
    });
    const result = await queueMobileMessage({
      transport,
      scope,
      messageId,
      prompt: "And the docs",
      typedByPerson: true,
    });
    expect(result.status).toBe("queued");
    const posted = sent.filter(isCommand);
    expect(posted[0]?.body).toMatchObject({ payload: { typedByPerson: true } });
    expect(posted[1]?.body.payload).not.toHaveProperty("typedByPerson");
  });

  it("changes a waiting message's words, and moves one to the front to send it now", async () => {
    const { sent, transport } = host((entry) =>
      Response.json({ status: "applied", requestId: entry.body.requestId, snapshot: snapshot(6) }),
    );
    const held = snapshot(5, ["x"]) as never;
    await editMobileQueuedMessage({ transport, snapshot: held, messageId, prompt: " Docs too " });
    await sendMobileQueuedMessageNow({ transport, snapshot: held, messageId });
    expect(sent[0]?.body).toMatchObject({ kind: "edit", messageId, prompt: "Docs too" });
    expect(sent[1]?.body).toMatchObject({ kind: "send-now", messageId, expectedVersion: 5 });
  });
});
