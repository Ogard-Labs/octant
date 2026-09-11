import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { EventActor } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { AgentMessageProjection } from "./agentMessageProjection";
import { AgentMessageBodyStore } from "./agentMessageBodyStore";
import {
  AgentMessageDeliveryRefused,
  AgentMessageService,
  type AgentMessageEndpointResolver,
} from "./agentMessageService";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const actor = decodeActor({
  kind: "local-user",
  actorId: "00000000-0000-4000-8000-000000000001",
});

const senderThreadId = decodeEndpoint("chat-0000-0000-4000-8000-00000000000a");
const recipientThreadId = decodeEndpoint("code-0000-0000-4000-8000-00000000000b");

function decodeEndpoint(value: string) {
  return value as never;
}

function connection() {
  return {
    prepare: () => ({
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
    }),
    exec: () => undefined,
    pragma: () => undefined,
    transaction: (body: () => unknown) => body,
    close: () => undefined,
  } as never;
}

function journal(events: Array<{ readonly eventName: string; readonly payload: unknown }>) {
  return {
    append: (input: {
      readonly events: ReadonlyArray<{ eventName: string; payload: unknown }>;
    }) => {
      for (const event of input.events) events.push(event);
    },
  };
}

interface FixtureOptions {
  readonly resolveEndpoint?: AgentMessageEndpointResolver;
  readonly recordIngestion?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const events: Array<{ readonly eventName: string; readonly payload: unknown }> = [];
  const ingested: Array<{ readonly threadId: unknown; readonly contentReference: unknown }> = [];
  const root = join("/tmp", `octant-agent-message-test-${randomUUID()}`);
  const projection = new AgentMessageProjection();
  const service = new AgentMessageService({
    journal: journal(events) as never,
    connection: connection(),
    uuid: randomUUID,
    clock: () => "2026-09-10T12:00:00.000Z",
    actor,
    projection,
    bodyStore: new AgentMessageBodyStore(root),
    resolveEndpoint:
      options.resolveEndpoint ?? (() => ({ mode: "code" as const, terminal: false })),
    recordExternalContentIngestion: (input) => {
      ingested.push({ threadId: input.threadId, contentReference: input.contentReference });
      return {
        kind: "recorded",
        taint: { externalContentIngested: true, ingestedSources: ["agent-message"] },
      };
    },
    openModes: ["chat", "work", "code"],
  });
  return { service, events, ingested, projection, root };
}

