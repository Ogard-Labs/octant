import { describe, expect, it } from "vitest";
import {
  decodeAggregateVersion,
  decodeEventActor,
  decodeProjectId,
  decodeUtcTimestamp,
  type SpendCeilingState,
} from "@octant/contracts";
import {
  decideSpendCeilingCommand,
  evaluateSpendCeilingAdmission,
  remainingSpendCeilingTokens,
  settleSpendCeilingReservation,
  spendCeilingWindowStart,
  type SpendCeilingScopeFacts,
} from "./spendCeilingPolicy";

const threadId = "72000000-0000-4000-8000-000000000001";
const projectId = decodeProjectId("72000000-0000-4000-8000-000000000002");
const now = decodeUtcTimestamp("2026-09-09T12:00:00.000Z");
const actor = decodeEventActor({
  kind: "local-user",
  actorId: "72000000-0000-4000-8000-000000000003",
});
const version0 = decodeAggregateVersion(0);
const version1 = decodeAggregateVersion(1);

function threadFacts(overrides: Partial<SpendCeilingScopeFacts> = {}): SpendCeilingScopeFacts {
  return {
    scopeKind: "thread",
    scopeId: threadId,
    policy: { tokenBudget: 1_000 },
    committed: { status: "known", tokens: 200 },
    reservedTokens: 0,
    ...overrides,
  };
}

function projectFacts(overrides: Partial<SpendCeilingScopeFacts> = {}): SpendCeilingScopeFacts {
  return {
    scopeKind: "project",
    scopeId: projectId,
    policy: { tokenBudget: 5_000 },
    committed: { status: "known", tokens: 1_000 },
    reservedTokens: 0,
    ...overrides,
  };
}

