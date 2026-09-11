import type { AgentMessageRefuseReason, OctantMode } from "@octant/contracts";
import { MAX_AGENT_MESSAGE_BODY_BYTES } from "@octant/contracts";

/**
 * Pure agent-to-agent messaging policy (decision 0063).
 *
 * Messaging is a server-owned capability: a sender petitions, the host admits,
 * clamps, journals, and delivers. The sender's petition carries text and
 * target ids inside its live grant; every refusal here is a value the caller
 * must handle, never an exception. Nothing in this module reads storage,
 * performs I/O, or grants authority — that is the point: a delivered message
 * is untrusted external content on the recipient thread, framed as data, and
 * the recipient keeps its own provider, memory, sandbox, and approvals.
 */

/** How many hops a message may travel from the admitting principal's reach. */
export const MAX_AGENT_MESSAGE_DEPTH = 2;
/** How many recipients one petition may name. */
export const MAX_AGENT_MESSAGE_RECIPIENTS = 4;
/** How many undelivered messages one sender thread may have open at once. */
export const MAX_OPEN_AGENT_MESSAGES_PER_SENDER = 8;

export interface AgentMessageSenderFacts {
  /** Modes the admitting principal's Open scope covers for both endpoints. */
  readonly openModes: ReadonlySet<OctantMode>;
  /** Whether the sender's live grant still admits messaging at delivery time. */
  readonly messagingAdmitted: boolean;
  /** Hops from the admitting principal's own reach to this sender. */
  readonly depth: number;
  /** Undelivered messages this sender already has open. */
  readonly openInFlight: number;
}

export interface AgentMessageRecipientFacts {
  readonly mode: OctantMode;
  /** The recipient has settled (completed, failed, cancelled, or closed). */
  readonly terminal: boolean;
}

export type AgentMessageDeliveryDecision =
  | { readonly status: "admitted" }
  | {
      readonly status: "refused";
      readonly reason: AgentMessageRefuseReason;
      readonly message: string;
    };

function refused(reason: AgentMessageRefuseReason, message: string): AgentMessageDeliveryDecision {
  return { status: "refused", reason, message };
}

/** One recipient's verdict at petition time; the delivery service fans out. */
export function decideAgentMessageDelivery(input: {
  readonly sender: AgentMessageSenderFacts;
  readonly recipient: AgentMessageRecipientFacts;
  readonly bodyByteLength: number;
  readonly recipientCount: number;
}): AgentMessageDeliveryDecision {
  if (input.bodyByteLength < 1) {
    return refused("oversize", "An agent message must carry a non-empty body.");
  }
  if (input.bodyByteLength > MAX_AGENT_MESSAGE_BODY_BYTES) {
    return refused(
      "oversize",
      `An agent message body may not exceed ${String(MAX_AGENT_MESSAGE_BODY_BYTES)} bytes.`,
    );
  }
  if (input.recipientCount < 1 || input.recipientCount > MAX_AGENT_MESSAGE_RECIPIENTS) {
    return refused(
      "policy",
      `An agent message may name at most ${String(MAX_AGENT_MESSAGE_RECIPIENTS)} recipients.`,
    );
  }
  if (input.sender.depth > MAX_AGENT_MESSAGE_DEPTH) {
    return refused(
      "depth-exceeded",
      "Agent messages may not travel beyond the bounded hierarchy depth.",
    );
  }
  if (input.sender.openInFlight >= MAX_OPEN_AGENT_MESSAGES_PER_SENDER) {
    return refused(
      "policy",
      "The sender already has too many open agent messages; wait for delivery or refusal.",
    );
  }
  if (!input.sender.messagingAdmitted) {
    return refused("unauthorized", "The sender's live grant does not admit agent messaging.");
  }
  if (!input.sender.openModes.has(input.recipient.mode)) {
    // Cross-mode delivery needs both endpoints inside the admitting principal's
    // Open scope. Nothing here grants a principal a mode it cannot already open.
    return refused(
      "unauthorized",
      "The admitting principal cannot open the recipient thread's mode.",
    );
  }
  if (input.recipient.terminal) {
    return refused(
      "recipient-terminal",
      "The recipient thread has settled and can no longer accept a message.",
    );
  }
  return { status: "admitted" };
}

/**
 * The delivery-time recheck. `agent.message-sent@1` is admission only: before
 * `agent.message-delivered@1` the server rechecks the sender's live grant and
 * the recipient's lifecycle. Grant revocation or recipient closure between the
 * two events refuses delivery (`unauthorized` / `recipient-terminal`), so
 * admission never creates an irrevocable delivery right.
 */
export function decideAgentMessageDeliveryAtRecheck(input: {
  readonly senderMessagingAdmitted: boolean;
  readonly recipientMode: OctantMode;
  readonly senderOpenModes: ReadonlySet<OctantMode>;
  readonly recipientTerminal: boolean;
}): AgentMessageDeliveryDecision {
  if (!input.senderMessagingAdmitted) {
    return refused(
      "unauthorized",
      "The sender's live grant no longer admits delivering this message.",
    );
  }
  if (!input.senderOpenModes.has(input.recipientMode)) {
    return refused(
      "unauthorized",
      "The admitting principal can no longer open the recipient thread's mode.",
    );
  }
  if (input.recipientTerminal) {
    return refused(
      "recipient-terminal",
      "The recipient thread closed between admission and delivery.",
    );
  }
  return { status: "admitted" };
}

/**
 * What messaging can change on the recipient: the delivered body is untrusted
 * external content, framed as data with an opaque source label, and nothing
 * else. The value exists so a caller cannot smuggle an authority change into
 * a delivery — there is no field here a message could set.
 */
export interface AgentMessageDeliveryEffects {
  /** The recipient thread journals `thread.external-content-ingested@1`. */
  readonly externalContentIngested: true;
  /** The body never executes as instructions; framing belongs to the host. */
  readonly bodyTreatedAsData: true;
}

/**
 * Proves messaging grants no authority: the effects of a delivered message are
 * exactly the taint and the data framing. A sender cannot widen recipient
 * authority, clear taint, start Full access, install an extension, or approve
 * on anyone's behalf by messaging, because the effects type has no such field.
 */
export function agentMessageDeliveryEffects(): AgentMessageDeliveryEffects {
  return { externalContentIngested: true, bodyTreatedAsData: true };
}

export { MAX_AGENT_MESSAGE_BODY_BYTES };
