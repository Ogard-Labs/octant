import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MESSAGE_AGGREGATE,
  type AgentMessageAcknowledged,
  type AgentMessageDelivered,
  type AgentMessageRefused,
  type AgentMessageSent,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  AgentMessageProjection,
  MAX_EARLY_REFUSALS_PER_SENDER,
  hydrateAgentMessageProjectionFromJournal,
} from "./agentMessageProjection";
import { AgentMessageBodyStore } from "./agentMessageBodyStore";

const sent: AgentMessageSent = {
  kind: "message-sent",
  messageId: "10000000-0000-4000-8000-000000000001" as never,
  correlationId: "20000000-0000-4000-8000-000000000001" as never,
  senderThreadId: "chat-0000-0000-4000-8000-00000000000a" as never,
  recipientThreadId: "code-0000-0000-4000-8000-00000000000b" as never,
  bodyReference: { contentReference: "am-10000000-0000-4000-8000-000000000001", byteLength: 12 },
  occurredAt: "2026-09-10T12:00:00.000Z",
};

function refusedEvent(reason: AgentMessageRefused["refuseReason"]): AgentMessageRefused {
  return {
    kind: "message-refused",
    messageId: sent.messageId,
    correlationId: sent.correlationId,
    refuseReason: reason,
    occurredAt: "2026-09-10T12:00:01.000Z",
  };
}

function deliveredEvent(): AgentMessageDelivered {
  return {
    kind: "message-delivered",
    messageId: sent.messageId,
    correlationId: sent.correlationId,
    recipientThreadId: sent.recipientThreadId,
    bodyReference: sent.bodyReference,
    occurredAt: "2026-09-10T12:00:02.000Z",
  };
}

function acknowledgedEvent(): AgentMessageAcknowledged {
  return {
    kind: "message-acknowledged",
    messageId: sent.messageId,
    correlationId: sent.correlationId,
    occurredAt: "2026-09-10T12:00:03.000Z",
  };
}

