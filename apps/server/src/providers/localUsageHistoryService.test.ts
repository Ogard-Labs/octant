import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { LocalUsageHistoryRecord } from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { readLocalUsageHistoryDashboard } from "./localUsageHistoryService";

const request = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-30T23:59:59.999Z",
  timeZone: "UTC",
} as never;

const records: ReadonlyArray<LocalUsageHistoryRecord> = [
  {
    sourceKind: "codex",
    sourceInstallationId: "install-1",
    sourceSessionId: "session-1",
    sourceEventId: "event-1",
    providerKey: "codex",
    modelId: "gpt-5.6-sol",
    observedAt: "2026-09-09T10:00:00.000Z" as never,
    inputTokens: 30,
    cacheReadInputTokens: 20,
    outputTokens: 5,
  },
  {
    sourceKind: "codex",
    sourceInstallationId: "install-1",
    sourceSessionId: "session-1",
    sourceEventId: "event-2",
    providerKey: "codex",
    modelId: "gpt-5.6-sol",
    observedAt: "2026-09-10T10:00:00.000Z" as never,
    inputTokens: 10,
    outputTokens: 2,
    cost: { amount: 0.01, currency: "USD", kind: "provider-recorded" },
  },
  {
    sourceKind: "claude-code",
    sourceInstallationId: "install-2",
    sourceSessionId: "session-2",
    sourceEventId: "event-1",
    providerKey: "claude-code",
    modelId: "claude-sonnet-4-6",
    observedAt: "2026-09-10T11:00:00.000Z" as never,
    inputTokens: 35,
    uncachedInputTokens: 10,
    cacheReadInputTokens: 20,
    cacheWriteInputTokens: 5,
    outputTokens: 4,
    cost: { amount: 0.02, currency: "USD", kind: "api-estimate" },
  },
];

function source(values: ReadonlyArray<LocalUsageHistoryRecord>): ProviderLocalUsageHistorySource {
  return {
    sourceKind: "codex",
    read: () =>
      Effect.succeed({
        records: values,
        coverage: {
          sourceKind: "codex",
          sourceInstallationId: "install-1",
          status: "ready",
          scannedFileCount: 2,
          acceptedRecordCount: values.length,
          omittedRecordCount: 0,
          truncated: false,
          detail: "synthetic",
        },
      } as never),
  };
}

describe("local usage history aggregation", () => {
  it("deduplicates copied source events and keeps provider/model groups distinct", async () => {
    const response = await readLocalUsageHistoryDashboard({
      sources: [source(records), source([records[0]!])],
      request,
      queryAt: "2026-09-11T00:00:00.000Z",
    });
    expect(response.totals).toMatchObject({
      inputTokens: 75,
      totalTokens: 86,
      outputTokens: 11,
      requestCount: 3,
      sessionCount: 2,
    });
    expect(response.providers).toHaveLength(2);
    expect(response.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerKey: "codex", key: "codex/gpt-5.6-sol" }),
        expect.objectContaining({
          providerKey: "claude-code",
          key: "claude-code/claude-sonnet-4-6",
        }),
      ]),
    );
    expect(response.dailyTotals).toHaveLength(2);
    expect(response.cost).toMatchObject({
      providerRecordedUsd: 0.01,
      apiEstimateUsd: 0.02,
      pricedRecordCount: 2,
      unpricedRecordCount: 1,
    });
  });

  it("omits partial optional component sums while exposing measured coverage", async () => {
    const response = await readLocalUsageHistoryDashboard({
      sources: [source(records)],
      request,
      queryAt: "2026-09-11T00:00:00.000Z",
    });
    expect(response.totals.uncachedInputTokens).toBeUndefined();
    expect(response.totals.componentCoverage.uncachedInput).toEqual({ measured: 1, total: 3 });
    expect(response.totals.cacheReadInputTokens).toBeUndefined();
    expect(response.totals.componentCoverage.cacheRead).toEqual({ measured: 2, total: 3 });
  });
});
