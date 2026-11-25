import { decodeCodeThreadId, decodeProjectId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { threadHasWork, type ThreadCleanupWorkPorts } from "./threadCleanupWork";

const threadId = decodeCodeThreadId("71000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("71000000-0000-4000-8000-000000000002");

const quiet: ThreadCleanupWorkPorts = {
  projectOf: () => projectId,
  turnInProgress: () => false,
  liveTurn: () => false,
  childWorkGoing: () => false,
  debugSession: () => false,
  threadTerminalRunning: () => false,
  projectTerminalRunning: () => false,
  queuedMessage: () => false,
  pendingWakeups: () => 0,
};

describe("whether a thread still has work in its folder", () => {
  it("is quiet only when everything the host tracks says so", () => {
    expect(threadHasWork(quiet, threadId)).toBe(false);
  });

  it("counts each kind of work the host tracks", () => {
    const busy: Array<Partial<ThreadCleanupWorkPorts>> = [
      { turnInProgress: () => true },
      { liveTurn: () => true },
      { childWorkGoing: () => true },
      { debugSession: () => true },
      { threadTerminalRunning: () => true },
      { projectTerminalRunning: () => true },
      { queuedMessage: () => true },
      { pendingWakeups: () => 1 },
    ];
    for (const override of busy) {
      expect(threadHasWork({ ...quiet, ...override }, threadId), Object.keys(override)[0]).toBe(
        true,
      );
    }
  });

  it("leaves out a shell somewhere in the Project when asked, and nothing else", () => {
    const shell = { ...quiet, projectTerminalRunning: () => true };
    expect(threadHasWork(shell, threadId)).toBe(true);
    expect(threadHasWork(shell, threadId, { ignoreProjectTerminals: true })).toBe(false);
    expect(
      threadHasWork({ ...shell, queuedMessage: () => true }, threadId, {
        ignoreProjectTerminals: true,
      }),
    ).toBe(true);
  });

  it("counts a read that cannot answer as work", () => {
    expect(threadHasWork({ ...quiet, pendingWakeups: () => undefined }, threadId)).toBe(true);
    expect(threadHasWork({ ...quiet, projectOf: () => undefined }, threadId)).toBe(true);
    expect(
      threadHasWork(
        {
          ...quiet,
          liveTurn: () => {
            throw new Error("registry unavailable");
          },
        },
        threadId,
      ),
    ).toBe(true);
  });
});
