import type { ChatThreadNavigationItem } from "../shell/navigationModel";

/**
 * What a thread's rest and pin choices read from its row. The row menu and the
 * command palette both ask here, so neither can offer a state the other denies.
 *
 * One action undoes either way a thread closed: settled, or marked Done. It
 * says Un-settle when the thread settled, and Reopen for a Code thread marked
 * Done while Settle threads when they're done is off.
 */
export function threadRowRestState(
  thread: Pick<ChatThreadNavigationItem, "pinned" | "completedAt" | "markedDone" | "snooze">,
): {
  readonly pinned: boolean;
  readonly closed: boolean;
  readonly reopenLabel: "Reopen" | "Un-settle";
  readonly snoozed: boolean;
} {
  return {
    pinned: thread.pinned === true,
    closed: thread.completedAt !== undefined || thread.markedDone === true,
    reopenLabel: thread.completedAt === undefined ? "Reopen" : "Un-settle",
    snoozed: thread.snooze !== undefined,
  };
}
