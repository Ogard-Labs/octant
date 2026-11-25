import type { CodeThreadId, ProjectId } from "@octant/contracts";

/**
 * What the host itself tracks that may still be working in a thread's folder.
 * Each answers for the host's own records; nothing here scans processes.
 */
export interface ThreadCleanupWorkPorts {
  /** The thread's project, or undefined when the thread is gone. */
  readonly projectOf: (threadId: CodeThreadId) => ProjectId | undefined;
  /** A turn is being prepared, running, or waiting on the person. */
  readonly turnInProgress: (threadId: CodeThreadId) => boolean;
  /** A turn is live in the registry the move of a thread asks. */
  readonly liveTurn: (threadId: CodeThreadId) => boolean;
  /** A child run still going here, or one handed to another member and not yet reported back. */
  readonly childWorkGoing: (threadId: CodeThreadId) => boolean;
  /** A debug session the host started for the thread. */
  readonly debugSession: (threadId: CodeThreadId) => boolean;
  /**
   * A shell or dev server the host runs for the project. A terminal records
   * its Project and where it started, and it can move between the Project's
   * folders, so the host cannot say which worktree it is in.
   */
  readonly projectTerminalRunning: (projectId: ProjectId) => boolean;
  /** A terminal of the thread, in the Code workspace or an agent's, is starting or running. */
  readonly threadTerminalRunning: (threadId: CodeThreadId) => boolean;
  /** A message waits in the thread's queue. */
  readonly queuedMessage: (threadId: CodeThreadId) => boolean;
  /** Wake-ups waiting for the thread; undefined when the service is not running. */
  readonly pendingWakeups: (threadId: CodeThreadId) => number | undefined;
}

export interface ThreadCleanupWorkOptions {
  /**
   * Do not count a shell somewhere in the Project. Removal on archive has
   * never waited for one, and the host cannot tell whether it is in this
   * worktree, so it keeps doing without; the timer's cleanup of an open
   * thread counts it, since its folder is the one a person may be working in.
   */
  readonly ignoreProjectTerminals?: true;
}

/**
 * Whether anything the host knows of may still be working in the thread's
 * folder or about to start. Any read that cannot answer counts as working, so
 * a worktree is removed only when the host can say the thread is quiet.
 */
export function threadHasWork(
  ports: ThreadCleanupWorkPorts,
  threadId: CodeThreadId,
  options: ThreadCleanupWorkOptions = {},
): boolean {
  try {
    const projectId = ports.projectOf(threadId);
    if (projectId === undefined) return true;
    const wakeups = ports.pendingWakeups(threadId);
    return (
      ports.turnInProgress(threadId) ||
      ports.liveTurn(threadId) ||
      ports.childWorkGoing(threadId) ||
      ports.debugSession(threadId) ||
      ports.threadTerminalRunning(threadId) ||
      (options.ignoreProjectTerminals !== true && ports.projectTerminalRunning(projectId)) ||
      ports.queuedMessage(threadId) ||
      wakeups === undefined ||
      wakeups > 0
    );
  } catch {
    return true;
  }
}
