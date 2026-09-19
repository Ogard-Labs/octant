import { type SidebarThreadStatus } from "@octant/contracts/sidebar-thread-status";

/**
 * How the sidebar ranks the thread statuses it speaks about, and how a Project
 * summarizes the threads filed under it.
 *
 * The row already ranked its states, but it did so inline in the renderer, so
 * nothing else could read the same ranking. A Project heading had no way to say
 * what its folded threads were doing without re-deriving the order and drifting
 * from the row.
 *
 * `@octant/contracts` names the legal set, because a saved Project View
 * persists the words and they have to round-trip. This module owns everything a
 * caller concludes from them: the strength order, the labels, the roll-up, and
 * the comparison. A rank is never written down, so it is policy rather than a
 * wire value and belongs here.
 *
 * Nothing to report is the absence of a status, not a status called "idle". A
 * quiet thread returns `undefined` and a quiet Project rolls up to `undefined`,
 * so a caller has to handle silence deliberately rather than receive a word it
 * might render, filter for, or sort by.
 */

/**
 * The statuses in descending strength.
 *
 * The contract fixes the set; this fixes the order. Ranking is what makes one
 * status the one a row shows and one Project louder than another, so the order
 * travels with the meaning rather than with the wire format.
 *
 * `SIDEBAR_THREAD_STATUS_LABEL` below is typed over the contract's union, so a
 * status added to the contract without a label fails to build. That is what
 * keeps this list honest: a status ranked nowhere resolves to -1 and would
 * silently outrank every other, and the label record is the reason a new word
 * cannot reach the sidebar unnoticed.
 */
export const SIDEBAR_THREAD_STATUS_ORDER = [
  "working",
  "attention",
  "woke",
  "unread",
] as const satisfies ReadonlyArray<SidebarThreadStatus>;

/**
 * What each status is called wherever it is named. Silence has no label: a row
 * that wears "Idle" reads as a state someone chose rather than as nothing to
 * report.
 */
export const SIDEBAR_THREAD_STATUS_LABEL: Readonly<Record<SidebarThreadStatus, string>> = {
  working: "Working",
  attention: "Needs attention",
  woke: "Snooze ended",
  unread: "New activity",
};

/**
 * The facts a sidebar row holds about one thread. They are independent: a
 * thread can be working and unread and woken at once, and the ranking decides
 * which one the single status slot shows.
 */
export interface SidebarThreadStatusInput {
  /** A provider turn, tool, or subagent is executing, as the host projects it. */
  readonly working: boolean;
  /** An open follow-up, or another obligation the host raised on the thread. */
  readonly attention: boolean;
  /** A snooze ended but the thread has not been opened since. */
  readonly woke: boolean;
  /** The thread has activity past what this client has read. */
  readonly unread: boolean;
}

/**
 * Where a status sits in the order, lower being stronger.
 *
 * Callers that need to compare a present status against silence should treat
 * silence as weaker than every rank rather than giving it a number of its own.
 */
export function sidebarThreadStatusRank(status: SidebarThreadStatus): number {
  return SIDEBAR_THREAD_STATUS_ORDER.indexOf(status);
}

/** The strongest status the facts support, or `undefined` when they support none. */
export function resolveSidebarThreadStatus(
  input: SidebarThreadStatusInput,
): SidebarThreadStatus | undefined {
  return SIDEBAR_THREAD_STATUS_ORDER.find((status) => input[status]);
}

/**
 * Every status the facts support, strongest first.
 *
 * A row draws one mark but names them all, so a reader using a screen reader
 * hears that a thread is working *and* unread where a sighted reader infers it
 * from the row's other marks.
 */
export function sidebarThreadStatuses(
  input: SidebarThreadStatusInput,
): ReadonlyArray<SidebarThreadStatus> {
  return SIDEBAR_THREAD_STATUS_ORDER.filter((status) => input[status]);
}

/** The strongest status across a Project's threads, and how many reached it. */
export interface SidebarProjectStatusRollup {
  readonly status: SidebarThreadStatus;
  readonly count: number;
}

/**
 * What a Project says about the threads filed under it, or `undefined` when
 * they have nothing to report.
 *
 * Each thread is counted once, at its own strongest status, so a thread that is
 * both working and unread raises the working count and not the unread one. The
 * count answers how many threads are in the state being reported, which is a
 * different question from how many statuses are present.
 */
export function rollUpSidebarProjectStatus(
  threads: ReadonlyArray<SidebarThreadStatusInput>,
): SidebarProjectStatusRollup | undefined {
  let leading: SidebarThreadStatus | undefined;
  let count = 0;
  for (const thread of threads) {
    const resolved = resolveSidebarThreadStatus(thread);
    if (resolved === undefined) continue;
    if (leading === undefined) {
      leading = resolved;
      count = 1;
      continue;
    }
    const rank = sidebarThreadStatusRank(resolved);
    const leadingRank = sidebarThreadStatusRank(leading);
    if (rank < leadingRank) {
      leading = resolved;
      count = 1;
    } else if (rank === leadingRank) {
      count += 1;
    }
  }
  return leading === undefined ? undefined : { status: leading, count };
}

/**
 * How a Project reads its roll-up aloud.
 *
 * The count is stated only when it adds something: "(1 thread)" invites the
 * reader to wonder what the other threads are doing when there is nothing else
 * to know.
 */
export function describeSidebarProjectStatus(
  projectName: string,
  rollup: SidebarProjectStatusRollup,
): string {
  const label = SIDEBAR_THREAD_STATUS_LABEL[rollup.status];
  return rollup.count > 1
    ? `${projectName}: ${label} (${String(rollup.count)} threads)`
    : `${projectName}: ${label}`;
}

/**
 * Orders two Projects loudest first by what their threads are doing.
 *
 * A Project with nothing to report sorts after every Project that has
 * something, and two Projects reporting the same status are separated by how
 * many threads reached it, so the busier one leads. Ties beyond that are left
 * to the caller, which already has a secondary order to fall back on.
 */
export function compareSidebarProjectStatus(
  left: SidebarProjectStatusRollup | undefined,
  right: SidebarProjectStatusRollup | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  const byStatus = sidebarThreadStatusRank(left.status) - sidebarThreadStatusRank(right.status);
  return byStatus !== 0 ? byStatus : right.count - left.count;
}
