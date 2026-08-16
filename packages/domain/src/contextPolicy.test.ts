import { describe, expect, it } from "vitest";
import type { ContextEntry, ContextManifest, ModelContextLimits } from "@octant/contracts";
import {
  ContextPolicyRejected,
  applyContextOverrides,
  calculateSafeInputBudget,
  evaluateContextHealth,
  reduceContextToBudget,
  resolveEffectiveModelLimits,
} from "./contextPolicy";

const ids = {
  aggregate: "00000000-0000-4000-8000-000000000001",
  manifest: "00000000-0000-4000-8000-000000000003",
  provider: "00000000-0000-4000-8000-000000000005",
} as const;

const timestamp = "2026-07-18T18:30:00.000Z";

function modelLimits(overrides: Partial<ModelContextLimits> = {}): ModelContextLimits {
  return {
    providerInstanceId: ids.provider as ModelContextLimits["providerInstanceId"],
    modelId: "model-a" as ModelContextLimits["modelId"],
    contextWindow: 10_000,
    maxOutput: 2_000,
    extendedContext: { kind: "unavailable" },
    reasoning: "unknown",
    compaction: "manual",
    tokenizer: { kind: "family-estimate", id: "family-a" },
    source: "reviewed-catalog",
    confidence: "medium",
    conflicts: [],
    verifiedAt: timestamp as ModelContextLimits["verifiedAt"],
    ...overrides,
  };
}

function contextEntry(
  id: string,
  tokens: number | null,
  overrides: Partial<ContextEntry> = {},
): ContextEntry {
  return {
    id: id as ContextEntry["id"],
    source: { kind: "message", referenceId: `source-${id}` },
    category: "conversation",
    label: id,
    eligibility: {
      providerInstanceId: ids.provider as ContextEntry["eligibility"]["providerInstanceId"],
      status: "eligible",
      reason: "selected-provider",
    },
    posture: "removable",
    retention: "active",
    priority: 10,
    originalSize: 100,
    includedSize: 100,
    tokens:
      tokens === null
        ? { kind: "unknown", accuracy: "unknown" }
        : { kind: "known", tokens, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    lastUsedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: id },
    ...overrides,
  };
}

function manifest(entries: ReadonlyArray<ContextEntry>): ContextManifest {
  return {
    id: ids.manifest as ContextManifest["id"],
    subject: {
      aggregateType: "context-fixture" as ContextManifest["subject"]["aggregateType"],
      aggregateId: ids.aggregate as ContextManifest["subject"]["aggregateId"],
    },
    providerInstanceId: ids.provider as ContextManifest["providerInstanceId"],
    modelId: "model-a" as ContextManifest["modelId"],
    entries,
    overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
    createdAt: timestamp as ContextManifest["createdAt"],
  };
}

