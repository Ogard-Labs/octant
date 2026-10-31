import type { ThreadAttentionSignal } from "./threadAttention";

/**
 * Approvals and questions stop an agent cold, so they come before a finished
 * turn nobody has looked at. A failed turn is not here: the host's thread
 * listing does not report one, and a status is never inferred from silence.
 * A due follow-up is a reminder, not a thread that is waiting.
 */
const WAITING_PRIORITY: Partial<Record<ThreadAttentionSignal["reason"], number>> = {
  "approval-required": 0,
  "question-asked": 1,
  "turn-finished": 2,
};

/**
 * The thread to jump to after `currentThreadId`: every waiting thread once, at
 * its strongest reason, strongest first and in list order within a reason,
 * wrapping at the end. When the open thread is not waiting, the jump starts at
 * the first. Nothing waits: `undefined`.
 */
export function nextWaitingThread(
  signals: ReadonlyArray<ThreadAttentionSignal>,
  currentThreadId: string | undefined,
): ThreadAttentionSignal | undefined {
  const strongest = new Map<string, ThreadAttentionSignal>();
  for (const signal of signals) {
    const rank = WAITING_PRIORITY[signal.reason];
    if (rank === undefined) continue;
    const held = strongest.get(signal.threadId);
    if (held === undefined || rank < (WAITING_PRIORITY[held.reason] ?? Infinity)) {
      strongest.set(signal.threadId, signal);
    }
  }
  const ordered = [...strongest.values()].toSorted(
    (left, right) =>
      (WAITING_PRIORITY[left.reason] ?? Infinity) - (WAITING_PRIORITY[right.reason] ?? Infinity),
  );
  if (ordered.length === 0) return undefined;
  const at = ordered.findIndex((signal) => signal.threadId === currentThreadId);
  return ordered[(at + 1) % ordered.length];
}
