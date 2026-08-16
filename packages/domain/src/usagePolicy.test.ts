import { describe, expect, it } from "vitest";
import type { ContextEntry } from "@octant/contracts";
import { buildAttribution, classifyAttributionQuality, classifyUsageQuality } from "./usagePolicy";

const timestamp = "2026-07-24T12:00:00.000Z";

describe("classifyUsageQuality", () => {
  it("returns unavailable when no reconciliation, manifest, or plan exists", () => {
    expect(
      classifyUsageQuality({
        hasReconciliation: false,
        hasManifest: false,
        hasPlan: false,
        varianceTokens: 0,
        observedAt: timestamp,
        now: timestamp,
      }),
    ).toBe("unavailable");
  });

  it("returns estimated when manifest exists but no reconciliation", () => {
    expect(
      classifyUsageQuality({
        hasReconciliation: false,
        hasManifest: true,
        hasPlan: false,
        varianceTokens: 0,
        observedAt: timestamp,
        now: timestamp,
      }),
    ).toBe("estimated");
  });

  it("returns estimated when plan exists but no reconciliation", () => {
    expect(
      classifyUsageQuality({
        hasReconciliation: false,
        hasManifest: false,
        hasPlan: true,
        varianceTokens: 0,
        observedAt: timestamp,
        now: timestamp,
      }),
    ).toBe("estimated");
  });

  it("returns exact when reconciliation has zero variance", () => {
    expect(
      classifyUsageQuality({
        hasReconciliation: true,
        hasManifest: true,
        hasPlan: true,
        varianceTokens: 0,
        observedAt: timestamp,
        now: timestamp,
      }),
    ).toBe("exact");
  });

  it("returns reconciled when reconciliation has non-zero variance", () => {
    expect(
      classifyUsageQuality({
        hasReconciliation: true,
        hasManifest: true,
        hasPlan: true,
        varianceTokens: 42,
        observedAt: timestamp,
        now: timestamp,
      }),
    ).toBe("reconciled");
  });

  it("returns stale when observation is older than threshold", () => {
    const oldTimestamp = "2026-07-23T11:00:00.000Z";
    expect(
      classifyUsageQuality({
        hasReconciliation: true,
        hasManifest: true,
        hasPlan: true,
        varianceTokens: 0,
        observedAt: oldTimestamp,
        now: timestamp,
      }),
    ).toBe("stale");
  });

  it("returns exact when observation is within threshold", () => {
    const recentTimestamp = "2026-07-24T00:00:00.000Z";
    expect(
      classifyUsageQuality({
        hasReconciliation: true,
        hasManifest: true,
        hasPlan: true,
        varianceTokens: 0,
        observedAt: recentTimestamp,
        now: timestamp,
      }),
    ).toBe("exact");
  });

  it("respects custom stale threshold", () => {
    const recentTimestamp = "2026-07-24T11:00:00.000Z";
    expect(
      classifyUsageQuality({
        hasReconciliation: true,
        hasManifest: true,
        hasPlan: true,
        varianceTokens: 0,
        observedAt: recentTimestamp,
        now: timestamp,
        staleThresholdMs: 30 * 60 * 1000,
      }),
    ).toBe("stale");
  });
});

