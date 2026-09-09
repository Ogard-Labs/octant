import { describe, expect, it } from "vitest";
import {
  decodeLocalUsageHistoryRecord,
  decodeLocalUsageHistoryResponse,
  decodeLocalUsageHistoryRequest,
} from "./providerUsageHistory";

const record = {
  sourceKind: "codex",
  sourceInstallationId: "installation",
  sourceSessionId: "session",
  sourceEventId: "event",
  providerKey: "codex",
  modelId: "gpt-5.6-sol",
  observedAt: "2026-09-09T10:00:00.000Z",
  inputTokens: 30,
  outputTokens: 5,
};

describe("provider local usage history contracts", () => {
  it("decodes bounded accounting records without prompt fields", () => {
    expect(decodeLocalUsageHistoryRecord(record)).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
    });
    expect(() => decodeLocalUsageHistoryRecord({ ...record, prompt: "secret" })).toThrow();
  });

  it("retains explicit Claude cache-write TTL partitions", () => {
    expect(
      decodeLocalUsageHistoryRecord({
        ...record,
        providerKey: "claude-code",
        modelId: "claude-sonnet-4-5-20250929",
        inputTokens: 375,
        uncachedInputTokens: 100,
        cacheReadInputTokens: 200,
        cacheWriteInputTokens: 75,
        cacheWrite5mInputTokens: 50,
        cacheWrite1hInputTokens: 25,
        cacheWriteDuration: "unknown",
      }),
    ).toMatchObject({ cacheWrite5mInputTokens: 50, cacheWrite1hInputTokens: 25 });
  });

  it("rejects inverted ranges and unknown timezones", () => {
    expect(() =>
      decodeLocalUsageHistoryRequest({
        from: "2026-09-10T00:00:00.000Z",
        to: "2026-09-09T00:00:00.000Z",
        timeZone: "UTC",
      }),
    ).toThrow();
    expect(() =>
      decodeLocalUsageHistoryRequest({
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-09T00:00:00.000Z",
        timeZone: "Not/AZone",
      }),
    ).toThrow();
  });

  it("requires host-computed totals and component coverage", () => {
    const totals = {
      inputTokens: 30,
      totalTokens: 35,
      outputTokens: 5,
      requestCount: 1,
      sessionCount: 1,
      componentCoverage: {
        uncachedInput: { measured: 0, total: 1 },
        cacheRead: { measured: 0, total: 1 },
        cacheWrite: { measured: 0, total: 1 },
        reasoning: { measured: 0, total: 1 },
      },
    };
    const response = decodeLocalUsageHistoryResponse({
      source: "local-provider-history",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T23:59:59.999Z",
      timeZone: "UTC",
      queryAt: "2026-09-09T12:00:00.000Z",
      totals,
      cost: { pricedRecordCount: 0, unpricedRecordCount: 1 },
      providers: [],
      models: [],
      days: [],
      dailyTotals: [],
      coverage: [],
    });
    expect(response.totals.totalTokens).toBe(35);
  });
});
