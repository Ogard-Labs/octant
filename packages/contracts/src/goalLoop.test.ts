import { describe, expect, it } from "vitest";
import { decodeGoalLoop, decodeGoalLoopCommand, decodeGoalLoopResult } from "./goalLoop";

const ceiling = {
  filesystem: true,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
};

const loop = {
  id: "11111111-0000-4000-8000-000000000001",
  threadId: "22222222-0000-4000-8000-000000000001",
  goalId: "33333333-0000-4000-8000-000000000001",
  ceiling,
  trigger: { kind: "continuous" },
  status: "running",
  roundsRun: 3,
  startedAt: "2026-08-19T09:00:00.000Z",
  updatedAt: "2026-08-19T09:30:00.000Z",
  version: 4,
};

describe("what a goal loop is on the wire", () => {
  it("accepts a running loop and a stopped one that says why", () => {
    expect(decodeGoalLoop(loop).status).toBe("running");
    expect(
      decodeGoalLoop({ ...loop, status: "budget-limited", pauseReason: "budget-exhausted" })
        .pauseReason,
    ).toBe("budget-exhausted");
  });

  it("refuses a stopped loop that does not say why", () => {
    expect(() => decodeGoalLoop({ ...loop, status: "paused" })).toThrow();
  });

  it("refuses a running loop carrying a reason it stopped", () => {
    expect(() => decodeGoalLoop({ ...loop, pauseReason: "paused-by-user" })).toThrow();
  });

  it("carries a schedule as a trigger rather than as an authority", () => {
    const scheduled = decodeGoalLoop({
      ...loop,
      trigger: { kind: "scheduled", automationId: "44444444-0000-4000-8000-000000000001" },
    });

    expect(scheduled.trigger).toEqual({
      kind: "scheduled",
      automationId: "44444444-0000-4000-8000-000000000001",
    });
    // A trigger names when, and nothing else: there is no authority on it to
    // widen what the round it starts may do.
    expect(Object.keys(scheduled.trigger)).toEqual(["kind", "automationId"]);
  });

  it("refuses a command carrying anything the contract did not name", () => {
    expect(() =>
      decodeGoalLoopCommand({
        kind: "pause-goal-loop",
        threadId: loop.threadId,
        expectedVersion: 4,
        actor: "someone",
      }),
    ).toThrow();
  });

  it("names a refusal in words a caller can show", () => {
    expect(
      decodeGoalLoopResult({
        kind: "goal-loop-refused",
        reason: "would-widen",
        message: "A running loop's ceiling can only narrow.",
      }),
    ).toMatchObject({ reason: "would-widen" });
  });
});
