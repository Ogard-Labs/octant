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
  /** When the record last moved. */
  readonly occurredAt?: string;
}

/**
 * How many refusals made before admission the projection keeps for one
 * sender. Older ones are counted but no longer listed, so a thread that loops
 * on a refused call cannot grow the host's memory or the cost of each read.
 */
export const MAX_EARLY_REFUSALS_PER_SENDER = 50;

/**
 * A message the host refused before admitting it: no `sent` event, no stored
 * body, only the refusal and the endpoints it names. It is a settled fact for
 * the sender, shown beside the messages that were admitted and refused later.
 */
export interface AgentMessageEarlyRefusal {
  readonly messageId: AgentMessageId;
  readonly senderThreadId: AgentMessageEndpointId;
  readonly recipientThreadId: AgentMessageEndpointId;
  readonly refuseReason: AgentMessageRefuseReason;
  readonly occurredAt: string;
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
  /** By sender, each sender's newest refusals in journal order. */
  readonly #refusedBeforeAdmission = new Map<
    string,
    { readonly records: Map<string, AgentMessageEarlyRefusal>; evicted: number }
  >();

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
        occurredAt: sent.occurredAt,
      });
      return;
    }
    if (event.kind === "message-delivered") {
      const delivered = decodeAgentMessageDelivered(event);
      const current = this.#byMessage.get(String(delivered.messageId));
      // A refusal is final: admission never creates an irrevocable delivery
      // right, so a late delivered event cannot un-refuse a message.
      if (current === undefined || current.state !== "in-flight") return;
      this.#byMessage.set(String(delivered.messageId), {
        ...current,
        state: "delivered",
        occurredAt: delivered.occurredAt,
      });
      return;
    }
    if (event.kind === "message-refused") {
      const refused = decodeAgentMessageRefused(event);
      const current = this.#byMessage.get(String(refused.messageId));
      if (current === undefined) {
        // Refused before it was admitted. A refusal journaled without its
        // endpoints (an earlier host's) has nobody to show it to and is
        // left out; one that names them is a settled fact, kept once.
        const key = String(refused.messageId);
        if (refused.senderThreadId !== undefined && refused.recipientThreadId !== undefined) {
          const sender = String(refused.senderThreadId);
          let entry = this.#refusedBeforeAdmission.get(sender);
          if (entry === undefined) {
            entry = { records: new Map(), evicted: 0 };
            this.#refusedBeforeAdmission.set(sender, entry);
          }
          if (!entry.records.has(key)) {
            entry.records.set(key, {
              messageId: refused.messageId,
              senderThreadId: refused.senderThreadId,
              recipientThreadId: refused.recipientThreadId,
              refuseReason: refused.refuseReason,
              occurredAt: refused.occurredAt,
            });
            if (entry.records.size > MAX_EARLY_REFUSALS_PER_SENDER) {
              const oldest = entry.records.keys().next();
              if (!oldest.done) entry.records.delete(oldest.value);
              entry.evicted += 1;
            }
          }
        }
        return;
      }
      if (current.state !== "in-flight" && current.state !== "refused") return;
      this.#byMessage.set(String(refused.messageId), {
        ...current,
        state: "refused",
        refuseReason: refused.refuseReason,
        occurredAt: refused.occurredAt,
      });
      return;
    }
    const acknowledged = decodeAgentMessageAcknowledged(event);
    const current = this.#byMessage.get(String(acknowledged.messageId));
    if (current === undefined || current.state !== "delivered") return;
    this.#byMessage.set(String(acknowledged.messageId), {
      ...current,
      state: "acknowledged",
      occurredAt: acknowledged.occurredAt,
    });
  }

  lookup(messageId: string): AgentMessageRecord | undefined {
    return this.#byMessage.get(messageId);
  }

  countInFlightForSender(senderThreadId: string): number {
    return this.openForSender(senderThreadId).length;
  }

  /** The messages this sender has admitted that no turn has carried yet. */
  openForSender(senderThreadId: string): ReadonlyArray<AgentMessageRecord> {
    return this.inFlight().filter((record) => String(record.senderThreadId) === senderThreadId);
  }

  /**
   * The messages waiting for this thread's next turn, oldest first. Only an
   * in-flight message waits: one journaled `delivered` is settled, including
   * every message an earlier host journaled as delivered without a turn ever
   * carrying it, and is never offered again.
   */
  awaitingRecipient(recipientThreadId: string): ReadonlyArray<AgentMessageRecord> {
    return this.inFlight().filter(
      (record) => String(record.recipientThreadId) === recipientThreadId,
    );
  }

  /** Every admitted message still waiting, in the order the journal admitted them. */
  inFlight(): ReadonlyArray<AgentMessageRecord> {
    return [...this.#byMessage.values()].filter((record) => record.state === "in-flight");
  }

  /** Every thread that has sent a message the facts below could describe. */
  senderThreadIds(): ReadonlySet<string> {
    const senders = new Set<string>();
    for (const record of this.#byMessage.values()) senders.add(String(record.senderThreadId));
    for (const sender of this.#refusedBeforeAdmission.keys()) senders.add(sender);
    return senders;
  }

  /**
   * The host's messaging facts for the bounds view: statuses only, never
   * bodies, newest first, bounded to what the view states. `visibleSender`
   * keeps the view to messages whose sender thread the reader may open, so a
   * count never reaches past what the reader could already see.
   */
  messagingFacts(
    maxOpenInFlightPerSender: number,
    limit = 20,
    visibleSender: (senderThreadId: string) => boolean = () => true,
  ): {
    readonly openInFlight: number;
    readonly maxOpenInFlightPerSender: number;
    readonly delivered: number;
    readonly refused: number;
    readonly recent: ReadonlyArray<{
      readonly messageId: string;
      readonly senderThreadId: string;
      readonly recipientThreadId: string;
      readonly state: AgentMessageState;
      readonly refuseReason?: AgentMessageRefuseReason;
      readonly occurredAt?: string;
    }>;
  } {
    let openInFlight = 0;
    let delivered = 0;
    let refused = 0;
    const settled: Array<{
      readonly messageId: string;
      readonly senderThreadId: string;
      readonly recipientThreadId: string;
      readonly state: AgentMessageState;
      readonly refuseReason?: AgentMessageRefuseReason;
      readonly occurredAt?: string;
    }> = [];
    for (const record of this.#byMessage.values()) {
      if (!visibleSender(String(record.senderThreadId))) continue;
      if (record.state === "in-flight") {
        openInFlight += 1;
        continue;
      }
      if (record.state === "refused") refused += 1;
      else delivered += 1;
      settled.push({
        messageId: String(record.messageId),
        senderThreadId: String(record.senderThreadId),
        recipientThreadId: String(record.recipientThreadId),
        state: record.state,
        ...(record.refuseReason === undefined ? {} : { refuseReason: record.refuseReason }),
        ...(record.occurredAt === undefined ? {} : { occurredAt: record.occurredAt }),
      });
    }
    for (const [sender, entry] of this.#refusedBeforeAdmission) {
      if (!visibleSender(sender)) continue;
      // Refusals past the kept ones still count: the total stays what the host
      // refused, though only the newest are listed.
      refused += entry.evicted;
      for (const refusal of entry.records.values()) {
        refused += 1;
        settled.push({
          messageId: String(refusal.messageId),
          senderThreadId: String(refusal.senderThreadId),
          recipientThreadId: String(refusal.recipientThreadId),
          state: "refused",
          refuseReason: refusal.refuseReason,
          occurredAt: refusal.occurredAt,
        });
      }
    }
    // In-flight messages carry no settled time of their own; the most recent
    // settled statuses are what the bounds view can state. The sort is stable,
    // so messages that settled in the same instant keep their journal order.
    settled.sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? ""));
    return {
      openInFlight,
      maxOpenInFlightPerSender,
      delivered,
      refused,
      recent: settled.slice(-limit).reverse(),
    };
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
    // A refusal that never held a body has nothing to purge, but it names the
    // thread, so it goes with it.
    this.#refusedBeforeAdmission.delete(threadId);
    for (const [sender, entry] of this.#refusedBeforeAdmission) {
      for (const [key, refusal] of entry.records) {
        if (String(refusal.recipientThreadId) === threadId) entry.records.delete(key);
      }
      if (entry.records.size === 0 && entry.evicted === 0) {
        this.#refusedBeforeAdmission.delete(sender);
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
