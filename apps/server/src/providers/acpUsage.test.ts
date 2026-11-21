import { describe, expect, it } from "vitest";
import {
  acpReportedUsageState,
  acpTurnUsage,
  beginAcpReportedTurn,
  beginAcpUsageTurn,
  finishAcpReportedTurn,
  finishAcpUsageTurn,
  observeAcpUsage,
  observeAcpUsageUpdate,
  observedAcpUsageTurn,
  type AcpUsageState,
} from "./acpUsage";

function snapshot(input: number, output: number, cached = 0) {
  return {
    sessionUpdate: "usage_update",
    used: 120,
    size: 200_000,
    cost: { amount: 12, currency: "USD" },
    _meta: { promptTokens: input, completionTokens: output, cachedTokens: cached },
  };
}
function receipt(input: number, output: number, cached = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedReadTokens: cached,
  };
}
function started(): AcpUsageState {
  const state: AcpUsageState = {};
  observeAcpUsage(state, snapshot(1_000, 400, 200));
  beginAcpUsageTurn(state);
  return state;
}

describe("ACP cumulative usage", () => {
  it("reports only this turn's counters and the matching independent context reading", () => {
    const state = started();
    observeAcpUsage(state, snapshot(1_700, 500, 500));
    observeAcpUsage(state, snapshot(1_800, 530, 520));
    expect(finishAcpUsageTurn(state, receipt(1_800, 530, 520))).toEqual({
      kind: "usage",
      inputTokens: 800,
      outputTokens: 130,
      cacheReadInputTokens: 320,
      contextTokens: 120,
      contextWindow: 200_000,
    });
    beginAcpUsageTurn(state);
    observeAcpUsage(state, snapshot(2_000, 550, 550));
    expect(finishAcpUsageTurn(state, receipt(2_000, 550, 550))).toMatchObject({
      inputTokens: 200,
      outputTokens: 20,
      cacheReadInputTokens: 30,
    });
  });

  it("uses final counters without assigning an older notification's context to them", () => {
    const state = started();
    expect(finishAcpUsageTurn(state, receipt(1_100, 410, 200))).toEqual({
      kind: "usage",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 0,
    });
    beginAcpUsageTurn(state);
    expect(finishAcpUsageTurn(state, receipt(1_200, 420, 200))).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it("keeps a turn unavailable when no pre-prompt baseline arrived", () => {
    const state: AcpUsageState = {};
    beginAcpUsageTurn(state);
    observeAcpUsage(state, snapshot(3_000, 100));
    expect(finishAcpUsageTurn(state, receipt(3_000, 100))).toBeUndefined();
  });

  it.each([
    ["missing counters", { sessionUpdate: "usage_update", used: 1, size: 200_000 }],
    ["partial counters", { ...snapshot(1_800, 530), _meta: { promptTokens: 1_800 } }],
    ["negative counters", snapshot(-1, 10)],
    ["fractional counters", snapshot(1.5, 10)],
    ["unsafe counters", snapshot(Number.MAX_SAFE_INTEGER + 1, 10)],
    ["nonfinite window", { ...snapshot(1_800, 530), size: Infinity }],
    ["absent context", { ...snapshot(1_800, 530), used: undefined }],
    ["invalid cached count", snapshot(1_800, 530, 1_801)],
    ["regressing counters", snapshot(900, 390, 190)],
  ])(
    "leaves %s unavailable even when a later update and final receipt are valid",
    (_name, update) => {
      const state = started();
      observeAcpUsage(state, snapshot(1_700, 500, 500));
      observeAcpUsage(state, update);
      observeAcpUsage(state, snapshot(1_800, 530, 520));
      expect(finishAcpUsageTurn(state, receipt(1_800, 530, 520))).toBeUndefined();
    },
  );

  it.each([
    undefined,
    {},
    { inputTokens: 1_800 },
    receipt(900, 390, 190),
    { ...receipt(1_800, 530, 520), totalTokens: 1 },
    { ...receipt(1_800, 530, 520), inputTokens: NaN },
  ])("leaves a missing, malformed or regressing final receipt unavailable", (final) => {
    const state = started();
    observeAcpUsage(state, snapshot(1_800, 530, 520));
    expect(finishAcpUsageTurn(state, final)).toBeUndefined();
  });

  it("keeps omitted cache and cost absent and uses late readings only for the next baseline", () => {
    const state: AcpUsageState = {};
    const update = (input: number) => ({
      ...snapshot(input, 10),
      _meta: { promptTokens: input, completionTokens: 10 },
    });
    observeAcpUsage(state, update(100));
    beginAcpUsageTurn(state);
    observeAcpUsage(state, update(150));
    expect(
      finishAcpUsageTurn(state, { inputTokens: 150, outputTokens: 10, totalTokens: 160 }),
    ).toEqual({
      kind: "usage",
      inputTokens: 50,
      outputTokens: 0,
      contextTokens: 120,
      contextWindow: 200_000,
    });
    observeAcpUsage(state, update(200));
    beginAcpUsageTurn(state);
    observeAcpUsage(state, update(300));
    expect(finishAcpUsageTurn(state, receipt(300, 10))).toMatchObject({ inputTokens: 100 });
  });
});

describe("usage an agent reports in its prompt reply", () => {
  it("adds cached reads back into input for a reviewed reply that carries no total", () => {
    const rule = "input-excludes-cache-reads";
    expect(
      acpTurnUsage({ inputTokens: 100, outputTokens: 20, cachedReadTokens: 300 }, rule),
    ).toEqual({
      kind: "usage",
      inputTokens: 400,
      outputTokens: 20,
      cacheReadInputTokens: 300,
    });
    // Output already counts thinking under this rule, so thought is its reasoning part.
    expect(acpTurnUsage({ inputTokens: 5, outputTokens: 40, thoughtTokens: 30 }, rule)).toEqual({
      kind: "usage",
      inputTokens: 5,
      outputTokens: 40,
      reasoningTokens: 30,
    });
    expect(acpTurnUsage({ inputTokens: 5, outputTokens: 1 }, rule)).toEqual({
      kind: "usage",
      inputTokens: 5,
      outputTokens: 1,
    });
  });

  it("reads no reply without a total unless a reviewed rule says what its input holds", () => {
    expect(
      acpTurnUsage({ inputTokens: 100, outputTokens: 20, cachedReadTokens: 300 }),
    ).toBeUndefined();
  });

  it("reports nothing for a reply without whole counts", () => {
    expect(acpTurnUsage(undefined)).toBeUndefined();
    expect(acpTurnUsage({ inputTokens: "5", outputTokens: 1, totalTokens: 6 })).toBeUndefined();
    expect(acpTurnUsage({ inputTokens: 5, outputTokens: 1.5, totalTokens: 6 })).toBeUndefined();
    expect(
      acpTurnUsage({ inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedReadTokens: -1 }),
    ).toBeUndefined();
  });

  it("adds disjoint cache and thought figures into input and output, keeping thought as reasoning, when the total sums them all", () => {
    expect(
      acpTurnUsage({
        inputTokens: 100,
        outputTokens: 20,
        thoughtTokens: 30,
        cachedReadTokens: 300,
        cachedWriteTokens: 50,
        totalTokens: 500,
      }),
    ).toEqual({
      kind: "usage",
      inputTokens: 450,
      outputTokens: 50,
      reasoningTokens: 30,
      cacheReadInputTokens: 300,
      cacheWriteInputTokens: 50,
    });
  });

  it("keeps input and output as they come when the total shows they already count cache and thought", () => {
    expect(
      acpTurnUsage({
        inputTokens: 400,
        outputTokens: 50,
        thoughtTokens: 30,
        cachedReadTokens: 300,
        totalTokens: 450,
      }),
    ).toEqual({
      kind: "usage",
      inputTokens: 400,
      outputTokens: 50,
      reasoningTokens: 30,
      cacheReadInputTokens: 300,
    });
  });

  it("reads each part inside or outside its parent as the total sums it", () => {
    expect(
      acpTurnUsage({
        inputTokens: 100,
        outputTokens: 50,
        thoughtTokens: 30,
        cachedReadTokens: 300,
        totalTokens: 450,
      }),
    ).toEqual({
      kind: "usage",
      inputTokens: 400,
      outputTokens: 50,
      reasoningTokens: 30,
      cacheReadInputTokens: 300,
    });
    expect(
      acpTurnUsage({
        inputTokens: 400,
        outputTokens: 20,
        thoughtTokens: 30,
        cachedReadTokens: 300,
        totalTokens: 450,
      }),
    ).toEqual({
      kind: "usage",
      inputTokens: 400,
      outputTokens: 50,
      reasoningTokens: 30,
      cacheReadInputTokens: 300,
    });
  });

  it("reports nothing when no reading of the parts adds up to the total", () => {
    expect(
      acpTurnUsage({ inputTokens: 100, outputTokens: 20, cachedReadTokens: 30, totalTokens: 999 }),
    ).toBeUndefined();
  });
});

describe("standard ACP usage updates", () => {
  const reply = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const update = (amount: number, currency = "USD", used = 4_000) => ({
    sessionUpdate: "usage_update",
    used,
    size: 128_000,
    cost: { amount, currency },
  });

  it("charges a new session's turns what its cumulative US-dollar cost grew by", () => {
    const state = acpReportedUsageState("new");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.1));
    expect(finishAcpReportedTurn(state, reply)).toEqual({
      kind: "usage",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.1,
      contextTokens: 4_000,
      contextWindow: 128_000,
    });
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.3, "USD", 6_000));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({
      costUsd: 0.2,
      contextTokens: 6_000,
    });
  });

  it("charges a cost update that arrives after the reply to the next turn and drops stale context", () => {
    const state = acpReportedUsageState("new");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.1));
    finishAcpReportedTurn(state, reply);
    observeAcpUsageUpdate(state, update(0.25));
    beginAcpReportedTurn(state);
    const usage = finishAcpReportedTurn(state, reply);
    expect(usage).toMatchObject({ costUsd: 0.15 });
    expect(usage).not.toHaveProperty("contextTokens");
  });

  it("leaves a turn unpriced when the agent sent no cost update since the last settled turn", () => {
    const state = acpReportedUsageState("new");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.5));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0.5 });
    beginAcpReportedTurn(state);
    const silent = finishAcpReportedTurn(state, reply);
    expect(silent).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(silent).not.toHaveProperty("costUsd");
  });

  it("charges no provider cost for the turn after an unpriced one, whose growth spans both turns, and charges exactly again after that", () => {
    // The unpriced turn is estimated by the ledger; charging the next turn the
    // $0.30 the total grew by would count that turn a second time.
    const state = acpReportedUsageState("new");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.5));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0.5 });
    beginAcpReportedTurn(state);
    expect(finishAcpReportedTurn(state, reply)).not.toHaveProperty("costUsd");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.8));
    const spanning = finishAcpReportedTurn(state, reply);
    expect(spanning).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(spanning).not.toHaveProperty("costUsd");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(1));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0.2 });
  });

  it("keeps charging exact growth while the agent reports a cost every turn", () => {
    const state = acpReportedUsageState("new");
    for (const [amount, expected] of [
      [0.25, 0.25],
      [0.4, 0.15],
      [0.4, 0],
      [1, 0.6],
    ] as const) {
      beginAcpReportedTurn(state);
      observeAcpUsageUpdate(state, update(amount));
      expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: expected });
    }
  });

  it("charges a loaded session's first turn from the cost reported while it loaded", () => {
    const state = acpReportedUsageState("existing");
    observeAcpUsageUpdate(state, update(2));
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(2.4));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0.4 });
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(2.5));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0.1 });
  });

  it("charges zero when the agent restates an unchanged cumulative cost", () => {
    const state = acpReportedUsageState("new");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.5));
    finishAcpReportedTurn(state, reply);
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.5));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0 });
  });

  it("prices no turn of a loaded session until a cost was reported before it", () => {
    const state = acpReportedUsageState("existing");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(5));
    expect(finishAcpReportedTurn(state, reply)).not.toHaveProperty("costUsd");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(5.5));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0.5 });
  });

  it("records no provider cost in another currency or unit, or when the cost fell", () => {
    const credits = acpReportedUsageState("new");
    beginAcpReportedTurn(credits);
    observeAcpUsageUpdate(credits, update(3, "credits"));
    expect(finishAcpReportedTurn(credits, reply)).not.toHaveProperty("costUsd");
    const fell = acpReportedUsageState("existing");
    observeAcpUsageUpdate(fell, update(2));
    beginAcpReportedTurn(fell);
    observeAcpUsageUpdate(fell, update(1));
    expect(finishAcpReportedTurn(fell, reply)).not.toHaveProperty("costUsd");
  });

  it("reports nothing for a turn whose reply carries no usage, and still settles its cost", () => {
    const state = acpReportedUsageState("new");
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.4));
    expect(finishAcpReportedTurn(state, undefined)).toBeUndefined();
    beginAcpReportedTurn(state);
    observeAcpUsageUpdate(state, update(0.5));
    expect(finishAcpReportedTurn(state, reply)).toMatchObject({ costUsd: 0.1 });
  });
});

describe("usage of a turn that fails before its reply", () => {
  it("reports the counters a reviewed agent's snapshots added since the turn began", () => {
    const state = started();
    observeAcpUsage(state, snapshot(1_300, 450, 250));
    expect(observedAcpUsageTurn(state)).toEqual({
      kind: "usage",
      inputTokens: 300,
      outputTokens: 50,
      cacheReadInputTokens: 50,
      contextTokens: 120,
      contextWindow: 200_000,
    });
    expect(observedAcpUsageTurn(state)).toBeUndefined();
  });

  it("reports nothing for a turn that failed before the agent sent any snapshot of its own", () => {
    expect(observedAcpUsageTurn(started())).toBeUndefined();
  });

  it("reports zero for a turn whose fresh snapshot repeats the counters it began with", () => {
    const state = started();
    observeAcpUsage(state, snapshot(1_000, 400, 200));
    expect(observedAcpUsageTurn(state)).toMatchObject({
      kind: "usage",
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
