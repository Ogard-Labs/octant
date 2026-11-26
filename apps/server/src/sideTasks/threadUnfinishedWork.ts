import type { OctantMode, SideTaskChildState } from "@octant/contracts";
import type { ThreadUnfinishedWork } from "@octant/domain/thread-completion-policy";
import type { SideTaskReportStore } from "./sideTaskReportStore";
import type { SideTaskStore } from "./sideTaskStore";

/** What a started child's thread is doing, or that it can do nothing more here. */
export type SideTaskChildStanding = SideTaskChildState | "closed";

export interface ThreadUnfinishedWorkPorts {
  readonly sideTasks: Pick<SideTaskStore, "startedChildrenOf">;
  readonly reports: Pick<SideTaskReportStore, "undeliveredForParent">;
  /**
   * What the child's thread is doing, in the receipt's own words but read by
   * the host for itself, whatever window asks to settle. `closed` is a thread
   * that is archived, deleted or purged.
   */
  readonly childStanding: (child: {
    readonly mode: OctantMode;
    readonly threadId: string;
  }) => SideTaskChildStanding;
  /**
   * Whether the parent's own state keeps its reports from being delivered, so
   * waiting for one would leave no way to settle the thread.
   */
  readonly reportsHeld: (parentThreadId: string) => boolean;
  /** The task of a child run still going in the thread, if one is. */
  readonly runningChildRun: (parentThreadId: string) => string | undefined;
}

/**
 * The work a thread started that is not done, which keeps every way of
 * settling it off: a started side task that works or needs the person, one
 * whose report is still owed here, or a running child run. Only the thread's
 * own children count. An offer nobody started and a closed child never hold
 * it, and stopping a child's reports does not make a working child done.
 */
export function createThreadUnfinishedWork(
  ports: ThreadUnfinishedWorkPorts,
): (threadId: string) => ThreadUnfinishedWork | undefined {
  return (threadId) => {
    const open = ports.sideTasks.startedChildrenOf(threadId).flatMap(({ childThreadId, offer }) => {
      const standing = ports.childStanding({ mode: offer.mode, threadId: childThreadId });
      return standing === "closed" ? [] : [{ childThreadId, title: offer.title, standing }];
    });
    const working = open.find((child) => child.standing === "working");
    if (working !== undefined) return { kind: "side-task-working", title: working.title };
    const attention = open.find((child) => child.standing === "attention");
    if (attention !== undefined) return { kind: "side-task-attention", title: attention.title };
    if (!ports.reportsHeld(threadId)) {
      const owing = new Set(
        ports.reports.undeliveredForParent(threadId).map((entry) => entry.childThreadId),
      );
      const owes = open.find((child) => owing.has(child.childThreadId));
      if (owes !== undefined) return { kind: "side-task-report", title: owes.title };
    }
    const run = ports.runningChildRun(threadId);
    return run === undefined ? undefined : { kind: "child-run", title: run };
  };
}
