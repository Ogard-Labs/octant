import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CorrelationId, UtcTimestamp } from "./events";

/**
 * Structured agent-to-agent messages.
 *
 * Messaging is a server-owned capability, not a peer socket: a sender
 * petitions, the host admits, clamps, journals, and delivers. Every event
 * lives on the `agent-message` aggregate and requires a durable `messageId`,
 * so replay can rebuild in-flight and refused messages idempotently. Raw
 * bodies never enter the journal — events carry an opaque body reference and
 * a byte length only, the same discipline as ingested external content.
 */

export const AgentMessageId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("AgentMessageId"),
);
export type AgentMessageId = typeof AgentMessageId.Type;

/**
 * Opaque identity of a message endpoint: a real thread or AgentRun inside one
 * host, addressed by an id the caller already holds. The value rejects path
 * separators and URL schemes, so a server bug cannot turn an endpoint into a
 * host path or an authority URL.
 */
export const AgentMessageEndpointId = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(128),
    Schema.makeFilter(
      (value) => !value.includes("\0") && !/[\\/]/.test(value) && !/^(file|https?):/i.test(value),
    ),
  ),
  Schema.brand("AgentMessageEndpointId"),
);
export type AgentMessageEndpointId = typeof AgentMessageEndpointId.Type;

/** How large one message body may be. Oversize petitions refuse, never truncate. */
export const MAX_AGENT_MESSAGE_BODY_BYTES = 65_536;

export const AgentMessageBodyReference = Schema.Struct({
  /** Opaque host-side reference to the stored body. Never the body itself. */
  contentReference: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(512),
    Schema.makeFilter(
      (value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
    ),
  ),
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_AGENT_MESSAGE_BODY_BYTES }),
  ),
});
export type AgentMessageBodyReference = typeof AgentMessageBodyReference.Type;

export const AgentMessageRefuseReason = Schema.Literals([
  "unauthorized",
  "depth-exceeded",
  "recipient-terminal",
  "oversize",
  "policy",
]);
export type AgentMessageRefuseReason = typeof AgentMessageRefuseReason.Type;

export const AGENT_MESSAGE_AGGREGATE = "agent-message";

export const AGENT_MESSAGE_EVENT_NAMES = {
  sent: "agent.message-sent@1",
  expired: "agent.message-expired@1",
  delivered: "agent.message-delivered@1",
  refused: "agent.message-refused@1",
  acknowledged: "agent.message-acknowledged@1",
} as const;

export const AgentMessageSent = Schema.Struct({
  /**
   * The deadline an earlier host recorded (24 hours after admission). A new
   * message has none and waits for a turn until it is carried, refused, or
   * its thread is purged (maintainer decision, 2026-11-21); a recorded
   * deadline still expires its message on replay.
   */
  expiresAt: Schema.optional(UtcTimestamp),
  kind: Schema.Literal("message-sent"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  senderThreadId: AgentMessageEndpointId,
  senderRunId: Schema.optional(AgentMessageEndpointId),
  recipientThreadId: AgentMessageEndpointId,
  recipientRunId: Schema.optional(AgentMessageEndpointId),
  bodyReference: AgentMessageBodyReference,
  occurredAt: Schema.String,
});
export type AgentMessageSent = typeof AgentMessageSent.Type;

export const AgentMessageDelivered = Schema.Struct({
  kind: Schema.Literal("message-delivered"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  recipientThreadId: AgentMessageEndpointId,
  recipientRunId: Schema.optional(AgentMessageEndpointId),
  bodyReference: AgentMessageBodyReference,
  occurredAt: Schema.String,
});
export type AgentMessageDelivered = typeof AgentMessageDelivered.Type;

export const AgentMessageRefused = Schema.Struct({
  kind: Schema.Literal("message-refused"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  refuseReason: AgentMessageRefuseReason,
  /**
   * The endpoints a refusal names. A message refused before it was admitted has
   * no `agent.message-sent@1` to say who sent it and to whom, so the refusal
   * carries them itself; without them a view could not show it. Refusals
   * journaled before these fields existed stay as journaled.
   */
  senderThreadId: Schema.optional(AgentMessageEndpointId),
  recipientThreadId: Schema.optional(AgentMessageEndpointId),
  occurredAt: Schema.String,
});
export type AgentMessageRefused = typeof AgentMessageRefused.Type;

export const AgentMessageExpired = Schema.Struct({
  kind: Schema.Literal("message-expired"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  occurredAt: UtcTimestamp,
});
export type AgentMessageExpired = typeof AgentMessageExpired.Type;
export const decodeAgentMessageExpired = Schema.decodeUnknownSync(
  AgentMessageExpired,
  STRICT_DECODE_OPTIONS,
);

export const AgentMessageAcknowledged = Schema.Struct({
  kind: Schema.Literal("message-acknowledged"),
  messageId: AgentMessageId,
  correlationId: CorrelationId,
  occurredAt: Schema.String,
});
export type AgentMessageAcknowledged = typeof AgentMessageAcknowledged.Type;

export const decodeAgentMessageSent = Schema.decodeUnknownSync(
  AgentMessageSent,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentMessageDelivered = Schema.decodeUnknownSync(
  AgentMessageDelivered,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentMessageRefused = Schema.decodeUnknownSync(
  AgentMessageRefused,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentMessageAcknowledged = Schema.decodeUnknownSync(
  AgentMessageAcknowledged,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentMessageEndpointId = Schema.decodeUnknownSync(
  AgentMessageEndpointId,
  STRICT_DECODE_OPTIONS,
);

/** One bounded receipt petition; caller identity is supplied only by the host. */
export const MAX_AGENT_MESSAGE_RECEIPT_IDS = 20;
export const AgentMessageReceiptRequest = Schema.Struct({
  action: Schema.Literals(["acknowledge", "status"]),
  messageIds: Schema.Array(AgentMessageId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_AGENT_MESSAGE_RECEIPT_IDS),
  ),
});
export type AgentMessageReceiptRequest = typeof AgentMessageReceiptRequest.Type;
export const decodeAgentMessageReceiptRequest = Schema.decodeUnknownSync(
  AgentMessageReceiptRequest,
  STRICT_DECODE_OPTIONS,
);

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One message in the messaging bounds view: a status, never a body. */
export const AgentMessageStatusSummary = Schema.Struct({
  messageId: AgentMessageId,
  senderThreadId: AgentMessageEndpointId,
  recipientThreadId: AgentMessageEndpointId,
  state: Schema.Literals(["in-flight", "delivered", "refused", "acknowledged", "expired"]),
  refuseReason: Schema.optional(AgentMessageRefuseReason),
  occurredAt: UtcTimestamp,
});
export type AgentMessageStatusSummary = typeof AgentMessageStatusSummary.Type;
export const decodeAgentMessageStatusSummary = Schema.decodeUnknownSync(
  AgentMessageStatusSummary,
  STRICT_DECODE_OPTIONS,
);

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
  recent: Schema.Array(AgentMessageStatusSummary).check(
    Schema.isMaxLength(MAX_AGENT_MESSAGE_STATUS_SUMMARIES),
  ),
});
export type AgentMessageMessagingFacts = typeof AgentMessageMessagingFacts.Type;

export const decodeAgentMessageMessagingFacts = Schema.decodeUnknownSync(
  AgentMessageMessagingFacts,
  STRICT_DECODE_OPTIONS,
);