describe("evaluateSpendCeilingAdmission", () => {
  it("admits a turn when no ceiling is set", () => {
    expect(evaluateSpendCeilingAdmission({})).toEqual({
      status: "admitted",
      reservedTokens: 0,
      reservations: [],
    });
  });

  it("reserves remaining tokens so concurrent turns cannot both admit past the ceiling", () => {
    const first = evaluateSpendCeilingAdmission({
      thread: threadFacts(),
      turnUpperBoundTokens: 500,
    });
    expect(first).toMatchObject({ status: "admitted", reservedTokens: 500 });

    const second = evaluateSpendCeilingAdmission({
      thread: threadFacts({ reservedTokens: 500 }),
      turnUpperBoundTokens: 500,
    });
    expect(second.status).toBe("refused");
    if (second.status !== "refused") return;
    expect(second.refusal.kind).toBe("exhausted");
    expect(second.refusal.scopeKind).toBe("thread");
    expect(second.refusal.remainingTokens).toBe(300);
    expect(second.refusal.recovery).toContain("raise-ceiling");
    expect(second.refusal.message).toContain("thread");
  });

  it("applies the intersection of Project and thread ceilings, including child spend on the parent", () => {
    const childOnParent = evaluateSpendCeilingAdmission({
      project: projectFacts({ committed: { status: "known", tokens: 4_800 } }),
      thread: threadFacts({ committed: { status: "known", tokens: 100 } }),
      turnUpperBoundTokens: 250,
    });
    expect(childOnParent.status).toBe("refused");
    if (childOnParent.status !== "refused") return;
    expect(childOnParent.refusal.scopeKind).toBe("project");
    expect(childOnParent.refusal.message).toContain("Project");
  });

  it("refuses when usage is unavailable rather than treating missing tokens as zero", () => {
    const result = evaluateSpendCeilingAdmission({
      thread: threadFacts({ committed: { status: "unavailable" } }),
      turnUpperBoundTokens: 10,
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.kind).toBe("unknown-spend");
    expect(result.refusal.message).toContain("unavailable");
  });

  it("refuses a hard-ceiling turn that has no per-turn upper bound", () => {
    const result = evaluateSpendCeilingAdmission({
      thread: threadFacts(),
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.kind).toBe("missing-turn-bound");
    expect(result.refusal.recovery).toContain("raise-ceiling");
  });

  it("uses a configured per-turn maximum when no scheduler estimate is offered", () => {
    const result = evaluateSpendCeilingAdmission({
      thread: threadFacts({ policy: { tokenBudget: 1_000, maxTokensPerTurn: 100 } }),
    });
    expect(result).toMatchObject({ status: "admitted", reservedTokens: 100 });
  });

  it("records an overrun as a block that does not silently widen the ceiling", () => {
    const blocked = evaluateSpendCeilingAdmission({
      thread: threadFacts({
        overrun: { reservedTokens: 100, observedTokens: 180, recordedAt: now },
      }),
      turnUpperBoundTokens: 10,
    });
    expect(blocked.status).toBe("refused");
    if (blocked.status !== "refused") return;
    expect(blocked.refusal.kind).toBe("overrun");
    expect(blocked.refusal.overrunTokens).toBe(80);
    expect(blocked.refusal.message).toContain("overrun");
  });
});

describe("evaluateSpendCeilingAdmission turn and run-time budgets", () => {
  it("refuses a Project whose daily agent run time is used up, counting in-flight time", () => {
    const project = projectFacts({
      policy: { runTimeBudgetSeconds: 7_200 },
      committed: { status: "known", tokens: 0 },
      usedTurns: 3,
      usedRunTimeMs: 7_200_000,
    });
    const result = evaluateSpendCeilingAdmission({ project });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal).toMatchObject({
      kind: "exhausted",
      dimension: "run-time",
      scopeKind: "project",
      remainingRunTimeSeconds: 0,
      ceilingRunTimeSeconds: 7_200,
    });
    expect(result.refusal.message).toContain("agent run time ceiling of 2h is used up");
    expect(
      evaluateSpendCeilingAdmission({
        project: { ...project, usedRunTimeMs: 7_199_000 },
      }),
    ).toEqual({ status: "admitted", reservedTokens: 0, reservations: [] });
  });

  it("refuses a Project whose monetary budget is used up", () => {
    const project = projectFacts({
      policy: { costBudgetUsdCents: 25_00 },
      committed: { status: "known", tokens: 0 },
      usedCostUsdCents: 25_00,
    });
    const result = evaluateSpendCeilingAdmission({ project });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal).toMatchObject({
      kind: "exhausted",
      dimension: "monetary",
      scopeKind: "project",
      remainingUsdCents: 0,
      ceilingUsdCents: 25_00,
    });
    expect(result.refusal.message).toContain("money ceiling");
    expect(
      evaluateSpendCeilingAdmission({
        project: { ...project, usedCostUsdCents: 24_99 },
      }),
    ).toEqual({ status: "admitted", reservedTokens: 0, reservations: [] });
  });

  it("refuses a monetary ceiling when the scope's spend cannot be priced", () => {
    const project = projectFacts({
      policy: { costBudgetUsdCents: 25_00 },
      committed: { status: "known", tokens: 0 },
    });
    const result = evaluateSpendCeilingAdmission({ project });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal).toMatchObject({
      kind: "unknown-spend",
      dimension: "monetary",
      ceilingUsdCents: 25_00,
    });
    expect(result.refusal.message).toContain("has no price");
  });

  it("refuses the turn past a thread turn budget and needs no token bound without a token budget", () => {
    const thread = threadFacts({ policy: { turnBudget: 2 }, usedTurns: 1 });
    expect(evaluateSpendCeilingAdmission({ thread }).status).toBe("admitted");
    const full = evaluateSpendCeilingAdmission({ thread: { ...thread, usedTurns: 2 } });
    expect(full.status).toBe("refused");
    if (full.status !== "refused") return;
    expect(full.refusal).toMatchObject({ dimension: "turns", remainingTurns: 0, ceilingTurns: 2 });
  });

  it("refuses rather than assuming zero when the turn ledger is unavailable", () => {
    const result = evaluateSpendCeilingAdmission({
      thread: threadFacts({ policy: { runTimeBudgetSeconds: 60 } }),
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal).toMatchObject({ kind: "unknown-spend", dimension: "run-time" });
  });

  it("enforces the token budget beside a run-time budget on the same ceiling", () => {
    const result = evaluateSpendCeilingAdmission({
      project: projectFacts({
        policy: { tokenBudget: 5_000, runTimeBudgetSeconds: 7_200 },
        committed: { status: "known", tokens: 4_900 },
        usedTurns: 0,
        usedRunTimeMs: 0,
      }),
      turnUpperBoundTokens: 500,
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.dimension).toBe("tokens");
  });
});

describe("settleSpendCeilingReservation", () => {
  it("releases on cancel and records overrun when observed spend exceeds the reservation", () => {
    expect(settleSpendCeilingReservation({ reservedTokens: 100 })).toEqual({ kind: "released" });
    expect(settleSpendCeilingReservation({ reservedTokens: 100, observedTokens: 80 })).toEqual({
      kind: "committed",
      observedTokens: 80,
    });
    expect(settleSpendCeilingReservation({ reservedTokens: 100, observedTokens: 140 })).toEqual({
      kind: "overrun",
      reservedTokens: 100,
      observedTokens: 140,
    });
  });
});

describe("decideSpendCeilingCommand", () => {
  const threadScope = {
    kind: "thread" as const,
    threadType: "chat-thread" as const,
    threadId,
  };
  const projectScope = { kind: "project" as const, projectId };

  it("journals set, raise, and clear as owner commands a person can recover with", () => {
    const set = decideSpendCeilingCommand({
      principalKind: "local-window",
      command: {
        kind: "set-spend-ceiling",
        scope: threadScope,
        expectedVersion: version0,
        policy: { tokenBudget: 1_000 },
        window: { kind: "lifetime" },
      },
      scopeExists: true,
      now,
      actor,
    });
    expect(set.status).toBe("accepted");
    if (set.status !== "accepted") return;
    expect(set.next.policy.tokenBudget).toBe(1_000);

    const current = set.next;
    const raise = decideSpendCeilingCommand({
      principalKind: "local-window",
      command: {
        kind: "raise-spend-ceiling",
        scope: threadScope,
        expectedVersion: current.version,
        tokenBudget: 2_000,
      },
      current,
      scopeExists: true,
      now,
      actor,
    });
    expect(raise.status).toBe("accepted");
    if (raise.status !== "accepted") return;
    expect(raise.next.policy.tokenBudget).toBe(2_000);
    expect(raise.next.overrun).toBeUndefined();
    expect(raise.previousTokenBudget).toBe(1_000);

    const clear = decideSpendCeilingCommand({
      principalKind: "local-window",
      command: {
        kind: "clear-spend-ceiling",
        scope: threadScope,
        expectedVersion: raise.next.version,
      },
      current: raise.next,
      scopeExists: true,
      now,
      actor,
    });
    expect(clear).toEqual({ status: "cleared", scope: threadScope });
  });

  it("refuses a remote principal from setting a ceiling", () => {
    const result = decideSpendCeilingCommand({
      principalKind: "remote-device",
      command: {
        kind: "set-spend-ceiling",
        scope: threadScope,
        expectedVersion: version0,
        policy: { tokenBudget: 1_000 },
        window: { kind: "lifetime" },
      },
      scopeExists: true,
      now,
      actor,
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.kind).toBe("unauthorized");
  });

  it("refuses a raise that would not widen the ceiling", () => {
    const current: SpendCeilingState = {
      scope: threadScope,
      window: { kind: "lifetime" },
      policy: { tokenBudget: 1_000 },
      version: version1,
      setAt: now,
      setBy: actor,
      overrun: { reservedTokens: 100, observedTokens: 150, recordedAt: now },
    };
    const result = decideSpendCeilingCommand({
      principalKind: "local-window",
      command: {
        kind: "raise-spend-ceiling",
        scope: threadScope,
        expectedVersion: version1,
        tokenBudget: 1_000,
      },
      current,
      scopeExists: true,
      now,
      actor,
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.kind).toBe("not-a-raise");
  });

  it("requires a calendar window on a Project ceiling", () => {
    const result = decideSpendCeilingCommand({
      principalKind: "local-window",
      command: {
        kind: "set-spend-ceiling",
        scope: projectScope,
        expectedVersion: version0,
        policy: { tokenBudget: 10_000 },
        window: { kind: "lifetime" },
      },
      scopeExists: true,
      now,
      actor,
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.kind).toBe("invalid-window");
  });

  it("clears an overrun when a person raises the ceiling", () => {
    const current: SpendCeilingState = {
      scope: threadScope,
      window: { kind: "lifetime" },
      policy: { tokenBudget: 1_000 },
      version: version1,
      setAt: now,
      setBy: actor,
      overrun: { reservedTokens: 100, observedTokens: 150, recordedAt: now },
    };
    const raise = decideSpendCeilingCommand({
      principalKind: "local-window",
      command: {
        kind: "raise-spend-ceiling",
        scope: threadScope,
        expectedVersion: version1,
        tokenBudget: 5_000,
      },
      current,
      scopeExists: true,
      now,
      actor,
    });
    expect(raise.status).toBe("accepted");
    if (raise.status !== "accepted") return;
    expect(raise.next.overrun).toBeUndefined();
  });
});

describe("decideSpendCeilingCommand run-time raises", () => {
  const scope = { kind: "project" as const, projectId };
  const current: SpendCeilingState = {
    scope,
    window: { kind: "calendar", period: "day", timeZone: "UTC" },
    policy: { runTimeBudgetSeconds: 7_200 },
    version: version1,
    setAt: now,
    setBy: actor,
  };
  const raise = (fields: {
    readonly runTimeBudgetSeconds?: number;
    readonly turnBudget?: number;
  }) =>
    decideSpendCeilingCommand({
      principalKind: "local-window",
      command: { kind: "raise-spend-ceiling", scope, expectedVersion: version1, ...fields },
      current,
      scopeExists: true,
      now,
      actor,
    });

  it("widens a run-time budget and keeps the window", () => {
    const result = raise({ runTimeBudgetSeconds: 10_800 });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.next.policy).toEqual({ runTimeBudgetSeconds: 10_800 });
    expect(result.next.window).toEqual(current.window);
    expect(result.previousRunTimeBudgetSeconds).toBe(7_200);
  });

  it("refuses to add a budget dimension the ceiling does not have through a raise", () => {
    const result = raise({ turnBudget: 10 });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.kind).toBe("not-a-raise");
    expect(raise({ runTimeBudgetSeconds: 7_200 }).status).toBe("refused");
  });
});

describe("decideSpendCeilingCommand money raises", () => {
  const scope = { kind: "project" as const, projectId };
  const current: SpendCeilingState = {
    scope,
    window: { kind: "calendar", period: "month", timeZone: "UTC" },
    policy: { costBudgetUsdCents: 25_00, turnBudget: 40 },
    version: version1,
    setAt: now,
    setBy: actor,
  };
  const raise = (costBudgetUsdCents: number, policy = current.policy) =>
    decideSpendCeilingCommand({
      principalKind: "local-window",
      command: {
        kind: "raise-spend-ceiling",
        scope,
        expectedVersion: version1,
        costBudgetUsdCents,
      },
      current: { ...current, policy },
      scopeExists: true,
      now,
      actor,
    });

  it("widens a money budget, keeps the other dimensions, and reports the previous amount", () => {
    const result = raise(40_00);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.next.policy).toEqual({ costBudgetUsdCents: 40_00, turnBudget: 40 });
    expect(result.previousCostBudgetUsdCents).toBe(25_00);
  });

  it("refuses a money raise that would lower or keep the budget", () => {
    for (const amount of [25_00, 10_00]) {
      const result = raise(amount);
      expect(result.status).toBe("refused");
      if (result.status !== "refused") continue;
      expect(result.refusal.kind).toBe("not-a-raise");
      expect(result.refusal.message).toContain("money");
    }
  });

  it("refuses to add a money budget to a ceiling that has none through a raise", () => {
    const result = raise(40_00, { turnBudget: 40 });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.kind).toBe("not-a-raise");
  });
});

