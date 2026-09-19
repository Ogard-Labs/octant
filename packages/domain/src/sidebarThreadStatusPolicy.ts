/**
 * The one status vocabulary the sidebar speaks, and how a Project summarizes
 * the threads filed under it.
 *
 * The sidebar row already ranked its states, but it did so inline in the
 * renderer, so nothing else could read the same ranking. A Project heading had
 * no way to say what its folded threads were doing without re-deriving the
 * order and drifting from the row. This module names the vocabulary once so the
 * row and the heading cannot disagree.
 *
 * Every status is a fact the sidebar already carries. A status the sidebar
 * cannot observe — a failed run, a blocked check — is absent here rather than
 * inferred from silence, because a heading that under-reports is recoverable
 * and one that invents trouble is not.
 */

/**
 * Descending strength. `working` leads because a running thread is the one the
 * reader is most likely waiting on; `idle` carries no claim at all and draws
 * nothing.
 */
export const SIDEBAR_THREAD_STATUS_ORDER = [
  "working",
  "attention",
  "woke",
  "unread",
  "idle",
] as const;

export type SidebarThreadStatus = (typeof SIDEBAR_THREAD_STATUS_ORDER)[number];

/** Every status that says something, in the same descending strength. */
export const SIDEBAR_THREAD_STATUS_SPOKEN = [
  "working",
  "attention",
  "woke",
  "unread",
] as const satisfies ReadonlyArray<Exclude<SidebarThreadStatus, "idle">>;

export type SpokenSidebarThreadStatus = (typeof SIDEBAR_THREAD_STATUS_SPOKEN)[number];

/**
 * What each status is called wherever it is named. `idle` has no label: it is
 * the absence of a claim, and a row that wears "Idle" reads as a state someone
 * chose rather than as nothing to report.
 */
export const SIDEBAR_THREAD_STATUS_LABEL: Readonly<Record<SpokenSidebarThreadStatus, string>> = {
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

export function sidebarThreadStatusRank(status: SidebarThreadStatus): number {
  return SIDEBAR_THREAD_STATUS_ORDER.indexOf(status);
}

/** The strongest status the facts support. */
export function resolveSidebarThreadStatus(input: SidebarThreadStatusInput): SidebarThreadStatus {
  if (input.working) return "working";
  if (input.attention) return "attention";
  if (input.woke) return "woke";
  if (input.unread) return "unread";
  return "idle";
}

/**
 * Every status the facts support, strongest first. The row shows the first and
 * keeps the rest in its label, so a working thread that is also unread still
 * says so to a reader who stops on it.
 */
export function sidebarThreadStatuses(
  input: SidebarThreadStatusInput,
): ReadonlyArray<SpokenSidebarThreadStatus> {
  return SIDEBAR_THREAD_STATUS_SPOKEN.filter((status) => input[status]);
}

export interface SidebarProjectStatusRollup {
  /** The strongest status across the counted threads, or `idle` for none. */
  readonly status: SidebarThreadStatus;
  /** How many threads resolved to the strongest status. Zero when `idle`. */
  readonly count: number;
}

/**
 * What a Project heading says about the threads filed under it.
 *
 * Each thread is counted once, at its own strongest status, so a working thread
 * that is also unread raises the working count and not the unread one. The
 * count answers "how many threads are in the state this heading is reporting",
 * which is the question a reader has when the Project is folded shut.
 */
export function rollUpSidebarProjectStatus(
  threads: ReadonlyArray<SidebarThreadStatusInput>,
): SidebarProjectStatusRollup {
  let status: SidebarThreadStatus = "idle";
  let count = 0;
  for (const thread of threads) {
    const resolved = resolveSidebarThreadStatus(thread);
    if (resolved === "idle") continue;
    const rank = sidebarThreadStatusRank(resolved);
    const leadingRank = sidebarThreadStatusRank(status);
    if (rank < leadingRank) {
      status = resolved;
      count = 1;
    } else if (rank === leadingRank) {
      count += 1;
    }
  }
  return { status, count };
}

/**
 * How a rolled-up Project reads aloud. Absent when there is nothing to report,
 * so a quiet Project is named by its own label alone rather than by "Idle".
 *
 * A single thread is described without a count, because "(1 thread)" tells the
 * reader nothing the status did not already say.
 */
export function describeSidebarProjectStatus(
  projectName: string,
  rollup: SidebarProjectStatusRollup,
): string | undefined {
  if (rollup.status === "idle") return undefined;
  const label = SIDEBAR_THREAD_STATUS_LABEL[rollup.status];
  return rollup.count > 1
    ? `${projectName}: ${label} (${String(rollup.count)} threads)`
    : `${projectName}: ${label}`;
}
