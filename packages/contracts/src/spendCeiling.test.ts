import { describe, expect, it } from "vitest";
import {
  decodeSpendCeilingCommand,
  decodeSpendCeilingPolicy,
  decodeSpendCeilingRefusal,
  decodeSpendCeilingSnapshot,
  decodeSpendCeilingState,
  decodeSpendCeilingWindow,
  SPEND_CEILING_EVENT_NAMES,
} from "./spendCeiling";

const ids = {
  project: "71000000-0000-4000-8000-000000000001",
  thread: "71000000-0000-4000-8000-000000000002",
  actor: "71000000-0000-4000-8000-000000000003",
} as const;
const timestamp = "2026-09-09T12:00:00.000Z";

describe("SpendCeilingPolicy", () => {
  it("decodes a token ceiling and rejects a non-positive budget", () => {
    expect(decodeSpendCeilingPolicy({ tokenBudget: 10_000 })).toEqual({ tokenBudget: 10_000 });
    expect(decodeSpendCeilingPolicy({ tokenBudget: 10_000, maxTokensPerTurn: 2_000 })).toEqual({
      tokenBudget: 10_000,
      maxTokensPerTurn: 2_000,
    });
    expect(() => decodeSpendCeilingPolicy({ tokenBudget: 0 })).toThrow();
    expect(() => decodeSpendCeilingPolicy({ tokenBudget: 10_000, costUsd: 12 })).toThrow();
  });
});

describe("SpendCeilingWindow", () => {
  it("decodes lifetime and calendar windows and rejects an unknown time zone", () => {
    expect(decodeSpendCeilingWindow({ kind: "lifetime" })).toEqual({ kind: "lifetime" });
    expect(
      decodeSpendCeilingWindow({
        kind: "calendar",
        period: "month",
        timeZone: "America/Los_Angeles",
      }),
    ).toMatchObject({ kind: "calendar", period: "month" });
    expect(() =>
      decodeSpendCeilingWindow({
        kind: "calendar",
        period: "month",
        timeZone: "Not/A_Zone",
      }),
    ).toThrow();
  });
});

describe("SpendCeilingState", () => {
  it("decodes a Project ceiling without inventing monetary fields", () => {
    const state = decodeSpendCeilingState({
      scope: { kind: "project", projectId: ids.project },
      window: { kind: "calendar", period: "week", timeZone: "UTC" },
      policy: { tokenBudget: 50_000 },
      version: 1,
      setAt: timestamp,
      setBy: { kind: "local-user", actorId: ids.actor },
    });
    expect(state.policy.tokenBudget).toBe(50_000);
    expect("costUsd" in state.policy).toBe(false);
  });
});

describe("SpendCeilingCommand", () => {
  it("decodes set, raise, and clear commands", () => {
    expect(
      decodeSpendCeilingCommand({
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
        expectedVersion: 0,
        policy: { tokenBudget: 8_000 },
        window: { kind: "lifetime" },
      }).kind,
    ).toBe("set-spend-ceiling");
    expect(
      decodeSpendCeilingCommand({
        kind: "raise-spend-ceiling",
        scope: { kind: "project", projectId: ids.project },
        expectedVersion: 1,
        tokenBudget: 20_000,
      }).kind,
    ).toBe("raise-spend-ceiling");
    expect(
      decodeSpendCeilingCommand({
        kind: "clear-spend-ceiling",
        scope: { kind: "project", projectId: ids.project },
        expectedVersion: 2,
      }).kind,
    ).toBe("clear-spend-ceiling");
  });
});

describe("SpendCeilingRefusal", () => {
  it("names the scope, token dimension, remaining, and a recovery", () => {
    const refusal = decodeSpendCeilingRefusal({
      kind: "exhausted",
      scopeKind: "thread",
      scopeId: ids.thread,
      dimension: "tokens",
      remainingTokens: 200,
      ceilingTokens: 1_000,
      recovery: ["raise-ceiling", "clear-ceiling", "open-usage", "pause-work"],
      message:
        "This thread's token spend ceiling has 200 tokens remaining of 1,000. Raise or clear the ceiling, open Usage for this thread, or pause work.",
    });
    expect(refusal.dimension).toBe("tokens");
    expect(refusal.recovery).toContain("raise-ceiling");
  });
});

describe("SpendCeilingSnapshot", () => {
  it("decodes an empty snapshot when no ceilings are set", () => {
    expect(decodeSpendCeilingSnapshot({})).toEqual({});
  });
});

describe("SPEND_CEILING_EVENT_NAMES", () => {
  it("names the journaled set, raise, clear, and overrun events", () => {
    expect(SPEND_CEILING_EVENT_NAMES).toEqual({
      set: "spend.ceiling-set@1",
      raised: "spend.ceiling-raised@1",
      cleared: "spend.ceiling-cleared@1",
      overrunRecorded: "spend.overrun-recorded@1",
    });
  });
});
