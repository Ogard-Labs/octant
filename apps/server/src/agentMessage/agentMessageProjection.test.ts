import { mkdtemp, readFile, rm } from "node:fs/promises";
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
