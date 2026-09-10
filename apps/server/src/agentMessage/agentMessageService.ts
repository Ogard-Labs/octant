import {
  AGENT_MESSAGE_AGGREGATE,
  AGENT_MESSAGE_EVENT_NAMES,
  AggregateVersion,
  AgentMessageId,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type AgentMessageEndpointId,
  type AgentMessageRefuseReason,
  type OctantMode,
} from "@octant/contracts";
import { Schema } from "effect";
import { decideAgentMessageDelivery, decideAgentMessageDeliveryAtRecheck } from "@octant/domain";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import {
  ConcurrencyConflict,
  EventPayloadInvalid,
  JournalInputInvalid,
} from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { AgentMessageProjection } from "./agentMessageProjection";
import type { AgentMessageBodyStore } from "./agentMessageBodyStore";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);

const MAX_APPEND_ATTEMPTS = 3;
const MAX_RECIPIENTS_PER_SEND = 4;

/**
 * What the server knows about one endpoint a petition names. The resolver is
 * composed from the thread authorities the host already owns; an endpoint it
 * cannot resolve fails closed as `unauthorized` — foreign hosts, unpaired
 * devices, and unknown ids are not addressable.
 */
export interface AgentMessageEndpointFacts {
  readonly mode: OctantMode;
  readonly terminal: boolean;
}

export type AgentMessageEndpointResolver = (
  threadId: string,
) => AgentMessageEndpointFacts | undefined;

export interface AgentMessageRecipient {
  readonly threadId: AgentMessageEndpointId;
  readonly runId?: AgentMessageEndpointId;
}

export interface AgentMessageSendRequest {
  readonly senderThreadId: AgentMessageEndpointId;
  readonly senderRunId?: AgentMessageEndpointId;
  readonly recipients: ReadonlyArray<AgentMessageRecipient>;
  readonly body: string;
}

export type AgentMessageSendOutcome =
  | {
      readonly status: "delivered";
      readonly messageId: AgentMessageId;
      readonly recipientThreadId: AgentMessageEndpointId;
    }
  | {
      readonly status: "refused";
      readonly messageId: AgentMessageId;
      readonly recipientThreadId: AgentMessageEndpointId;
      readonly reason: AgentMessageRefuseReason;
      readonly message: string;
    };

export interface AgentMessageServiceOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: unknown;
  readonly projection: AgentMessageProjection;
  readonly bodyStore: AgentMessageBodyStore;
  readonly resolveEndpoint: AgentMessageEndpointResolver;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  /** Modes the admitting principal's Open scope covers for both endpoints. */
  readonly openModes: ReadonlyArray<OctantMode>;
}

export class AgentMessageDeliveryRefused extends Error {
  constructor(
    readonly reason: "policy" | "oversize",
    message: string,
  ) {
    super(message);
    this.name = "AgentMessageDeliveryRefused";
  }
}

/**
 * Journaled agent-to-agent delivery (decision 0063).
 *
 * The host alone admits, clamps, journals, and delivers. `sent` is admission
 * only; before `delivered` the service rechecks the sender's live grant and
 * the recipient's lifecycle, so grant revocation or recipient closure between
 * the two events refuses delivery and admission never becomes an irrevocable
 * delivery right. A delivered body is untrusted external content: the
 * recipient thread journals `thread.external-content-ingested@1` with an
 * opaque source label and the body is framed as data there — delivery grants
 * no authority, clears no taint, and starts no turn.
 */
export class AgentMessageService {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: ReturnType<typeof decodeActor>;
  readonly #projection: AgentMessageProjection;
  readonly #bodyStore: AgentMessageBodyStore;
  readonly #resolveEndpoint: AgentMessageEndpointResolver;
  readonly #recordExternalContentIngestion: AgentMessageServiceOptions["recordExternalContentIngestion"];
  readonly #openModes: ReadonlySet<OctantMode>;

  constructor(options: AgentMessageServiceOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
    this.#projection = options.projection;
    this.#bodyStore = options.bodyStore;
    this.#resolveEndpoint = options.resolveEndpoint;
    this.#recordExternalContentIngestion = options.recordExternalContentIngestion;
    this.#openModes = new Set(options.openModes);
  }