describe("spendCeilingWindowStart", () => {
  it("leaves a lifetime window unbounded and starts calendar periods in the host time zone", () => {
    expect(spendCeilingWindowStart({ kind: "lifetime" }, now)).toBeUndefined();
    expect(
      spendCeilingWindowStart(
        { kind: "calendar", period: "day", timeZone: "UTC" },
        "2026-09-09T18:30:00.000Z",
      ),
    ).toBe("2026-09-09T00:00:00.000Z");
    expect(
      spendCeilingWindowStart(
        { kind: "calendar", period: "month", timeZone: "UTC" },
        "2026-09-09T18:30:00.000Z",
      ),
    ).toBe("2026-09-01T00:00:00.000Z");
  });

  it("starts a calendar day at local midnight in a non-UTC zone", () => {
    expect(
      spendCeilingWindowStart(
        { kind: "calendar", period: "day", timeZone: "America/New_York" },
        "2026-09-09T18:30:00.000Z",
      ),
    ).toBe("2026-09-09T04:00:00.000Z");
    expect(
      spendCeilingWindowStart(
        { kind: "calendar", period: "day", timeZone: "America/New_York" },
        "2026-09-09T03:00:00.000Z",
      ),
    ).toBe("2026-09-08T04:00:00.000Z");
    expect(
      spendCeilingWindowStart(
        { kind: "calendar", period: "week", timeZone: "America/New_York" },
        "2026-09-09T18:30:00.000Z",
      ),
    ).toBe("2026-09-07T04:00:00.000Z");
  });

  it("keeps DST spring-forward and fall-back midnights in the configured zone", () => {
    expect(
      spendCeilingWindowStart(
        { kind: "calendar", period: "day", timeZone: "America/New_York" },
        "2026-03-08T12:00:00.000Z",
      ),
    ).toBe("2026-03-08T05:00:00.000Z");
    expect(
      spendCeilingWindowStart(
        { kind: "calendar", period: "day", timeZone: "America/New_York" },
        "2026-11-01T12:00:00.000Z",
      ),
    ).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("remainingSpendCeilingTokens", () => {
  it("subtracts committed spend and outstanding reservations", () => {
    expect(
      remainingSpendCeilingTokens({
        tokenBudget: 1_000,
        committedTokens: 200,
        reservedTokens: 100,
      }),
    ).toBe(700);
  });
});
