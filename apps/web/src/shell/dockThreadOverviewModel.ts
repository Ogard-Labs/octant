import type { ChatThreadNavigationItem } from "./navigationModel";
import { relativeTimeLabel } from "../lib/relativeTime";

export type DockOverviewMode = "chat" | "work" | "code";

export interface RunningThreadFact {
  readonly mode: DockOverviewMode;
  readonly threadId: string;
  readonly title: string;
  readonly projectName?: string;
  /** Compact age, such as "4m ago". Absent when the host reported no time. */
  readonly age?: string;
}

/** A window rarely runs more than a handful of turns; the dock is a glance, not a list. */
const MAX_RUNNING_THREADS = 5;

/**
 * The other threads executing right now, in any mode the window knows.
 *
 * Only a row the host projects as `working` counts, the same signal the sidebar
 * dot reads, so this section cannot claim a thread is running that the row
 * beside it shows idle. The thread on screen is left out: the dock already
 * belongs to it.
 */
export function runningNowThreads(input: {
  readonly rows: Readonly<Record<DockOverviewMode, ReadonlyArray<ChatThreadNavigationItem>>>;
  readonly active: { readonly mode: DockOverviewMode; readonly threadId: string } | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly now: number;
}): ReadonlyArray<RunningThreadFact> {
  const modes: ReadonlyArray<DockOverviewMode> = ["code", "work", "chat"];
  const running = modes.flatMap((mode) =>
    input.rows[mode]
      .filter(
        (row) =>
          row.activity === "working" &&
          !(input.active?.mode === mode && input.active.threadId === row.threadId),
      )
      .map((row) => ({ mode, row })),
  );
  // Most recently touched first, so the thread that just started leads.
  running.sort((left, right) =>
    (right.row.updatedAt ?? "").localeCompare(left.row.updatedAt ?? ""),
  );
  return running.slice(0, MAX_RUNNING_THREADS).map(({ mode, row }) => {
    const projectName =
      row.projectId === undefined ? undefined : input.projectNames.get(row.projectId);
    return {
      mode,
      threadId: row.threadId,
      title: row.title,
      ...(projectName === undefined ? {} : { projectName }),
      ...(row.updatedAt === undefined ? {} : { age: relativeTimeLabel(row.updatedAt, input.now) }),
    };
  });
}