describe("the agent message delivery service", () => {
  it("admits, journals the send, delivers, and taints the recipient as external content", async () => {
    const { service, events, ingested } = fixture();
    const outcomes = await service.send({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Handoff: CI on the branch head is green.",
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "delivered", recipientThreadId });
    const names = events.map((event) => event.eventName);
    expect(names).toEqual(["agent.message-sent@1", "agent.message-delivered@1"]);
    const sentPayload = events[0]!.payload as {
      readonly bodyReference: { readonly byteLength: number };
    };
    expect(sentPayload.bodyReference.byteLength).toBe(
      new TextEncoder().encode("Handoff: CI on the branch head is green.").length,
    );
    // The delivered body is untrusted data on the recipient thread: the
    // delivery journals the ingestion with an opaque label, and nothing else.
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({ threadId: recipientThreadId });
  });

  it("refuses an endpoint this host cannot resolve and journals the refusal", async () => {
    const { service, events, ingested } = fixture({
      resolveEndpoint: (threadId) =>
        String(threadId) === String(senderThreadId) ? { mode: "chat", terminal: false } : undefined,
    });
    const outcomes = await service.send({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Any body.",
    });

    expect(outcomes[0]).toMatchObject({ status: "refused", reason: "unauthorized" });
    expect(events.map((event) => event.eventName)).toEqual(["agent.message-refused@1"]);
    expect(ingested).toHaveLength(0);
  });

  it("refuses a recipient whose mode the admitting principal cannot open", async () => {
    const events: Array<{ readonly eventName: string; readonly payload: unknown }> = [];
    const narrowed = new AgentMessageService({
      journal: journal(events) as never,
      connection: connection(),
      uuid: randomUUID,
      clock: () => "2026-09-10T12:00:00.000Z",
      actor,
      projection: new AgentMessageProjection(),
      bodyStore: new AgentMessageBodyStore(
        join("/tmp", `octant-agent-message-test-${randomUUID()}`),
      ),
      resolveEndpoint: (threadId) =>
        String(threadId) === String(senderThreadId)
          ? { mode: "chat" as const, terminal: false }
          : { mode: "code" as const, terminal: false },
      recordExternalContentIngestion: () => ({
        kind: "recorded",
        taint: { externalContentIngested: true, ingestedSources: [] },
      }),
      // The admitting principal's Open scope covers chat alone, so a Code
      // recipient is not addressable by this sender no matter what it names.
      openModes: ["chat"],
    });
    const outcomes = await narrowed.send({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Any body.",
    });
    expect(outcomes[0]).toMatchObject({ status: "refused", reason: "unauthorized" });
    expect(events.map((event) => event.eventName)).toEqual(["agent.message-refused@1"]);
  });

  it("rechecks the recipient at delivery time and refuses a recipient that closed", async () => {
    // The recipient is alive while the host admits the petition and is gone
    // by the time the host delivers — the recheck must catch exactly that.
    let recipientResolutions = 0;
    const { service, events, ingested } = fixture({
      resolveEndpoint: (threadId) => {
        if (String(threadId) === String(senderThreadId)) {
          return { mode: "chat" as const, terminal: false };
        }
        recipientResolutions += 1;
        return {
          mode: "code" as const,
          terminal: recipientResolutions > 1,
        };
      },
    });
    const outcomes = await service.send({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Any body.",
    });
    // The recheck runs after admission, so both the sent and the refused
    // events are journaled, and nothing was delivered or ingested.
    expect(outcomes[0]).toMatchObject({ status: "refused", reason: "recipient-terminal" });
    expect(events.map((event) => event.eventName)).toEqual([
      "agent.message-sent@1",
      "agent.message-refused@1",
    ]);
    expect(ingested).toHaveLength(0);
  });

  it("refuses a body past the host bound without storing or delivering", async () => {
    const { service, events, ingested } = fixture();
    const outcomes = await service.send({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "x".repeat(65_537),
    });
    expect(outcomes[0]).toMatchObject({ status: "refused", reason: "oversize" });
    expect(events.map((event) => event.eventName)).toEqual(["agent.message-refused@1"]);
    expect(ingested).toHaveLength(0);
  });

  it("refuses a petition that names no recipient", async () => {
    const { service } = fixture();
    await expect(
      service.send({ senderThreadId, recipients: [], body: "Any body." }),
    ).rejects.toMatchObject({ reason: "policy" });
  });

  it("acknowledges a delivered message once and ignores an unknown or refused one", async () => {
    const { service, events } = fixture();
    const [outcome] = await service.send({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Handoff.",
    });
    const messageId = String(outcome?.messageId);
    await service.acknowledge({ messageId });
    const acknowledged = events.filter(
      (event) => event.eventName === "agent.message-acknowledged@1",
    );
    expect(acknowledged).toHaveLength(1);

    await service.acknowledge({ messageId: "99999999-9999-4999-8999-999999999999" });
    expect(
      events.filter((event) => event.eventName === "agent.message-acknowledged@1"),
    ).toHaveLength(1);
  });

  it("purges a thread's bodies so replay cannot resurrect them", async () => {
    const { service, projection, root } = fixture();
    const [outcome] = await service.send({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Handoff.",
    });
    const bodyStore = new AgentMessageBodyStore(root);
    const record = projection.lookup(String(outcome?.messageId));
    expect(await bodyStore.read(record!.bodyReference.contentReference)).toBe("Handoff.");

    await service.purgeThread(String(recipientThreadId));
    expect(projection.lookup(String(outcome?.messageId))).toBeUndefined();
    expect(await bodyStore.read(record!.bodyReference.contentReference)).toBeUndefined();
  });

  it("rejects more recipients than one petition may name before journaling anything", async () => {
    const { service, events } = fixture();
    const recipients = Array.from({ length: 5 }, (_unused, index) => ({
      threadId: decodeEndpoint(`code-0000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    }));
    await expect(
      service.send({ senderThreadId, recipients, body: "Any body." }),
    ).rejects.toBeInstanceOf(AgentMessageDeliveryRefused);
    expect(events).toHaveLength(0);
  });
});
