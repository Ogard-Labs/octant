import { Schema } from "effect";
import { CorrelationId, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Structured agent-to-agent messages (decision 0063).
 *
 * Messaging is a server-owned capability, not a peer socket: a sender
 * petitions, the host admits, clamps, journals, and delivers. Every event
 * lives on the `agent-message` aggregate and requires a durable `messageId`,
 * so replay can rebuild in-flight and refused messages idempotently. Raw
 * bodies never enter the journal — events carry an opaque body reference and
 * a byte length only, the same discipline as ingested external content.
 */

export const AgentMessageId = Schema.UUID.pipe(Schema.brand("AgentMessageId"));
export type AgentMessageId = typeof AgentMessageId.Type;

/**
 * Opaque identity of a message endpoint: a real thread or AgentRun inside one
 * host, addressed by an id the caller already holds. The value rejects path
 * separators and URL schemes, so a server bug cannot turn an endpoint into a
 * host path or an authority URL.
 */
export const AgentMessageEndpointId = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter(
    (value) => !value.includes("\0") && !/[\\/]/.test(value) && !/^(file|https?):/i.test(value),
  ),
  Schema.brand("AgentMessageEndpointId"),
);
export type AgentMessageEndpointId = typeof AgentMessageEndpointId.Type;

/** How large one message body may be. Oversize petitions refuse, never truncate. */
export const MAX_AGENT_MESSAGE_BODY_BYTES = 65_536;

export const AgentMessageBodyReference = Schema.Struct({
  /** Opaque host-side reference to the stored body. Never the body itself. */
  contentReference: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(512),
    Schema.filter(
      (value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
    ),
  ),
  byteLength: Schema.Int.pipe(Schema.between(1, MAX_AGENT_MESSAGE_BODY_BYTES)),
}).annotations(strict);
export type AgentMessageBodyReference = typeof AgentMessageBodyReference.Type;

export const AgentMessageRefuseReason = Schema.Literal(
  "unauthorized",
  "depth-exceeded",
  "recipient-terminal",
  "oversize",
  "policy",
);
export type AgentMessageRefuseReason = typeof AgentMessageRefuseReason.Type;

export const AGENT_MESSAGE_AGGREGATE = "agent-message";

export const AGENT_MESSAGE_EVENT_NAMES = {
  sent: "agent.message-sent@1",
  delivered: "agent.message-delivered@1",
  refused: "agent.message-refused@1",
  acknowledged: "agent.message-acknowledged@1",
} as const;

export const AgentMessageSent = Schema.Struct({
  kind: Schema.Literal("message-sent"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  senderThreadId: AgentMessageEndpointId,
  senderRunId: Schema.optional(AgentMessageEndpointId),
  recipientThreadId: AgentMessageEndpointId,
  recipientRunId: Schema.optional(AgentMessageEndpointId),
  bodyReference: AgentMessageBodyReference,
  occurredAt: Schema.String,
}).annotations(strict);
export type AgentMessageSent = typeof AgentMessageSent.Type;

export const AgentMessageDelivered = Schema.Struct({
  kind: Schema.Literal("message-delivered"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  recipientThreadId: AgentMessageEndpointId,
  recipientRunId: Schema.optional(AgentMessageEndpointId),
  bodyReference: AgentMessageBodyReference,
  occurredAt: Schema.String,
}).annotations(strict);
export type AgentMessageDelivered = typeof AgentMessageDelivered.Type;

export const AgentMessageRefused = Schema.Struct({
  kind: Schema.Literal("message-refused"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  refuseReason: AgentMessageRefuseReason,
  occurredAt: Schema.String,
}).annotations(strict);
export type AgentMessageRefused = typeof AgentMessageRefused.Type;

export const AgentMessageAcknowledged = Schema.Struct({
  kind: Schema.Literal("message-acknowledged"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  occurredAt: Schema.String,
}).annotations(strict);
export type AgentMessageAcknowledged = typeof AgentMessageAcknowledged.Type;

export const decodeAgentMessageSent = Schema.decodeUnknownSync(AgentMessageSent);
export const decodeAgentMessageDelivered = Schema.decodeUnknownSync(AgentMessageDelivered);
export const decodeAgentMessageRefused = Schema.decodeUnknownSync(AgentMessageRefused);
export const decodeAgentMessageAcknowledged = Schema.decodeUnknownSync(AgentMessageAcknowledged);
export const decodeAgentMessageEndpointId = Schema.decodeUnknownSync(AgentMessageEndpointId);

const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

/** One message in the messaging bounds view: a status, never a body. */
export const AgentMessageStatusSummary = Schema.Struct({
  messageId: AgentMessageId,
  senderThreadId: AgentMessageEndpointId,
  recipientThreadId: AgentMessageEndpointId,
  state: Schema.Literal("in-flight", "delivered", "refused", "acknowledged"),
  refuseReason: Schema.optional(AgentMessageRefuseReason),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type AgentMessageStatusSummary = typeof AgentMessageStatusSummary.Type;

export const MAX_AGENT_MESSAGE_STATUS_SUMMARIES = 20;

/**
 * The host's messaging facts, in the bounds the policy admits: how many
 * messages are open in flight against the per-sender cap, and the most recent
 * statuses. Refuse reasons are values here so a stranded message is a fact a
 * renderer can state, never a silent gap.
 */
export const AgentMessageMessagingFacts = Schema.Struct({
  openInFlight: NonNegativeInt,
  maxOpenInFlightPerSender: NonNegativeInt,
  delivered: NonNegativeInt,
  refused: NonNegativeInt,
  recent: Schema.Array(AgentMessageStatusSummary).pipe(
    Schema.maxItems(MAX_AGENT_MESSAGE_STATUS_SUMMARIES),
  ),
}).annotations(strict);
export type AgentMessageMessagingFacts = typeof AgentMessageMessagingFacts.Type;

export const decodeAgentMessageMessagingFacts = Schema.decodeUnknownSync(
  AgentMessageMessagingFacts,
);
