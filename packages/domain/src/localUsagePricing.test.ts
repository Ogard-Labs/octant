import { describe, expect, it } from "vitest";
import {
  estimateApiEquivalentCost,
  resolveLocalUsageCost,
  type PricingUsageRecord,
} from "./localUsagePricing";

function record(overrides: Partial<PricingUsageRecord> = {}): PricingUsageRecord {
  return {
    modelId: "gpt-5.6-luna",
    inputTokens: 100_000,
    uncachedInputTokens: 60_000,
    cacheReadInputTokens: 30_000,
    cacheWriteInputTokens: 10_000,
    outputTokens: 10_000,
    ...overrides,
  };
}

describe("local usage API-equivalent pricing", () => {
  it("measures cache savings against the same tier with all input uncached", () => {
    const result = estimateApiEquivalentCost("openai", record());
    expect(result.kind).toBe("api-estimate");
    if (result.kind !== "api-estimate") return;
    expect(result.cacheSavingsUsd).toBeCloseTo(0.02 - (0.012 + 0.0006 + 0.0025), 10);
    const writes = estimateApiEquivalentCost(
      "openai",
      record({
        uncachedInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 100000,
        outputTokens: 0,
      }),
    );
    if (writes.kind !== "api-estimate") throw new Error("Expected a priced fixture");
    expect(writes.cacheSavingsUsd).toBeCloseTo(-0.005, 10);
  });
  it("prices GPT-5.6 input partitions and output without adding reasoning twice", () => {
    const result = estimateApiEquivalentCost("openai", record({ reasoningTokens: 4_000 }));
    expect(result.kind).toBe("api-estimate");
    if (result.kind !== "api-estimate") return;
    expect(result.amount).toBeCloseTo(0.012 + 0.0006 + 0.0025 + 0.012, 10);
    expect(result.currency).toBe("USD");
    expect(result.pricingRevision).toBe("2026-09-09");
    expect(result.source.url).toBe("https://developers.openai.com/api/docs/pricing");
  });

  it("uses OpenAI long-context rates only when the documented threshold is crossed", () => {
    const short = estimateApiEquivalentCost(
      "openai",
      record({
        inputTokens: 272_000,
        uncachedInputTokens: 272_000,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1_000,
      }),
    );
    const long = estimateApiEquivalentCost(
      "openai",
      record({
        inputTokens: 272_001,
        uncachedInputTokens: 272_001,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1_000,
      }),
    );
    expect(short.kind).toBe("api-estimate");
    expect(long.kind).toBe("api-estimate");
    if (short.kind !== "api-estimate" || long.kind !== "api-estimate") return;
    expect(long.amount).toBeGreaterThan(short.amount);
  });

  it("prices Claude cache writes with the declared five-minute or one-hour TTL", () => {
    const fiveMinute = estimateApiEquivalentCost(
      "anthropic",
      record({
        modelId: "claude-opus-4-6",
        inputTokens: 1_000_000,
        uncachedInputTokens: 600_000,
        cacheReadInputTokens: 300_000,
        cacheWriteInputTokens: 100_000,
        cacheWriteDuration: "5-minute",
        outputTokens: 100_000,
      }),
    );
    const oneHour = estimateApiEquivalentCost(
      "anthropic",
      record({
        modelId: "claude-opus-4-6",
        inputTokens: 1_000_000,
        uncachedInputTokens: 600_000,
        cacheReadInputTokens: 300_000,
        cacheWriteInputTokens: 100_000,
        cacheWriteDuration: "1-hour",
        outputTokens: 100_000,
      }),
    );
    expect(fiveMinute.kind).toBe("api-estimate");
    expect(oneHour.kind).toBe("api-estimate");
    if (fiveMinute.kind !== "api-estimate" || oneHour.kind !== "api-estimate") return;
    expect(fiveMinute.amount).toBeCloseTo(3 + 0.15 + 0.625 + 2.5, 10);
    expect(oneHour.amount).toBeCloseTo(3 + 0.15 + 1 + 2.5, 10);
  });

  it("prices Claude records when both cache-write TTL partitions are explicit", () => {
    const result = estimateApiEquivalentCost(
      "anthropic",
      record({
        modelId: "claude-opus-4-6",
        inputTokens: 1_000_000,
        uncachedInputTokens: 500_000,
        cacheReadInputTokens: 300_000,
        cacheWriteInputTokens: 200_000,
        cacheWrite5mInputTokens: 100_000,
        cacheWrite1hInputTokens: 100_000,
        outputTokens: 100_000,
      }),
    );
    expect(result).toMatchObject({ kind: "api-estimate", amount: 6.775 });
  });

  it("infers a Claude cache-write total only when both TTL partitions are known", () => {
    const withKnownPartitions = record({
      modelId: "claude-opus-4-6",
      inputTokens: 1_000_000,
      uncachedInputTokens: 500_000,
      cacheReadInputTokens: 300_000,
      cacheWrite5mInputTokens: 100_000,
      cacheWrite1hInputTokens: 100_000,
      outputTokens: 100_000,
    });
    const { cacheWriteInputTokens: _aggregate, ...withoutAggregate } = withKnownPartitions;
    const result = estimateApiEquivalentCost("anthropic", withoutAggregate);
    expect(result).toMatchObject({ kind: "api-estimate", amount: 6.775 });
    expect(
      estimateApiEquivalentCost(
        "anthropic",
        record({
          modelId: "claude-opus-4-6",
          inputTokens: 1_000_000,
          uncachedInputTokens: 700_000,
          cacheReadInputTokens: 300_000,
          cacheWriteInputTokens: 100_000,
          cacheWrite5mInputTokens: 100_000,
          outputTokens: 100_000,
        }),
      ),
    ).toMatchObject({ kind: "unpriced", reason: "missing-cache-write-duration" });
  });

  it("rejects cache-write totals that contradict explicit TTL partitions", () => {
    expect(
      estimateApiEquivalentCost(
        "anthropic",
        record({
          modelId: "claude-opus-4-6",
          inputTokens: 1_000_000,
          uncachedInputTokens: 500_000,
          cacheReadInputTokens: 300_000,
          cacheWriteInputTokens: 150_000,
          cacheWrite5mInputTokens: 100_000,
          cacheWrite1hInputTokens: 100_000,
          outputTokens: 100_000,
        }),
      ),
    ).toMatchObject({ kind: "unpriced", reason: "inconsistent-input-breakdown" });
    expect(
      estimateApiEquivalentCost(
        "anthropic",
        record({
          modelId: "claude-opus-4-6",
          inputTokens: 1_000_000,
          uncachedInputTokens: 500_000,
          cacheReadInputTokens: 300_000,
          cacheWriteInputTokens: 200_000,
          cacheWrite5mInputTokens: 100_000,
          cacheWrite1hInputTokens: 100_000,
          cacheWriteDuration: "5-minute",
          outputTokens: 100_000,
        }),
      ),
    ).toMatchObject({ kind: "unpriced", reason: "inconsistent-input-breakdown" });
  });

  it("leaves a record unpriced when a required cache-write dimension is absent", () => {
    const { cacheWriteInputTokens: _missingWrite, ...withoutWrite } = record();
    const missingWrite = estimateApiEquivalentCost("openai", withoutWrite);
    const { cacheWriteDuration: _missingTtl, ...withoutTtl } = record({
      modelId: "claude-opus-4-6",
    });
    const missingTtl = estimateApiEquivalentCost("anthropic", withoutTtl);
    expect(missingWrite).toMatchObject({ kind: "unpriced", reason: "missing-cache-write" });
    expect(missingTtl).toMatchObject({ kind: "unpriced", reason: "missing-cache-write-duration" });
  });

  it("does not require a Claude-style TTL for OpenAI GPT-5.6 cache writes", () => {
    const { cacheWriteDuration: _duration, ...withoutDuration } = record();
    expect(estimateApiEquivalentCost("openai", withoutDuration)).toMatchObject({
      kind: "api-estimate",
    });
  });

  it("does not guess for unknown models, missing input partitions, or unsupported long context", () => {
    expect(estimateApiEquivalentCost("openai", record({ modelId: "gpt-future" }))).toMatchObject({
      kind: "unpriced",
      reason: "unknown-model",
    });
    const {
      uncachedInputTokens: _uncached,
      cacheReadInputTokens: _cacheRead,
      ...withoutBreakdown
    } = record();
    expect(estimateApiEquivalentCost("openai", withoutBreakdown)).toMatchObject({
      kind: "unpriced",
      reason: "missing-input-breakdown",
    });
    expect(
      estimateApiEquivalentCost(
        "anthropic",
        record({
          modelId: "claude-sonnet-4-5",
          inputTokens: 200_001,
          uncachedInputTokens: 200_001,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
        }),
      ),
    ).toMatchObject({ kind: "unpriced", reason: "long-context-rate-unavailable" });
    expect(
      estimateApiEquivalentCost(
        "anthropic",
        record({
          modelId: "claude-sonnet-4-5-20990101",
          inputTokens: 100,
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
        }),
      ),
    ).toMatchObject({ kind: "unpriced", reason: "unknown-model" });
  });

  it("prices only documented dated Claude snapshots", () => {
    expect(
      estimateApiEquivalentCost(
        "anthropic",
        record({
          modelId: "claude-sonnet-4-5-20250929",
          inputTokens: 100,
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
        }),
      ),
    ).toMatchObject({ kind: "api-estimate" });
    expect(
      estimateApiEquivalentCost(
        "anthropic",
        record({
          modelId: "claude-haiku-4-5-20251001",
          inputTokens: 100,
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
        }),
      ),
    ).toMatchObject({ kind: "api-estimate" });
  });

  it("refuses unsupported cache dimensions and contradictory reasoning counts", () => {
    expect(
      estimateApiEquivalentCost(
        "openai",
        record({
          modelId: "gpt-5-pro",
          inputTokens: 100_000,
          uncachedInputTokens: 99_000,
          cacheReadInputTokens: 1_000,
          cacheWriteInputTokens: 0,
          outputTokens: 10_000,
        }),
      ),
    ).toMatchObject({ kind: "unpriced", reason: "unsupported-cache-read" });
    expect(
      estimateApiEquivalentCost(
        "openai",
        record({
          modelId: "gpt-5",
          inputTokens: 100_000,
          uncachedInputTokens: 99_000,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 1_000,
          outputTokens: 10_000,
        }),
      ),
    ).toMatchObject({ kind: "unpriced", reason: "unsupported-cache-write" });
    expect(estimateApiEquivalentCost("openai", record({ reasoningTokens: 10_001 }))).toMatchObject({
      kind: "unpriced",
      reason: "invalid-token-counts",
    });
  });

  it("prefers an existing provider-recorded cost over an API-equivalent estimate", () => {
    const existing = {
      amount: 0.42,
      currency: "USD" as const,
      kind: "provider-recorded" as const,
    };
    expect(resolveLocalUsageCost("openai", record({ cost: existing }))).toEqual({
      kind: "provider-recorded",
      cost: existing,
    });
  });
});
