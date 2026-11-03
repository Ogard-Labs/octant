import { describe, expect, it } from "vitest";
import {
  beginAcpUsageTurn,
  finishAcpUsageTurn,
  observeAcpUsage,
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
