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
    cost: {
      amount: 0.02,
      currency: "USD",
      kind: "api-estimate",
      pricingRevision: "anthropic-api-2026-09-09",
      pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      cacheSavingsUsd: 0.005,
    },
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
          hasMore: false,
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
      cacheSavingsUsd: 0.005,
      cacheSavingsRecordCount: 1,
      pricingReferences: [
        {
          revision: "anthropic-api-2026-09-09",
          source: "https://platform.claude.com/docs/en/about-claude/pricing",
        },
      ],
    });
  });

  it("aggregates more than one bounded pass of retained records", async () => {
    const many = Array.from({ length: 20_001 }, (_, index) => ({
      ...records[0]!,
      sourceEventId: `event-many-${index}`,
    }));
    const response = await readLocalUsageHistoryDashboard({
      sources: [source(many)],
      request,
      queryAt: "2026-09-11T00:00:00.000Z",
    });
    expect(response.totals.requestCount).toBe(20_001);
    expect(response.totals.inputTokens).toBe(30 * 20_001);
  });

  it("keeps bounded Codex and Claude histories in one provider-wide total", async () => {
    const codex = Array.from({ length: 100_000 }, (_, index) => ({
      ...records[0]!,
      sourceEventId: `codex-many-${index}`,
    }));
    const claude = Array.from({ length: 76_000 }, (_, index) => ({
      ...records[2]!,
      sourceEventId: `claude-many-${index}`,
      sourceInstallationId: "install-claude-many",
    }));
    const response = await readLocalUsageHistoryDashboard({
      sources: [source(codex), source(claude)],
      request,
      queryAt: "2026-09-11T00:00:00.000Z",
    });
    expect(response.totals.requestCount).toBe(176_000);
    expect(response.providers).toHaveLength(2);
  });

  it("keeps identical provider sequence IDs from independent installations separate", async () => {
    const first = records[0]!;
    const second = { ...first, sourceInstallationId: "install-2" };
    const response = await readLocalUsageHistoryDashboard({
      sources: [source([first]), source([second])],
      request,
      queryAt: "2026-09-11T00:00:00.000Z",
    });
    expect(response.totals.requestCount).toBe(2);
    expect(response.totals.inputTokens).toBe(60);
  });

  it("marks coverage partial when host totals reach the safe arithmetic bound", async () => {
    const response = await readLocalUsageHistoryDashboard({
      sources: [
        source([
          {
            sourceKind: "codex",
            sourceInstallationId: "install-overflow",
            sourceSessionId: "session-overflow",
            sourceEventId: "event-overflow",
            providerKey: "codex",
            modelId: "gpt-5.6-sol",
            observedAt: "2026-09-11T00:00:00.000Z" as never,
            inputTokens: 5,
            outputTokens: 1,
          },
          {
            sourceKind: "codex",
            sourceInstallationId: "install-overflow",
            sourceSessionId: "session-overflow",
            sourceEventId: "event-overflow-2",
            providerKey: "codex",
            modelId: "gpt-5.6-sol",
            observedAt: "2026-09-11T00:00:00.000Z" as never,
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 1,
          },
        ]),
      ],
      request,
      queryAt: "2026-09-11T00:00:00.000Z",
    });
    expect(response.totals).toMatchObject({
      inputTokens: 5,
      totalTokens: 6,
      outputTokens: 1,
      requestCount: 1,
      excludedRecordCount: 1,
    });
    expect(response.cost.excludedRecordCount).toBe(1);
    expect(response.coverage[0]?.status).toBe("partial");
    expect(response.coverage[0]?.detail).toContain("safe integer");
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