  async send(request: AgentMessageSendRequest): Promise<ReadonlyArray<AgentMessageSendOutcome>> {
    if (request.recipients.length < 1 || request.recipients.length > MAX_RECIPIENTS_PER_SEND) {
      throw new AgentMessageDeliveryRefused(
        "policy",
        `An agent message may name at most ${String(MAX_RECIPIENTS_PER_SEND)} recipients.`,
      );
    }
    const messageId = Schema.decodeUnknownSync(AgentMessageId)(this.#uuid());
    const correlationId = decodeCorrelationId(this.#uuid());
    const outcomes: AgentMessageSendOutcome[] = [];
    for (const recipient of request.recipients) {
      outcomes.push(await this.#deliver(request, messageId, correlationId, recipient));
    }
    return outcomes;
  }

  /** The recipient acknowledges a delivered message; replay applies it idempotently. */
  async acknowledge(input: { readonly messageId: string }): Promise<void> {
    const record = this.#projection.lookup(input.messageId);
    if (record === undefined || record.state !== "delivered") return;
    await this.#appendJournaled(
      AGENT_MESSAGE_EVENT_NAMES.acknowledged,
      {
        kind: "message-acknowledged",
        messageId: record.messageId,
        correlationId: record.correlationId,
        occurredAt: this.#clock(),
      },
      String(record.messageId),
    );
  }

  /** Purges bodies and records for a purged thread; replay never revives them. */
  async purgeThread(threadId: string): Promise<void> {
    const forgotten = this.#projection.forgetForThread(threadId);
    for (const record of forgotten) {
      await this.#bodyStore.forget(record.bodyReference.contentReference);
    }
  }

  async #deliver(
    request: AgentMessageSendRequest,
    messageId: AgentMessageId,
    correlationId: string,
    recipient: AgentMessageRecipient,
  ): Promise<AgentMessageSendOutcome> {
    const refusal = this.#decide(request, recipient.threadId);
    if (refusal !== undefined) {
      await this.#journalRefused(messageId, correlationId, refusal.reason);
      return {
        status: "refused",
        messageId,
        recipientThreadId: recipient.threadId,
        reason: refusal.reason,
        message: refusal.message,
      };
    }

    const stored = await this.#bodyStore.write(request.body);
    if (stored.status === "refused") {
      // The policy bounds were already checked; the store refuses only when
      // its own disk budget is exhausted, and that is the same honest refusal.
      await this.#journalRefused(messageId, correlationId, "oversize");
      return {
        status: "refused",
        messageId,
        recipientThreadId: recipient.threadId,
        reason: "oversize",
        message: "The host could not store the message body.",
      };
    }

    const bodyReference = {
      contentReference: stored.contentReference,
      byteLength: stored.byteLength,
    };
    await this.#appendJournaled(
      AGENT_MESSAGE_EVENT_NAMES.sent,
      {
        kind: "message-sent",
        messageId,
        correlationId,
        senderThreadId: request.senderThreadId,
        ...(request.senderRunId === undefined ? {} : { senderRunId: request.senderRunId }),
        recipientThreadId: recipient.threadId,
        ...(recipient.runId === undefined ? {} : { recipientRunId: recipient.runId }),
        bodyReference,
        occurredAt: this.#clock(),
      },
      String(messageId),
    );

    // Delivery-time recheck: admission never created an irrevocable right.
    const recheck = this.#recheck(request, recipient.threadId);
    if (recheck !== undefined) {
      await this.#journalRefused(messageId, correlationId, recheck.reason);
      return {
        status: "refused",
        messageId,
        recipientThreadId: recipient.threadId,
        reason: recheck.reason,
        message: recheck.message,
      };
    }

    await this.#appendJournaled(
      AGENT_MESSAGE_EVENT_NAMES.delivered,
      {
        kind: "message-delivered",
        messageId,
        correlationId,
        recipientThreadId: recipient.threadId,
        ...(recipient.runId === undefined ? {} : { recipientRunId: recipient.runId }),
        bodyReference,
        occurredAt: this.#clock(),
      },
      String(messageId),
    );
    // The body is data on the recipient thread from this moment: the taint
    // record is what a later turn's framing reads, and it references the body
    // opaquely — the label names the channel, never the instruction.
    this.#recordExternalContentIngestion({
      threadId: recipient.threadId,
      provenance: { origin: "external-content", sourceLabel: "agent-message" },
      contentReference: stored.contentReference,
      correlationId,
      authorized: true,
    });
    return { status: "delivered", messageId, recipientThreadId: recipient.threadId };
  }

  #decide(
    request: AgentMessageSendRequest,
    recipientThreadId: AgentMessageEndpointId,
  ):
    | {
        readonly status: "refused";
        readonly reason: AgentMessageRefuseReason;
        readonly message: string;
      }
    | undefined {
    const recipientEndpoint = this.#resolveEndpoint(String(recipientThreadId));
    // An endpoint this host cannot resolve is not addressable, which is an
    // authorization refusal — not a lifecycle fact about a known recipient.
    if (recipientEndpoint === undefined) {
      return {
        status: "refused",
        reason: "unauthorized",
        message: "The recipient thread is not addressable on this host.",
      };
    }
    const senderEndpoint = this.#resolveEndpoint(String(request.senderThreadId));
    const decision = decideAgentMessageDelivery({
      sender: {
        openModes: this.#openModes,
        messagingAdmitted: senderEndpoint !== undefined && !senderEndpoint.terminal,
        // A petition from a real thread is one hop from the admitting
        // principal's reach; the bound exists for hierarchies, not this one.
        depth: 1,
        openInFlight: this.#projection.countInFlightForSender(String(request.senderThreadId)),
      },
      recipient: { mode: recipientEndpoint.mode, terminal: recipientEndpoint.terminal },
      bodyByteLength: new TextEncoder().encode(request.body).length,
      recipientCount: request.recipients.length,
    });
    return decision.status === "refused" ? decision : undefined;
  }

  #recheck(
    request: AgentMessageSendRequest,
    recipientThreadId: AgentMessageEndpointId,
  ):
    | {
        readonly status: "refused";
        readonly reason: AgentMessageRefuseReason;
        readonly message: string;
      }
    | undefined {
    const recipientEndpoint = this.#resolveEndpoint(String(recipientThreadId));
    if (recipientEndpoint === undefined) {
      return {
        status: "refused",
        reason: "unauthorized",
        message: "The recipient thread is no longer addressable on this host.",
      };
    }
    const senderEndpoint = this.#resolveEndpoint(String(request.senderThreadId));
    const decision = decideAgentMessageDeliveryAtRecheck({
      senderMessagingAdmitted: senderEndpoint !== undefined && !senderEndpoint.terminal,
      recipientMode: recipientEndpoint.mode,
      senderOpenModes: this.#openModes,
      recipientTerminal: recipientEndpoint.terminal,
    });
    return decision.status === "refused" ? decision : undefined;
  }

  async #journalRefused(
    messageId: AgentMessageId,
    correlationId: string,
    reason: "unauthorized" | "depth-exceeded" | "recipient-terminal" | "oversize" | "policy",
  ): Promise<void> {
    await this.#appendJournaled(
      AGENT_MESSAGE_EVENT_NAMES.refused,
      {
        kind: "message-refused",
        messageId,
        correlationId,
        refuseReason: reason,
        occurredAt: this.#clock(),
      },
      String(messageId),
    );
  }

  async #appendJournaled(eventName: string, payload: unknown, aggregateId: string): Promise<void> {
    const decodedName = decodeEventName(eventName);
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, AGENT_MESSAGE_AGGREGATE, aggregateId),
      );
      try {
        this.#journal.append({
          aggregate: { aggregateType: AGENT_MESSAGE_AGGREGATE, aggregateId },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: decodedName,
              eventVersion: 1,
              correlationId: decodeCorrelationId(this.#uuid()),
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload,
            },
          ],
        });
        // The in-process projection follows its own journal the way a restart
        // replays it, so in-flight counts and acknowledgements see the write.
        this.#projection.apply(payload as Parameters<AgentMessageProjection["apply"]>[0]);
        return;
      } catch (error) {
        if (error instanceof ConcurrencyConflict) continue;
        if (error instanceof JournalInputInvalid || error instanceof EventPayloadInvalid) {
          throw new AgentMessageDeliveryRefused("policy", "The agent message event is invalid.");
        }
        throw error;
      }
    }
    throw new AgentMessageDeliveryRefused(
      "policy",
      "The agent message event could not be journaled after repeated conflicts.",
    );
  }
}