describe("the agent message projection", () => {
  it("rebuilds in-flight and delivered messages from a journal replay", () => {
    const projection = new AgentMessageProjection();
    const status = hydrateAgentMessageProjectionFromJournal({
      replay: () => [
        {
          globalSequence: 1,
          aggregateType: AGENT_MESSAGE_AGGREGATE,
          eventName: "agent.message-sent@1",
          eventVersion: 1,
          payload: sent,
        },
      ],
      projection,
    });
    expect(status).toBe("ok");
    expect(projection.lookup(String(sent.messageId))).toMatchObject({
      state: "in-flight",
      senderThreadId: sent.senderThreadId,
      recipientThreadId: sent.recipientThreadId,
    });
  });

  it("applies duplicate and out-of-order events idempotently", () => {
    const projection = new AgentMessageProjection();
    projection.apply(sent);
    projection.apply(deliveredEvent());
    projection.apply(deliveredEvent());
    projection.apply(refusedEvent("policy"));
    projection.apply(acknowledgedEvent());
    // A refusal cannot un-deliver a message the host already delivered, and
    // the acknowledgement follows the delivered message once.
    expect(projection.lookup(String(sent.messageId))).toMatchObject({ state: "acknowledged" });
  });

  it("keeps a refused message refused through a later delivered event", () => {
    const projection = new AgentMessageProjection();
    projection.apply(sent);
    projection.apply(refusedEvent("unauthorized"));
    projection.apply(deliveredEvent());
    expect(projection.lookup(String(sent.messageId))).toMatchObject({
      state: "refused",
      refuseReason: "unauthorized",
    });
  });

  it("keeps a message refused before admission, shows it to its sender's readers only, and rebuilds it from a replay", () => {
    const early = {
      kind: "message-refused",
      messageId: "10000000-0000-4000-8000-0000000000e1",
      correlationId: "20000000-0000-4000-8000-0000000000e1",
      refuseReason: "unauthorized",
      senderThreadId: "code-0000-0000-4000-8000-00000000000a",
      recipientThreadId: "code-0000-0000-4000-8000-0000000000ff",
      occurredAt: "2026-09-10T12:05:00.000Z",
    } as AgentMessageRefused;
    const withoutEndpoints = {
      ...early,
      messageId: "10000000-0000-4000-8000-0000000000e2",
    } as AgentMessageRefused;
    delete (withoutEndpoints as { senderThreadId?: unknown }).senderThreadId;
    delete (withoutEndpoints as { recipientThreadId?: unknown }).recipientThreadId;

    const projection = new AgentMessageProjection();
    const status = hydrateAgentMessageProjectionFromJournal({
      replay: () =>
        [early, early, withoutEndpoints].map((payload, index) => ({
          globalSequence: index + 1,
          aggregateType: AGENT_MESSAGE_AGGREGATE,
          eventName: "agent.message-refused@1",
          eventVersion: 1,
          payload,
        })),
      projection,
    });

    expect(status).toBe("ok");
    // The replayed duplicate counts once, and a refusal an earlier host
    // journaled without its endpoints has nobody to show it to.
    const facts = projection.messagingFacts(8);
    expect(facts.refused).toBe(1);
    expect(facts.recent).toEqual([
      {
        messageId: early.messageId,
        senderThreadId: early.senderThreadId,
        recipientThreadId: early.recipientThreadId,
        state: "refused",
        refuseReason: "unauthorized",
        occurredAt: early.occurredAt,
      },
    ]);
    // A reader who may not open the sender sees nothing of it, not even a count.
    const hidden = projection.messagingFacts(8, 20, () => false);
    expect(hidden).toMatchObject({ refused: 0, recent: [] });
    expect(projection.senderThreadIds()).toEqual(new Set([String(early.senderThreadId)]));
    // Purging the thread it names forgets it.
    projection.forgetForThread(String(early.senderThreadId));
    expect(projection.messagingFacts(8).refused).toBe(0);
  });

  it("keeps only the newest refusals of a sender, and still counts the rest", () => {
    const projection = new AgentMessageProjection();
    const total = MAX_EARLY_REFUSALS_PER_SENDER + 25;
    for (let index = 0; index < total; index += 1) {
      projection.apply({
        kind: "message-refused",
        messageId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        correlationId: "20000000-0000-4000-8000-0000000000e1",
        refuseReason: "policy",
        senderThreadId: "code-0000-0000-4000-8000-00000000000a",
        recipientThreadId: `code-0000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        occurredAt: new Date(Date.UTC(2026, 8, 10, 12, 0, index)).toISOString(),
      } as AgentMessageRefused);
    }

    const facts = projection.messagingFacts(8, 1000);
    expect(facts.refused).toBe(total);
    expect(facts.recent).toHaveLength(MAX_EARLY_REFUSALS_PER_SENDER);
    // The newest are the ones kept.
    expect(facts.recent[0]?.recipientThreadId).toBe(
      `code-0000-0000-4000-8000-${String(total - 1).padStart(12, "0")}`,
    );
  });

  it("orders settled messages and early refusals together, newest first", () => {
    const projection = new AgentMessageProjection();
    projection.apply(sent);
    projection.apply(refusedEvent("recipient-terminal"));
    projection.apply({
      kind: "message-refused",
      messageId: "10000000-0000-4000-8000-0000000000e3",
      correlationId: "20000000-0000-4000-8000-0000000000e3",
      refuseReason: "policy",
      senderThreadId: sent.senderThreadId,
      recipientThreadId: sent.recipientThreadId,
      occurredAt: "2026-09-10T12:00:09.000Z",
    } as AgentMessageRefused);
    expect(projection.messagingFacts(8).recent.map((entry) => entry.refuseReason)).toEqual([
      "policy",
      "recipient-terminal",
    ]);
  });

  it("forgets a purged thread's messages in both directions and names the bodies to purge", () => {
    const projection = new AgentMessageProjection();
    projection.apply(sent);
    projection.apply({
      ...sent,
      messageId: "10000000-0000-4000-8000-000000000002",
      recipientThreadId: sent.senderThreadId,
    } as AgentMessageSent);
    const forgotten = projection.forgetForThread(String(sent.senderThreadId));
    expect(forgotten).toHaveLength(2);
    expect(projection.lookup(String(sent.messageId))).toBeUndefined();
    expect(projection.lookup("10000000-0000-4000-8000-000000000002")).toBeUndefined();
  });
});

describe("the agent message body store", () => {
  it("stores a bounded body under an opaque token and reads it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-message-bodies-"));
    try {
      const store = new AgentMessageBodyStore(root);
      const stored = await store.write("Hello from a sibling thread.");
      if (stored.status !== "stored") throw new Error("The store refused a bounded body.");
      expect(stored.byteLength).toBe(
        new TextEncoder().encode("Hello from a sibling thread.").length,
      );
      expect(await store.read(stored.contentReference)).toBe("Hello from a sibling thread.");
      expect(stored.contentReference.startsWith("am-")).toBe(true);
      // The file name is the token itself: it names nothing about the thread.
      expect(await readFile(join(root, `${stored.contentReference}.txt`), "utf8")).toBe(
        "Hello from a sibling thread.",
      );
      await store.forget(stored.contentReference);
      expect(await store.read(stored.contentReference)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a body past the bound instead of truncating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-message-bodies-"));
    try {
      const store = new AgentMessageBodyStore(root);
      expect(await store.write("x".repeat(65_537))).toEqual({
        status: "refused",
        reason: "oversize",
      });
      expect(await store.write("")).toEqual({ status: "refused", reason: "oversize" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("after a restart keeps only the bodies of waiting messages and counts them against the budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-message-bodies-"));
    try {
      const earlier = new AgentMessageBodyStore(root);
      const waiting = await earlier.write("w".repeat(40_000));
      const settled = await earlier.write("An already delivered handoff.");
      if (waiting.status !== "stored" || settled.status !== "stored") {
        throw new Error("The store refused a bounded body.");
      }
      await writeFile(join(root, "notes.txt"), "Not a message body.", "utf8");

      // A new process starts with no count of what the last one left on disk.
      const store = new AgentMessageBodyStore(root, { maxTotalBytes: 65_536 });
      await store.retainOnly(new Set([waiting.contentReference]));

      expect(await store.read(waiting.contentReference)).toBe("w".repeat(40_000));
      expect(await store.read(settled.contentReference)).toBeUndefined();
      // A file the store did not write is not its to delete.
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("Not a message body.");
      // The waiting body still holds its share of the budget, and gives it
      // back once its message settles.
      expect(await store.write("x".repeat(40_000))).toEqual({
        status: "refused",
        reason: "oversize",
      });
      await store.forget(waiting.contentReference);
      expect(await store.write("x".repeat(40_000))).toMatchObject({ status: "stored" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to read a reference that could name a path outside the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-message-bodies-"));
    try {
      const store = new AgentMessageBodyStore(root);
      expect(await store.read("../../etc/passwd")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
