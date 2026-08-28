import { describe, expect, it } from "vitest";
import {
  decodeUsageRecord,
  decodeUsageQuality,
  decodeAttributionQuality,
  decodeUsageAttributionEntry,
} from "./usage";

const ids = {
  reconciliation: "61000000-0000-4000-8000-000000000001",
  provider: "61000000-0000-4000-8000-000000000002",
  aggregate: "61000000-0000-4000-8000-000000000003",
} as const;

const timestamp = "2026-07-24T12:00:00.000Z";

describe("UsageQuality", () => {
  it("accepts all valid quality values", () => {
    for (const quality of ["exact", "estimated", "reconciled", "stale", "unavailable"]) {
      expect(decodeUsageQuality(quality)).toBe(quality);
    }
  });

  it("rejects invalid quality values", () => {
    expect(() => decodeUsageQuality("bogus")).toThrow();
  });
});

describe("AttributionQuality", () => {
  it("accepts all valid attribution quality values", () => {
    for (const quality of ["exact", "estimated", "unavailable"]) {
      expect(decodeAttributionQuality(quality)).toBe(quality);
    }
  });

  it("rejects invalid attribution quality values", () => {
    expect(() => decodeAttributionQuality("reconciled")).toThrow();
  });
});

describe("UsageAttributionEntry", () => {
  it("decodes a valid attribution entry", () => {
    const entry = decodeUsageAttributionEntry({
      category: "conversation",
      plannedTokens: 100,
      quality: "exact",
    });
    expect(entry.category).toBe("conversation");
    expect(entry.plannedTokens).toBe(100);
    expect(entry.quality).toBe("exact");
  });

  it("rejects negative planned tokens", () => {
    expect(() =>
      decodeUsageAttributionEntry({
        category: "conversation",
        plannedTokens: -1,
        quality: "exact",
      }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeUsageAttributionEntry({
        category: "conversation",
        plannedTokens: 100,
        quality: "exact",
        extra: true,
      }),
    ).toThrow();
  });

  it("decodes optional image units without treating them as tokens", () => {
    const entry = decodeUsageAttributionEntry({
      category: "current-request",
      plannedTokens: 0,
      quality: "exact",
      imageCount: 2,
      imageSize: "1024x1024",
      imageQuality: "high",
    });
    expect(entry.plannedTokens).toBe(0);
    expect(entry.imageCount).toBe(2);
    expect(entry.imageSize).toBe("1024x1024");
    expect(entry.imageQuality).toBe("high");
  });
});

describe("UsageRecord", () => {
  const validRecord = {
    reconciliationId: ids.reconciliation,
    subject: { aggregateType: "chat-thread", aggregateId: ids.aggregate },
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    requestShape: "chat-turn",
    quality: "exact",
    inputTokens: 100,
    outputTokens: 50,
    plannedInputTokens: 95,
    varianceTokens: 5,
    attribution: [
      { category: "conversation", plannedTokens: 60, quality: "exact" },
      { category: "current-request", plannedTokens: 35, quality: "exact" },
    ],
    observedAt: timestamp,
  };

  it("decodes a valid usage record", () => {
    const record = decodeUsageRecord(validRecord);
    expect(record.reconciliationId).toBe(ids.reconciliation);
    expect(record.inputTokens).toBe(100);
    expect(record.outputTokens).toBe(50);
    expect(record.varianceTokens).toBe(5);
    expect(record.attribution).toHaveLength(2);
  });

  it("rejects negative input tokens", () => {
    expect(() => decodeUsageRecord({ ...validRecord, inputTokens: -1 })).toThrow();
  });

  it("rejects negative output tokens", () => {
    expect(() => decodeUsageRecord({ ...validRecord, outputTokens: -1 })).toThrow();
  });

  it("allows negative variance tokens", () => {
    const record = decodeUsageRecord({ ...validRecord, varianceTokens: -5 });
    expect(record.varianceTokens).toBe(-5);
  });

  it("preserves measured advanced dimensions without fabricating unknown values", () => {
    const record = decodeUsageRecord({
      ...validRecord,
      reasoningTokens: 12,
      cacheReadInputTokens: 8,
      cacheWriteInputTokens: 3,
      providerExecutionDurationMs: 450,
    });
    expect(record.reasoningTokens).toBe(12);
    expect(record.cacheReadInputTokens).toBe(8);
    expect(record.cacheWriteInputTokens).toBe(3);
    expect(record.providerExecutionDurationMs).toBe(450);

    const unknown = decodeUsageRecord(validRecord);
    expect(unknown.reasoningTokens).toBeUndefined();
    expect(unknown.cacheReadInputTokens).toBeUndefined();
    expect(unknown.cacheWriteInputTokens).toBeUndefined();
    expect(unknown.providerExecutionDurationMs).toBeUndefined();
  });

  it("rejects invalid request shape", () => {
    expect(() => decodeUsageRecord({ ...validRecord, requestShape: "INVALID SHAPE" })).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() => decodeUsageRecord({ ...validRecord, extra: true })).toThrow();
  });

  it("excludes prompt bodies, file contents, and credentials from schema", () => {
    const record = decodeUsageRecord(validRecord);
    const keys = Object.keys(record);
    expect(keys).not.toContain("promptBody");
    expect(keys).not.toContain("fileContents");
    expect(keys).not.toContain("credentials");
    expect(keys).not.toContain("providerHeaders");
    expect(keys).not.toContain("accountId");
  });
});
