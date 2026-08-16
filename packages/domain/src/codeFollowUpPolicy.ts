import type { CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationEvent, CodeThreadFollowUp } from "@octant/contracts/code-operations";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";

/**
 * Pure follow-up policy for Code threads. It mirrors the normalized chat/Work
 * `ThreadFollowUp` behavior for the {@link CodeThreadFollowUp} aggregate: the
 * marker is a durable user obligation that opens automatically or manually, is
 * evaluated on an edge (not a level), and clears only through an explicit
 * completion. Keeping it isolated from the chat-branded policy avoids widening
 * the chat aggregate's branded types while preserving identical semantics.
 */

export type CodeFollowUpPolicyRejectionCode =
  | "stale-version"
  | "invalid-reason"
  | "follow-up-already-closed"
  | "invalid-acknowledgement";

export class CodeFollowUpPolicyRejected extends Error {
  override readonly name = "CodeFollowUpPolicyRejected";

  constructor(
    readonly code: CodeFollowUpPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CodeFollowUpPolicyRejectionCode, message: string): never {
  throw new CodeFollowUpPolicyRejected(code, message);
}

export interface CodeFollowUpTrigger {
  readonly sequence: number;
  readonly reason: string;
  readonly origin: "manual" | "automatic";
  readonly triggeredAt: UtcTimestamp;
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length === 0) {
    reject("invalid-reason", "Follow-up reason cannot be empty");
  }
  return normalized;
}

/**
 * Applies one edge trigger to the current follow-up state.
 *
 * - No prior marker: open it at the trigger sequence.
 * - Completed marker: reopen only when the trigger sequence is strictly newer
 *   than the acknowledged sequence (a newer actionable trigger reopens exactly
 *   once; a previously acknowledged sequence never does).
 * - Open marker: adopt the newer reason/origin only when the sequence advances.
 *
 * Viewing a thread, ordinary activity, or a duplicate/older/replayed trigger all
 * return the current state unchanged, so the marker never silently clears.
 */
export function evaluateCodeFollowUpTrigger(
  threadId: CodeThreadId,
  current: CodeThreadFollowUp | undefined,
  trigger: CodeFollowUpTrigger,
): CodeThreadFollowUp {
  const reason = normalizeReason(trigger.reason);

  if (current === undefined) {
    return {
      threadId,
      state: "open",
      origin: trigger.origin,
      reason,
      triggerSequence: trigger.sequence,
      acknowledgedThroughSequence: 0,
      createdAt: trigger.triggeredAt,
    } as CodeThreadFollowUp;
  }

  if (current.state === "completed" && trigger.sequence > current.acknowledgedThroughSequence) {
    const { completedAt: _completedAt, ...rest } = current;
    return {
      ...rest,
      state: "open",
      origin: trigger.origin,
      reason,
      triggerSequence: trigger.sequence,
    } as CodeThreadFollowUp;
  }

  if (current.state === "open" && trigger.sequence > current.triggerSequence) {
    return {
      ...current,
      origin: trigger.origin,
      reason,
      triggerSequence: trigger.sequence,
    } as CodeThreadFollowUp;
  }

  return current;
}

export interface CompleteCodeFollowUpInput {
  readonly expectedVersion: AggregateVersion;
  readonly acknowledgedThroughSequence: number;
  readonly completedAt: UtcTimestamp;
}

/**
 * Acknowledges the current follow-up obligation. The acknowledgement must match
 * the open marker's current trigger sequence and exceed the previously
 * acknowledged sequence; completing never alters work-item status.
 */
export function completeCodeFollowUp(
  currentVersion: AggregateVersion,
  followUp: CodeThreadFollowUp,
  input: CompleteCodeFollowUpInput,
): CodeThreadFollowUp {
  if (currentVersion !== input.expectedVersion) {
    reject("stale-version", `Expected version ${input.expectedVersion}, got ${currentVersion}`);
  }

  if (followUp.state !== "open") {
    reject("follow-up-already-closed", "Follow-up is already completed");
  }

  if (
    input.acknowledgedThroughSequence !== followUp.triggerSequence ||
    input.acknowledgedThroughSequence <= followUp.acknowledgedThroughSequence
  ) {
    reject(
      "invalid-acknowledgement",
      "Acknowledged sequence must match the current trigger and exceed the previous acknowledgement",
    );
  }

  return {
    ...followUp,
    state: "completed",
    acknowledgedThroughSequence: input.acknowledgedThroughSequence,
    completedAt: input.completedAt,
  } as CodeThreadFollowUp;
}

/**
 * The reason and origin of an automatic follow-up trigger derived from one Code
 * operation event, or `undefined` when the event is not itself a user-actionable
 * edge. Only structural, normalized operation events produce triggers; ordinary
 * assistant prose (`provider-content`) and telemetry (`usage`, `diff`, plain
 * running progress) never do. The caller supplies the monotonic source sequence
 * and stable source-event id used for edge-based, idempotent evaluation.
 */
export interface CodeFollowUpAutomaticTrigger {
  readonly reason: string;
  readonly origin: "automatic";
}

export function deriveCodeFollowUpTrigger(
  event: CodeOperationEvent,
): CodeFollowUpAutomaticTrigger | undefined {
  switch (event.kind) {
    case "approval-requested":
      return { origin: "automatic", reason: `Approval requested: ${event.action}` };
    case "input-requested":
      return { origin: "automatic", reason: "The agent is waiting for your input." };
    case "operation-state":
      if (event.state === "waiting") {
        return { origin: "automatic", reason: "The operation is waiting for you." };
      }
      if (event.state === "failed") {
        const detail = event.failure?.message;
        return {
          origin: "automatic",
          reason:
            detail === undefined
              ? "An operation failed and needs attention."
              : `Operation failed: ${detail}`,
        };
      }
      return undefined;
    case "task-progress":
      if (event.state === "waiting") {
        return { origin: "automatic", reason: `Task needs attention: ${event.summary}` };
      }
      if (event.state === "failed") {
        return { origin: "automatic", reason: `Task failed: ${event.summary}` };
      }
      return undefined;
    case "child-activity":
      if (event.state === "waiting") {
        return { origin: "automatic", reason: `Subagent is waiting: ${event.summary}` };
      }
      if (event.state === "failed") {
        return { origin: "automatic", reason: `Subagent failed: ${event.summary}` };
      }
      return undefined;
    default:
      return undefined;
  }
}
