import {
  AGENT_MESSAGE_AGGREGATE,
  decodeAgentMessageAcknowledged,
  decodeAgentMessageDelivered,
  decodeAgentMessageRefused,
  decodeAgentMessageSent,
  type AgentMessageAcknowledged,
  type AgentMessageBodyReference,
  type AgentMessageDelivered,
  type AgentMessageEndpointId,
  type AgentMessageId,
  type AgentMessageRefused,
  type AgentMessageRefuseReason,
  type AgentMessageSent,
} from "@octant/contracts";
import {
  hydrateJournalProjection,
  type JournalHydrationStatus,
} from "../persistence/journalHydration";

/**
 * Where one agent message stands. `in-flight` is the only state between the
 * journaled admission and its journaled end: admission never creates an
 * irrevocable delivery right, so the state after `sent` is "the host promised
 * to recheck", nothing stronger.
 */
export type AgentMessageState = "in-flight" | "delivered" | "refused" | "acknowledged";

export interface AgentMessageRecord {
  readonly messageId: AgentMessageId;
  readonly correlationId: string;
  readonly senderThreadId: AgentMessageEndpointId;
  readonly senderRunId?: AgentMessageEndpointId;
  readonly recipientThreadId: AgentMessageEndpointId;
  readonly recipientRunId?: AgentMessageEndpointId;
  readonly bodyReference: AgentMessageBodyReference;
  readonly state: AgentMessageState;
  readonly refuseReason?: AgentMessageRefuseReason;
}

/**
 * Rebuildable in-memory projection of the `agent-message` aggregate.
 *
 * Duplicate or out-of-order journaled events apply idempotently: a repeated
 * `sent` never duplicates the record, a `delivered` after a `refused` is
 * ignored (admission never revives a refusal), and replay rebuilds in-flight
 * and refused messages exactly as they stood — without resurrecting bodies,
 * which live outside the journal and are purged with their threads.
 */
export class AgentMessageProjection {
  readonly #byMessage = new Map<string, AgentMessageRecord>();

  apply(
    event:
      | AgentMessageSent
      | AgentMessageDelivered
      | AgentMessageRefused
      | AgentMessageAcknowledged,
  ): void {
    if (event.kind === "message-sent") {
      const sent = decodeAgentMessageSent(event);
      const key = String(sent.messageId);
      if (this.#byMessage.has(key)) return;
      this.#byMessage.set(key, {
        messageId: sent.messageId,
        correlationId: String(sent.correlationId),
        senderThreadId: sent.senderThreadId,
        ...(sent.senderRunId === undefined ? {} : { senderRunId: sent.senderRunId }),
        recipientThreadId: sent.recipientThreadId,
        ...(sent.recipientRunId === undefined ? {} : { recipientRunId: sent.recipientRunId }),
        bodyReference: sent.bodyReference,
        state: "in-flight",
      });
      return;
    }
    if (event.kind === "message-delivered") {
      const delivered = decodeAgentMessageDelivered(event);
      const current = this.#byMessage.get(String(delivered.messageId));
      // A refusal is final: admission never creates an irrevocable delivery
      // right, so a late delivered event cannot un-refuse a message.
      if (current === undefined || current.state !== "in-flight") return;
      this.#byMessage.set(String(delivered.messageId), { ...current, state: "delivered" });
      return;
    }
    if (event.kind === "message-refused") {
      const refused = decodeAgentMessageRefused(event);
      const current = this.#byMessage.get(String(refused.messageId));
      if (current === undefined) return;
      if (current.state !== "in-flight" && current.state !== "refused") return;
      this.#byMessage.set(String(refused.messageId), {
        ...current,
        state: "refused",
        refuseReason: refused.refuseReason,
      });
      return;
    }
    const acknowledged = decodeAgentMessageAcknowledged(event);
    const current = this.#byMessage.get(String(acknowledged.messageId));
    if (current === undefined || current.state !== "delivered") return;
    this.#byMessage.set(String(acknowledged.messageId), { ...current, state: "acknowledged" });
  }

  lookup(messageId: string): AgentMessageRecord | undefined {
    return this.#byMessage.get(messageId);
  }

  countInFlightForSender(senderThreadId: string): number {
    let count = 0;
    for (const record of this.#byMessage.values()) {
      if (String(record.senderThreadId) === senderThreadId && record.state === "in-flight") {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Forgets messages whose sender or recipient thread was purged and returns
   * them, so the caller can purge the bodies those references name. Replay
   * after a purge never resurrects them: the purged aggregate's events no
   * longer exist, and a stale reference alone is not a body.
   */
  forgetForThread(threadId: string): ReadonlyArray<AgentMessageRecord> {
    const forgotten: AgentMessageRecord[] = [];
    for (const [key, record] of this.#byMessage) {
      if (
        String(record.senderThreadId) === threadId ||
        String(record.recipientThreadId) === threadId
      ) {
        this.#byMessage.delete(key);
        forgotten.push(record);
      }
    }
    return forgotten;
  }
}

export function hydrateAgentMessageProjectionFromJournal(input: {
  readonly replay: (cursor: {
    afterSequence: number;
    limit: number;
    aggregateType?: string;
  }) => ReadonlyArray<{
    readonly globalSequence: number;
    readonly aggregateType?: string;
    readonly eventName: string;
    readonly eventVersion: number;
    readonly payload: unknown;
  }>;
  readonly projection: AgentMessageProjection;
  readonly maxScan?: number;
}): JournalHydrationStatus {
  return hydrateJournalProjection({
    replay: input.replay,
    aggregateType: AGENT_MESSAGE_AGGREGATE,
    ...(input.maxScan === undefined ? {} : { maxScan: input.maxScan }),
    apply: (event) => {
      if (
        (event.aggregateType !== undefined && event.aggregateType !== AGENT_MESSAGE_AGGREGATE) ||
        event.eventVersion !== 1
      ) {
        return;
      }
      if (event.eventName === "agent.message-sent@1") {
        input.projection.apply(event.payload as AgentMessageSent);
      } else if (event.eventName === "agent.message-delivered@1") {
        input.projection.apply(event.payload as AgentMessageDelivered);
      } else if (event.eventName === "agent.message-refused@1") {
        input.projection.apply(event.payload as AgentMessageRefused);
      } else if (event.eventName === "agent.message-acknowledged@1") {
        input.projection.apply(event.payload as AgentMessageAcknowledged);
      }
    },
  });
}
