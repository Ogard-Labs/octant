/**
 * Shared Work and Code thread-board policy. Status is always derived from
 * authoritative runtime, recovery, and delivery-target evidence; it is never
 * assigned by hand and cards are never dragged between columns.
 *
 * Unread and follow-up are deliberately excluded: they are independent of
 * runtime status. Unread is a client overlay; follow-up is a durable obligation
 * that may sit on a Done card.
 */

export type ThreadBoardStatus = "ready" | "in-progress" | "waiting" | "done";

/**
 * Why the policy placed the thread in that status. Waiting keeps a specific
 * reason so a grouped list and a compact column can both show what is owed.
 */
export type ThreadBoardReason =
  | "delivery-satisfied"
  | "executing"
  | "awaiting-input"
  | "interrupted"
  | "recovering"
  | "delivery-waiting"
  | "idle-unmet-delivery";

export interface ThreadBoardDerivation {
  readonly status: ThreadBoardStatus;
  readonly reason: ThreadBoardReason;
}

/**
 * Fixed column order for the Status grouping: configured/idle work first, then
 * active execution, then blocked/waiting work, then satisfied work. `Done` is a
 * first-class visible column and is never suppressed.
 */
export const THREAD_BOARD_STATUS_COLUMN_ORDER = [
  "ready",
  "in-progress",
  "waiting",
  "done",
] as const satisfies ReadonlyArray<ThreadBoardStatus>;

/**
 * Card sort priority within a Project column. Actionable work is surfaced first
 * — Waiting, then In Progress, then Ready — while every Done card remains fully
 * visible below it rather than being hidden.
 */
export const THREAD_BOARD_PROJECT_STATUS_ORDER = [
  "waiting",
  "in-progress",
  "ready",
  "done",
] as const satisfies ReadonlyArray<ThreadBoardStatus>;

/**
 * Authoritative runtime signals used to derive a board status. All four wait
 * inputs are server-resolved projections; unread and follow-up are excluded
 * because they are independent of runtime status.
 */
export interface ThreadBoardStatusInput {
  /**
   * Server-authoritative delivery-target satisfaction. Ambiguous or stale
   * evidence has already been collapsed to `waiting` upstream, so this is only
   * `done` when the confirmed target is objectively satisfied. A completed
   * model turn is never enough on its own.
   */
  readonly deliverySatisfaction: "pending" | "waiting" | "done";
  /** A provider turn, tool, or subagent is actively executing. */
  readonly executing: boolean;
  /** Runtime work is waiting for a decision, approval, or input. */
  readonly awaitingInput: boolean;
  /** The latest provider turn was interrupted and nothing later superseded it. */
  readonly interrupted: boolean;
  /**
   * The thread's metadata projection is recovering (a missing Project
   * projection or an operation-journal rebuild).
   */
  readonly recovering: boolean;
}

/**
 * Derive board status from authoritative evidence. Precedence is Done → In
 * Progress → Waiting → Ready. Waiting picks the most specific reason that still
 * applies: recovering, then awaiting input, then an interrupted turn, then a
 * waiting delivery target.
 */
export function deriveThreadBoardStatus(input: ThreadBoardStatusInput): ThreadBoardDerivation {
  if (input.deliverySatisfaction === "done") {
    return { status: "done", reason: "delivery-satisfied" };
  }
  if (input.executing) {
    return { status: "in-progress", reason: "executing" };
  }
  if (input.recovering) {
    return { status: "waiting", reason: "recovering" };
  }
  if (input.awaitingInput) {
    return { status: "waiting", reason: "awaiting-input" };
  }
  if (input.interrupted) {
    return { status: "waiting", reason: "interrupted" };
  }
  if (input.deliverySatisfaction === "waiting") {
    return { status: "waiting", reason: "delivery-waiting" };
  }
  return { status: "ready", reason: "idle-unmet-delivery" };
}

export function threadBoardProjectStatusRank(status: ThreadBoardStatus): number {
  return THREAD_BOARD_PROJECT_STATUS_ORDER.indexOf(status);
}

export interface ThreadBoardProjectSortItem {
  readonly status: ThreadBoardStatus;
  readonly lastMeaningfulActivityAtMs: number | null;
}

/**
 * Compare two cards for the Project grouping: by the approved status priority
 * (Waiting → In Progress → Ready → Done), then by most recent meaningful
 * activity within the same status. Cards with no recorded activity sort last.
 */
export function compareThreadBoardProjectOrder(
  a: ThreadBoardProjectSortItem,
  b: ThreadBoardProjectSortItem,
): number {
  const rank = threadBoardProjectStatusRank(a.status) - threadBoardProjectStatusRank(b.status);
  if (rank !== 0) return rank;
  return compareRecencyDescending(a.lastMeaningfulActivityAtMs, b.lastMeaningfulActivityAtMs);
}

/**
 * Compare two cards for a Status column: purely by most recent meaningful
 * activity (descending). Cards with no recorded activity sort last.
 */
export function compareThreadBoardActivityDescending(
  a: { readonly lastMeaningfulActivityAtMs: number | null },
  b: { readonly lastMeaningfulActivityAtMs: number | null },
): number {
  return compareRecencyDescending(a.lastMeaningfulActivityAtMs, b.lastMeaningfulActivityAtMs);
}

function compareRecencyDescending(a: number | null, b: number | null): number {
  const aValue = a ?? Number.NEGATIVE_INFINITY;
  const bValue = b ?? Number.NEGATIVE_INFINITY;
  if (aValue === bValue) return 0;
  return bValue - aValue;
}