describe("context policy", () => {
  it("calculates a non-negative safe input budget from every reserve", () => {
    expect(
      calculateSafeInputBudget(modelLimits(), {
        response: 2_000,
        reasoning: 500,
        framing: 300,
        variance: 200,
        safety: 1_000,
      }),
    ).toEqual({ safeInputBudget: 6_000, blocked: false });

    expect(
      calculateSafeInputBudget(modelLimits({ contextWindow: 1_000 }), {
        response: 2_000,
        reasoning: 0,
        framing: 0,
        variance: 0,
        safety: 0,
      }),
    ).toEqual({ safeInputBudget: 0, blocked: true });

    expect(() =>
      calculateSafeInputBudget(modelLimits({ maxOutput: 1_000 }), {
        response: 1_001,
        reasoning: 0,
        framing: 0,
        variance: 0,
        safety: 0,
      }),
    ).toThrow(ContextPolicyRejected);
  });

  it("resolves conflicting limits conservatively and retains conflict evidence", () => {
    const resolved = resolveEffectiveModelLimits([
      modelLimits({ contextWindow: 32_000, maxOutput: 8_000, source: "runtime-reported" }),
      modelLimits({ contextWindow: 16_000, maxOutput: 4_000, source: "reviewed-catalog" }),
    ]);

    expect(resolved.contextWindow).toBe(16_000);
    expect(resolved.maxOutput).toBe(4_000);
    expect(resolved.conflicts.map((conflict) => conflict.field)).toEqual([
      "contextWindow",
      "maxOutput",
    ]);
  });

  it("uses the least exact tokenizer and only shared extended-context modes", () => {
    const resolved = resolveEffectiveModelLimits([
      modelLimits({
        contextWindow: 16_000,
        tokenizer: { kind: "exact", id: "exact-a" },
        extendedContext: { kind: "available", modes: ["large", "huge"], activeMode: "large" },
      }),
      modelLimits({
        contextWindow: 32_000,
        tokenizer: { kind: "heuristic", id: "heuristic-a" },
        extendedContext: { kind: "available", modes: ["large"] },
      }),
    ]);

    expect(resolved.tokenizer).toEqual({ kind: "heuristic", id: "heuristic-a" });
    expect(resolved.extendedContext).toEqual({ kind: "available", modes: ["large"] });
  });

  it("resolves equivalent limit observations independently of input order", () => {
    const observations = [
      modelLimits({
        source: "runtime-reported",
        verifiedAt: "2026-07-18T18:31:00.000Z" as ModelContextLimits["verifiedAt"],
        tokenizer: { kind: "heuristic", id: "heuristic-b" },
      }),
      modelLimits({
        source: "reviewed-catalog",
        verifiedAt: "2026-07-18T18:30:00.000Z" as ModelContextLimits["verifiedAt"],
        tokenizer: { kind: "heuristic", id: "heuristic-a" },
      }),
    ];

    expect(resolveEffectiveModelLimits(observations)).toEqual(
      resolveEffectiveModelLimits(observations.toReversed()),
    );
  });

  it("applies turn-scoped pins and exclusions without mutating the manifest", () => {
    const pinned = contextEntry("00000000-0000-4000-8000-000000000010", 100);
    const excluded = contextEntry("00000000-0000-4000-8000-000000000011", 100);
    const original = manifest([pinned, excluded]);

    const updated = applyContextOverrides(original, {
      pinnedEntryIds: [pinned.id],
      excludedEntryIds: [excluded.id],
    });

    expect(updated.entries[0]?.posture).toBe("removable");
    expect(updated.entries[1]?.state).toBe("included");
    expect(updated.overrides).toEqual({
      pinnedEntryIds: [pinned.id],
      excludedEntryIds: [excluded.id],
    });
    expect(reduceContextToBudget(updated, 1_000).includedEntryIds).toEqual([pinned.id]);
    expect(original.entries[0]?.posture).toBe("removable");
    expect(original.entries[1]?.state).toBe("included");
  });

  it("rejects contradictory overrides and exclusion of required content", () => {
    const entry = contextEntry("00000000-0000-4000-8000-000000000012", 100, {
      posture: "required",
    });
    expect(() =>
      applyContextOverrides(manifest([entry]), {
        pinnedEntryIds: [entry.id],
        excludedEntryIds: [entry.id],
      }),
    ).toThrow(ContextPolicyRejected);
    expect(() =>
      applyContextOverrides(manifest([entry]), {
        pinnedEntryIds: [],
        excludedEntryIds: [entry.id],
      }),
    ).toThrow(ContextPolicyRejected);
  });

  it("protects the current request and reports an ineligible pinned entry as blocked", () => {
    const currentRequest = contextEntry("00000000-0000-4000-8000-000000000013", 100, {
      category: "current-request",
      posture: "removable",
    });
    expect(() =>
      applyContextOverrides(manifest([currentRequest]), {
        pinnedEntryIds: [],
        excludedEntryIds: [currentRequest.id],
      }),
    ).toThrow(ContextPolicyRejected);

    const ineligible = contextEntry("00000000-0000-4000-8000-000000000014", 100, {
      state: "omitted",
      includedSize: 0,
      eligibility: {
        providerInstanceId: ids.provider as ContextEntry["eligibility"]["providerInstanceId"],
        status: "ineligible",
        reason: "authority-denied",
      },
    });
    const pinned = applyContextOverrides(manifest([ineligible]), {
      pinnedEntryIds: [ineligible.id],
      excludedEntryIds: [],
    });
    const result = reduceContextToBudget(pinned, 1_000);
    expect(result.blocked).toBe(true);
    expect(result.includedEntryIds).not.toContain(ineligible.id);
    expect(result.remedies).not.toHaveLength(0);
  });

  it("reduces duplicates and stale optional entries before lower-priority active entries", () => {
    const required = contextEntry("00000000-0000-4000-8000-000000000020", 500, {
      posture: "required",
      category: "current-request",
    });
    const original = contextEntry("00000000-0000-4000-8000-000000000021", 300);
    const duplicate = contextEntry("00000000-0000-4000-8000-000000000022", 300, {
      source: original.source,
    });
    const stale = contextEntry("00000000-0000-4000-8000-000000000023", 200, {
      retention: "stale",
    });
    const active = contextEntry("00000000-0000-4000-8000-000000000024", 200, {
      priority: 1,
    });

    const result = reduceContextToBudget(
      manifest([required, original, duplicate, stale, active]),
      1_000,
    );

    expect(result.blocked).toBe(false);
    expect(result.reduced.map((item) => item.entryId)).toEqual([duplicate.id, stale.id]);
    expect(result.includedEntryIds).toContain(required.id);
  });

  it("always removes exact duplicates even when the request already fits", () => {
    const optional = contextEntry("00000000-0000-4000-8000-000000000025", 100);
    const required = contextEntry("00000000-0000-4000-8000-000000000026", 100, {
      posture: "required",
      source: optional.source,
    });

    const result = reduceContextToBudget(manifest([optional, required]), 1_000);
    expect(result.reduced).toEqual([{ entryId: optional.id, reason: "duplicate" }]);
    expect(result.includedEntryIds).toEqual([required.id]);
  });

  it("blocks when protected or unknown required context cannot fit", () => {
    const required = contextEntry("00000000-0000-4000-8000-000000000030", 1_200, {
      posture: "required",
    });
    const unknown = contextEntry("00000000-0000-4000-8000-000000000031", null, {
      posture: "required",
    });

    const oversized = reduceContextToBudget(manifest([required]), 1_000);
    expect(oversized.blocked).toBe(true);
    expect(oversized.remedies.map((remedy) => remedy.kind)).toContain("reduce-output-reserve");

    expect(reduceContextToBudget(manifest([unknown]), 1_000).blocked).toBe(true);
  });

  it("derives every context health state without a hidden threshold", () => {
    const base = {
      safeInputBudget: 1_000,
      plannedInputTokens: 100,
      watchHeadroomTokens: 200,
      blocked: false,
      actionNeeded: false,
      optimizing: false,
      rateLimited: false,
    };
    expect(evaluateContextHealth(base)).toBe("healthy");
    expect(evaluateContextHealth({ ...base, plannedInputTokens: 850 })).toBe("watch");
    expect(evaluateContextHealth({ ...base, optimizing: true })).toBe("optimizing");
    expect(evaluateContextHealth({ ...base, actionNeeded: true })).toBe("action-needed");
    expect(evaluateContextHealth({ ...base, blocked: true })).toBe("blocked");
    expect(evaluateContextHealth({ ...base, rateLimited: true })).toBe("rate-limited");
    expect(evaluateContextHealth({ ...base, plannedInputTokens: 1_001 })).toBe("blocked");
  });
});
