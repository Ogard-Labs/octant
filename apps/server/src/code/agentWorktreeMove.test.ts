import { describe, expect, it, vi } from "vitest";
import type { CodeCommandResult, CodeThread } from "@octant/contracts";
import { runAllowedWorktreeMove } from "./agentWorktreeMove";

const threadId = "20000000-0000-4000-8000-000000000001" as CodeThread["id"];
const windowId = "10000000-0000-4000-8000-000000000001" as never;
const thread = { id: threadId, version: 7 } as CodeThread;

function deps(results: ReadonlyArray<CodeCommandResult | Error>) {
  const queue = [...results];
  const execute = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("no result");
    return next;
  });
  const notify = vi.fn(async () => undefined);
  return {
    execute,
    notify,
    deps: { readThread: () => thread, execute, notify, sleep: async () => undefined },
  };
}

const refused = (reason: string, paths?: ReadonlyArray<string>) =>
  ({
    kind: "thread-moved-to-worktree",
    threadId,
    outcome: { status: "refused", reason, ...(paths === undefined ? {} : { paths }) },
  }) as unknown as CodeCommandResult;

describe("an agent's move into a worktree the person allowed", () => {
  it("a refused agent move leaves a visible notice that names the reason", async () => {
    const fixture = deps([refused("checkout-in-use")]);
    await runAllowedWorktreeMove({ windowId, threadId, turnCompleted: true }, fixture.deps);
    expect(fixture.notify).toHaveBeenCalledWith(
      threadId,
      expect.stringContaining("Another task is working in this checkout"),
    );
    const nested = deps([refused("nested-changes", ["vendor/lib"])]);
    await runAllowedWorktreeMove({ windowId, threadId, turnCompleted: true }, nested.deps);
    expect(nested.notify).toHaveBeenCalledWith(threadId, expect.stringContaining("vendor/lib"));
    const failed = deps([new Error("conflict")]);
    await runAllowedWorktreeMove({ windowId, threadId, turnCompleted: true }, failed.deps);
    expect(failed.notify).toHaveBeenCalledWith(threadId, expect.stringContaining("did not happen"));
  });

  it("says where the thread moved when the move succeeds", async () => {
    const fixture = deps([
      {
        kind: "thread-moved-to-worktree",
        threadId,
        outcome: { status: "moved", branch: "octant/split" },
      } as unknown as CodeCommandResult,
    ]);
    await runAllowedWorktreeMove(
      { windowId, threadId, branchName: "octant/split", turnCompleted: true },
      fixture.deps,
    );
    expect(fixture.execute).toHaveBeenCalledWith(windowId, {
      kind: "move-code-thread-to-worktree",
      threadId,
      expectedVersion: 7,
      branchName: "octant/split",
    });
    expect(fixture.notify).toHaveBeenCalledWith(
      threadId,
      expect.stringContaining("Moved to worktree octant/split"),
    );
  });

  it("waits out the settling turn once, and does not move after a stopped turn", async () => {
    const settling = deps([
      refused("turn-running"),
      {
        kind: "thread-moved-to-worktree",
        threadId,
        outcome: { status: "moved", branch: "octant/a" },
      } as unknown as CodeCommandResult,
    ]);
    await runAllowedWorktreeMove({ windowId, threadId, turnCompleted: true }, settling.deps);
    expect(settling.execute).toHaveBeenCalledTimes(2);
    expect(settling.notify).toHaveBeenCalledWith(threadId, expect.stringContaining("Moved"));

    const stopped = deps([]);
    await runAllowedWorktreeMove({ windowId, threadId, turnCompleted: false }, stopped.deps);
    expect(stopped.execute).not.toHaveBeenCalled();
    expect(stopped.notify).toHaveBeenCalledWith(threadId, expect.stringContaining("stopped"));
  });
});