describe("classifyAttributionQuality", () => {
  const baseEntry = {
    id: "61000000-0000-4000-8000-000000000001",
    source: { kind: "message", referenceId: "msg-1" },
    category: "conversation",
    label: "Test entry",
    eligibility: {
      providerInstanceId: "61000000-0000-4000-8000-000000000002",
      status: "eligible",
      reason: "selected-provider",
    },
    posture: "required",
    retention: "active",
    priority: 100,
    originalSize: 100,
    includedSize: 100,
    state: "included",
    introducedAtTurn: 1,
    lastUsedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: "Test entry" },
  } as unknown as ContextEntry;

  it("returns unavailable when no reconciliation exists", () => {
    const entry: ContextEntry = {
      ...baseEntry,
      tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
    } as ContextEntry;
    expect(classifyAttributionQuality(entry, false)).toBe("unavailable");
  });

  it("returns unavailable for unknown token measurements", () => {
    const entry: ContextEntry = {
      ...baseEntry,
      tokens: { kind: "unknown", accuracy: "unknown" },
    } as ContextEntry;
    expect(classifyAttributionQuality(entry, true)).toBe("unavailable");
  });

  it("returns exact for exact-tokenizer accuracy", () => {
    const entry: ContextEntry = {
      ...baseEntry,
      tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
    } as ContextEntry;
    expect(classifyAttributionQuality(entry, true)).toBe("exact");
  });

  it("returns exact for provider-reported accuracy", () => {
    const entry: ContextEntry = {
      ...baseEntry,
      tokens: { kind: "known", tokens: 50, accuracy: "provider-reported" },
    } as ContextEntry;
    expect(classifyAttributionQuality(entry, true)).toBe("exact");
  });

  it("returns estimated for model-family-estimate accuracy", () => {
    const entry: ContextEntry = {
      ...baseEntry,
      tokens: { kind: "known", tokens: 50, accuracy: "model-family-estimate" },
    } as ContextEntry;
    expect(classifyAttributionQuality(entry, true)).toBe("estimated");
  });

  it("returns estimated for conservative-heuristic accuracy", () => {
    const entry: ContextEntry = {
      ...baseEntry,
      tokens: { kind: "known", tokens: 50, accuracy: "conservative-heuristic" },
    } as ContextEntry;
    expect(classifyAttributionQuality(entry, true)).toBe("estimated");
  });
});

describe("buildAttribution", () => {
  const makeEntry = (
    id: string,
    category: ContextEntry["category"],
    tokens: number | null,
    accuracy: string = "exact-tokenizer",
  ): ContextEntry =>
    ({
      id,
      source: { kind: "message", referenceId: `msg-${id}` },
      category,
      label: `Entry ${id}`,
      eligibility: {
        providerInstanceId: "61000000-0000-4000-8000-000000000002",
        status: "eligible",
        reason: "selected-provider",
      },
      posture: "required",
      retention: "active",
      priority: 100,
      originalSize: 100,
      includedSize: 100,
      tokens:
        tokens === null
          ? { kind: "unknown", accuracy: "unknown" }
          : { kind: "known", tokens, accuracy },
      state: "included",
      introducedAtTurn: 1,
      lastUsedAtTurn: 1,
      reuseCount: 0,
      preview: { redacted: true, label: `Entry ${id}` },
    }) as unknown as ContextEntry;

  it("returns empty array for no entries", () => {
    expect(buildAttribution([], true)).toEqual([]);
  });

  it("groups entries by category and sums tokens", () => {
    const entries = [
      makeEntry("1", "conversation", 30),
      makeEntry("2", "conversation", 20),
      makeEntry("3", "current-request", 50),
    ];
    const result = buildAttribution(entries, true);
    expect(result).toEqual([
      { category: "conversation", plannedTokens: 50, quality: "exact" },
      { category: "current-request", plannedTokens: 50, quality: "exact" },
    ]);
  });

  it("degrades quality to estimated when any entry is estimated", () => {
    const entries = [
      makeEntry("1", "conversation", 30, "exact-tokenizer"),
      makeEntry("2", "conversation", 20, "model-family-estimate"),
    ];
    const result = buildAttribution(entries, true);
    expect(result).toEqual([{ category: "conversation", plannedTokens: 50, quality: "estimated" }]);
  });

  it("degrades quality to unavailable when any entry has unknown tokens", () => {
    const entries = [
      makeEntry("1", "conversation", 30, "exact-tokenizer"),
      makeEntry("2", "conversation", null),
    ];
    const result = buildAttribution(entries, true);
    expect(result).toEqual([
      { category: "conversation", plannedTokens: 30, quality: "unavailable" },
    ]);
  });

  it("returns unavailable quality for all entries when no reconciliation", () => {
    const entries = [makeEntry("1", "conversation", 30, "exact-tokenizer")];
    const result = buildAttribution(entries, false);
    expect(result).toEqual([
      { category: "conversation", plannedTokens: 30, quality: "unavailable" },
    ]);
  });

  it("sorts categories alphabetically", () => {
    const entries = [
      makeEntry("1", "tool-results", 10),
      makeEntry("2", "conversation", 20),
      makeEntry("3", "current-request", 30),
    ];
    const result = buildAttribution(entries, true);
    expect(result.map((r) => r.category)).toEqual([
      "conversation",
      "current-request",
      "tool-results",
    ]);
  });
});
