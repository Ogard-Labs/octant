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
/**
 * How many bytes of message bodies one recipient turn carries. Several
 * senders may each hold open messages for one thread, and carrying them all
 * at once could fill the turn's context before the person's own prompt.
 */
export const MAX_AGENT_MESSAGE_BYTES_PER_TURN = MAX_AGENT_MESSAGE_BODY_BYTES;

/**
 * The one sentence every unreachable recipient is refused with. An unknown id,
 * a thread of another Project or mode, a child run, and the sender itself all
 * read the same, so a refusal never confirms that a thread exists.
 */
export const AGENT_MESSAGE_UNREACHABLE = "That thread cannot be messaged from this thread.";

/** Where one endpoint stands: which thread it is and the Project that holds it. */
export interface AgentMessageEndpointScope {
  readonly threadId: string;
  /** Absent for a thread outside any Project, which reaches and is reached by nothing. */
  readonly projectId: string | undefined;
}

/**
 * Whether a sender may address a recipient at all: another thread of the
 * sender's own Project. A message is the sender acting on the recipient — it
 * taints that thread and enters its context — and a thread acts only inside
 * the Project it is bound to.
 */
export function agentMessageRecipientReachable(
  sender: AgentMessageEndpointScope,
  recipient: AgentMessageEndpointScope | undefined,
): boolean {
  return (
    recipient !== undefined &&
    recipient.threadId !== sender.threadId &&
    sender.projectId !== undefined &&
    sender.projectId === recipient.projectId
  );
}

export interface AgentMessageSenderFacts {
  readonly scope: AgentMessageEndpointScope;
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
  readonly scope: AgentMessageEndpointScope;
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

/**
 * One recipient's verdict at petition time; the delivery service fans out. A
 * recipient the host cannot resolve is `undefined` and refuses exactly as an
 * unreachable one does.
 */
export function decideAgentMessageDelivery(input: {
  readonly sender: AgentMessageSenderFacts;
  readonly recipient: AgentMessageRecipientFacts | undefined;
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
  // Reach is decided before anything that depends on the recipient's own
  // state, so a thread the sender cannot address never reports its mode or
  // whether it has settled.
  if (
    input.recipient === undefined ||
    !agentMessageRecipientReachable(input.sender.scope, input.recipient.scope)
  ) {
    return refused("unauthorized", AGENT_MESSAGE_UNREACHABLE);
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
 * a recipient turn carries the body and `agent.message-delivered@1` is
 * journaled, the server rechecks the sender's live grant, that both threads
 * still share a Project, and the recipient's lifecycle. Grant revocation, a
 * move to another Project, or recipient closure between the two events
 * refuses delivery (`unauthorized` / `recipient-terminal`), so admission never
 * creates an irrevocable delivery right.
 */
export function decideAgentMessageDeliveryAtRecheck(input: {
  readonly senderMessagingAdmitted: boolean;
  readonly senderScope: AgentMessageEndpointScope;
  readonly recipientScope: AgentMessageEndpointScope;
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
  if (!agentMessageRecipientReachable(input.senderScope, input.recipientScope)) {
    return refused("unauthorized", AGENT_MESSAGE_UNREACHABLE);
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
 * Which of a thread's waiting messages its next turn carries: oldest first,
 * within the per-turn byte bound, and always at least one so a single large
 * body is never stranded. The rest wait for the turn after.
 */
export function agentMessagesCarriedByTurn<T extends { readonly byteLength: number }>(
  waiting: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const carried: T[] = [];
  let bytes = 0;
  for (const message of waiting) {
    if (carried.length > 0 && bytes + message.byteLength > MAX_AGENT_MESSAGE_BYTES_PER_TURN) break;
    carried.push(message);
    bytes += message.byteLength;
  }
  return carried;
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
