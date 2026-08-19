import type { AgentRunAuthority } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  decideGoalLoopRound,
  goalLoopBurnDown,
  goalLoopPauseText,
  mayCompleteGoalLoop,
  narrowGoalLoopCeiling,
  type GoalLoopRoundFacts,
} from "./goalLoopPolicy";

const fullCeiling: AgentRunAuthority = {
  filesystem: true,
  shell: true,
  git: true,
  network: true,
  tools: true,
  subagents: true,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
};

const readOnlyCeiling: AgentRunAuthority = {
  ...fullCeiling,
  shell: false,
  git: false,
  network: false,
  executionPolicy: "plan",
};

function facts(overrides: Partial<GoalLoopRoundFacts> = {}): GoalLoopRoundFacts {
  return {
    loopStatus: "running",
    goalStatus: "active",
    budget: { turnBudget: 10 },
    usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 3 },
    declaredCeiling: fullCeiling,
    liveThreadAuthority: fullCeiling,
    checkpointAvailable: true,
    ...overrides,
  };
}

describe("deciding whether a goal loop may take another round", () => {
  it("runs under the intersection of the declared ceiling and the thread's authority", () => {
    const decision = decideGoalLoopRound(
      facts({ declaredCeiling: fullCeiling, liveThreadAuthority: readOnlyCeiling }),
    );

    expect(decision).toEqual({
      decision: "run",
      authority: { ...readOnlyCeiling, permissionPersistence: "current-session" },
    });
  });

  it("stops before the round that would exceed the budget, rather than after it", () => {
    const decision = decideGoalLoopRound(
      facts({ budget: { turnBudget: 4 }, usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 4 } }),
    );

    expect(decision).toEqual({ decision: "pause", reason: "budget-exhausted" });
  });

  it("refuses to run an unattended loop with no budget at all", () => {
    const decision = decideGoalLoopRound(facts({ budget: {} }));

    expect(decision).toEqual({ decision: "pause", reason: "budget-required" });
  });

  it("pauses on any approval a person is not there to give", () => {
    for (const approvalClass of [
      "destructive-irreversible",
      "privilege-expansion",
      "shell-commands",
      "credential-secret-access",
    ] as const) {
      expect(decideGoalLoopRound(facts({ pendingApprovalClass: approvalClass }))).toEqual({
        decision: "pause",
        reason: "approval-required",
      });
    }
  });

  it("pauses when the thread's authority widened under it", () => {
    const decision = decideGoalLoopRound(
      facts({ previousEffectiveCeiling: readOnlyCeiling, liveThreadAuthority: fullCeiling }),
    );

    expect(decision).toEqual({ decision: "pause", reason: "authority-widened" });
  });

  it("keeps running when the thread's authority narrowed under it", () => {
    const decision = decideGoalLoopRound(
      facts({ previousEffectiveCeiling: fullCeiling, liveThreadAuthority: readOnlyCeiling }),
    );

    expect(decision.decision).toBe("run");
  });

  it("does not start a round it cannot checkpoint first", () => {
    expect(decideGoalLoopRound(facts({ checkpointAvailable: false }))).toEqual({
      decision: "pause",
      reason: "checkpoint-unavailable",
    });
  });

  it("stops for a goal a person paused, and for one already complete", () => {
    expect(decideGoalLoopRound(facts({ goalStatus: "paused" }))).toEqual({
      decision: "pause",
      reason: "goal-paused",
    });
    expect(decideGoalLoopRound(facts({ goalStatus: "complete" }))).toEqual({
      decision: "stop",
      reason: "goal-complete",
    });
    expect(decideGoalLoopRound(facts({ goalStatus: "budget-limited" }))).toEqual({
      decision: "pause",
      reason: "budget-exhausted",
    });
  });

  it("takes no round at all once a person paused or stopped the loop itself", () => {
    expect(decideGoalLoopRound(facts({ loopStatus: "paused" }))).toEqual({
      decision: "pause",
      reason: "paused-by-user",
    });
    expect(decideGoalLoopRound(facts({ loopStatus: "stopped" }))).toEqual({
      decision: "stop",
      reason: "stopped-by-user",
    });
  });
});

describe("what a loop may do to the goal it works on", () => {
  it("cannot complete a goal on a provider's word alone", () => {
    expect(mayCompleteGoalLoop({ evidence: [], providerReportsComplete: true })).toBe(false);
  });

  it("may complete a goal the host can point at evidence for", () => {
    expect(
      mayCompleteGoalLoop({
        evidence: [
          {
            kind: "test",
            referenceId: "run-1",
            summary: "Suite passed",
            observedAt: "2026-08-19T09:00:00.000Z",
          },
        ],
        providerReportsComplete: true,
      } as never),
    ).toBe(true);
  });
});

describe("adjusting a running loop", () => {
  it("accepts a ceiling that only narrows", () => {
    expect(narrowGoalLoopCeiling(fullCeiling, readOnlyCeiling)).toEqual({
      outcome: "narrowed",
      ceiling: readOnlyCeiling,
    });
  });

  it("refuses a ceiling that would widen anything, rather than clamping it quietly", () => {
    expect(narrowGoalLoopCeiling(readOnlyCeiling, fullCeiling)).toEqual({
      outcome: "refused",
      reason: "would-widen",
    });
  });
});

describe("how much of the budget is left", () => {
  it("reports the tightest ceiling as the one that will stop the loop", () => {
    const burn = goalLoopBurnDown(
      { tokenBudget: 1_000, turnBudget: 10 },
      { tokensUsed: 900, elapsedMs: 0, turnsUsed: 2 },
    );

    expect(burn).toEqual({
      fractionSpent: 0.9,
      limiting: "tokens",
      remaining: { tokens: 100, turns: 8 },
    });
  });

  it("says a loop with no budget has nothing to burn down", () => {
    expect(goalLoopBurnDown({}, { tokensUsed: 5, elapsedMs: 5, turnsUsed: 5 })).toEqual({
      fractionSpent: 1,
      limiting: "none",
      remaining: {},
    });
  });
});

describe("saying why a loop stopped", () => {
  it("gives every pause reason words a person can act on", () => {
    for (const reason of [
      "budget-exhausted",
      "budget-required",
      "goal-paused",
      "goal-complete",
      "authority-widened",
      "approval-required",
      "checkpoint-unavailable",
      "paused-by-user",
      "stopped-by-user",
    ] as const) {
      expect(goalLoopPauseText(reason).length).toBeGreaterThan(0);
    }
  });
});
