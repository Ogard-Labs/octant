import type {
  CodeCommand,
  CodeCommandResult,
  CodeThread,
  CodeThreadWorktreeMoveRefusal,
  WindowId,
} from "@octant/contracts";

/** How long the move waits once for the agent's own turn to read as settled. */
const SETTLE_RETRY_MS = 500;

/**
 * Runs the move into a worktree that the person allowed during an agent's
 * turn, once that turn has ended, and tells the person on the thread what
 * happened either way: the agent's turn is over, so nobody else would.
 * A turn that did not complete (stopped, interrupted, failed) does not move:
 * stopping is the person changing course.
 */
export async function runAllowedWorktreeMove(
  input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThread["id"];
    readonly branchName?: string;
    readonly turnCompleted: boolean;
  },
  deps: {
    readonly readThread: (threadId: CodeThread["id"]) => CodeThread | undefined;
    readonly execute: (windowId: WindowId, command: CodeCommand) => Promise<CodeCommandResult>;
    readonly notify: (threadId: CodeThread["id"], text: string) => Promise<void>;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const notify = (text: string) => deps.notify(input.threadId, text).catch(() => undefined);
  if (!input.turnCompleted) {
    await notify(
      "The move to a new worktree you allowed did not happen, because the turn stopped first. Nothing was moved.",
    );
    return;
  }
  const attempt = async (): Promise<CodeCommandResult | Error> => {
    const thread = deps.readThread(input.threadId);
    if (thread === undefined) return new Error("The task is gone.");
    try {
      return await deps.execute(input.windowId, {
        kind: "move-code-thread-to-worktree",
        threadId: input.threadId,
        expectedVersion: thread.version,
        ...(input.branchName === undefined ? {} : { branchName: input.branchName }),
      });
    } catch (error) {
      return error instanceof Error ? error : new Error("The move failed.");
    }
  };
  let result = await attempt();
  // The ended turn's own record can still read as running for a moment.
  if (
    !(result instanceof Error) &&
    result.kind === "thread-moved-to-worktree" &&
    result.outcome.status === "refused" &&
    result.outcome.reason === "turn-running"
  ) {
    await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
      SETTLE_RETRY_MS,
    );
    result = await attempt();
  }
  if (result instanceof Error || result.kind !== "thread-moved-to-worktree") {
    await notify(
      "The move to a new worktree you allowed did not happen: the host could not carry it out. Nothing was moved.",
    );
    return;
  }
  const outcome = result.outcome;
  if (outcome.status === "moved") {
    await notify(
      `Moved to worktree ${outcome.branch}. This task's uncommitted changes were copied there; the Project's folder still has them.`,
    );
    return;
  }
  await notify(
    `The move to a new worktree you allowed did not happen: ${worktreeMoveRefusalText(outcome.reason, outcome.paths)}`,
  );
}

/** Why a move into a worktree was refused, in the person's words. */
export function worktreeMoveRefusalText(
  reason: CodeThreadWorktreeMoveRefusal,
  paths?: ReadonlyArray<string>,
): string {
  switch (reason) {
    case "already-own-worktree":
      return "this task already works in a worktree of its own.";
    case "not-a-repository":
      return "this folder is not a Git repository, so it has no worktrees.";
    case "server-project":
      return "a task in a Project on a server cannot move into a worktree here.";
    case "plan":
      return "Plan mode is read-only.";
    case "turn-running":
      return "a turn was still running in this task.";
    case "checkout-in-use":
      return "Another task is working in this checkout right now. Ask again when it finishes.";
    case "capture-failed":
      return "this checkout's changes could not be read. Nothing was moved.";
    case "nested-changes":
      return `changes inside ${(paths ?? []).join(", ") || "a submodule or nested repository"} cannot be copied. Commit them there first. Nothing was moved.`;
    case "apply-failed":
      return "the changes could not be copied into the new worktree. Nothing was moved.";
    case "working-folder":
      return "this task works in another of the Project's folders, which a worktree of the main folder does not hold. Nothing was moved.";
    case "unavailable":
      return "the worktree could not be made, or the task is no longer active. Nothing was moved.";
  }
}
