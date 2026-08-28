import { describe, expect, it } from "vitest";
import {
  CONTEXT_EVENT_NAMES,
  decodeCapacityReservation,
  decodeContextCapacityReservationUpdated,
  decodeContextEntry,
  decodeContextManifest,
  decodeContextManifestCreated,
  decodeContextOverridesUpdated,
  decodeContextPlan,
  decodeContextPlanCreated,
  decodeContextSummary,
  decodeContextSummaryContent,
  decodeContextSummaryCreated,
  decodeContextUsageReconciled,
  decodeModelContextLimits,
  decodeProviderServiceLimits,
  decodeTokenMeasurement,
  decodeUsageReconciliation,
} from "./context";

const ids = {
  aggregate: "00000000-0000-4000-8000-000000000001",
  entry: "00000000-0000-4000-8000-000000000002",
  manifest: "00000000-0000-4000-8000-000000000003",
  plan: "00000000-0000-4000-8000-000000000004",
  provider: "00000000-0000-4000-8000-000000000005",
  summary: "00000000-0000-4000-8000-000000000006",
  reconciliation: "00000000-0000-4000-8000-000000000007",
  reservation: "00000000-0000-4000-8000-000000000008",
} as const;

const timestamp = "2026-07-18T18:30:00.000Z";

const knownTokens = {
  kind: "known",
  tokens: 120,
  accuracy: "exact-tokenizer",
} as const;

const subject = {
  aggregateType: "context-fixture",
  aggregateId: ids.aggregate,
} as const;

const entry = {
  id: ids.entry,
  source: {
    kind: "message",
    referenceId: "message-1",
  },
  category: "current-request",
  label: "Current request",
  eligibility: {
    providerInstanceId: ids.provider,
    status: "eligible",
    reason: "selected-provider",
  },
  posture: "required",
  retention: "active",
  priority: 100,
  originalSize: 480,
  includedSize: 480,
  tokens: knownTokens,
  state: "included",
  introducedAtTurn: 1,
  lastUsedAtTurn: 1,
  reuseCount: 0,
  preview: {
    redacted: true,
    label: "Current request",
  },
} as const;

describe("context contracts", () => {
  it("keeps unknown token usage non-numeric and rejects excess fields", () => {
    expect(decodeTokenMeasurement(knownTokens)).toEqual(knownTokens);
    expect(decodeTokenMeasurement({ kind: "unknown", accuracy: "unknown" })).toEqual({
      kind: "unknown",
      accuracy: "unknown",
    });
    expect(() =>
      decodeTokenMeasurement({ kind: "unknown", accuracy: "unknown", tokens: 0 }),
    ).toThrow();
  });

  it("decodes strict model limits and rejects credential-shaped excess data", () => {
    const limits = {
      providerInstanceId: ids.provider,
      modelId: "model-a",
      contextWindow: 32_000,
      maxOutput: 4_000,
      extendedContext: { kind: "unavailable" },
      reasoning: "unknown",
      compaction: "manual",
      tokenizer: { kind: "family-estimate", id: "family-a" },
      source: "reviewed-catalog",
      confidence: "medium",
      conflicts: [],
      verifiedAt: timestamp,
    } as const;

    expect(decodeModelContextLimits(limits)).toEqual(limits);
    expect(() => decodeModelContextLimits({ ...limits, apiKey: "secret" })).toThrow();
    expect(() =>
      decodeModelContextLimits({ ...limits, contextWindow: 1_000, maxOutput: 2_000 }),
    ).toThrow();
  });

  it("keeps provider-reported rolling windows separate from numeric quotas", () => {
    const limits = decodeProviderServiceLimits({
      providerInstanceId: ids.provider,
      scope: "account",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: timestamp,
      rateLimitWindows: [
        {
          window: "five_hour",
          status: "warning",
          utilization: 0.87,
          resetsAt: "2026-07-18T19:30:00.000Z",
          observedAt: timestamp,
        },
      ],
    });

    expect(limits.rateLimitWindows).toEqual([
      expect.objectContaining({ window: "five_hour", utilization: 0.87 }),
    ]);
    expect(limits.requests).toEqual({ status: "unavailable" });
  });

  it("represents absent service limits as unavailable rather than unlimited", () => {
    const limits = {
      providerInstanceId: ids.provider,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unavailable",
      source: "runtime-reported",
      confidence: "unknown",
      updatedAt: timestamp,
    } as const;

    expect(decodeProviderServiceLimits(limits)).toEqual(limits);
    expect(() =>
      decodeProviderServiceLimits({
        ...limits,
        requests: { status: "available", limit: 10, remaining: 11 },
      }),
    ).toThrow();
  });

  it("decodes attributed entries without accepting raw source content", () => {
    expect(decodeContextEntry(entry)).toEqual(entry);
    expect(() => decodeContextEntry({ ...entry, content: "raw prompt" })).toThrow();
    expect(() => decodeContextEntry({ ...entry, includedSize: entry.originalSize + 1 })).toThrow();
    expect(() =>
      decodeContextEntry({
        ...entry,
        eligibility: { ...entry.eligibility, status: "ineligible" },
      }),
    ).toThrow();
    expect(() =>
      decodeContextEntry({
        ...entry,
        eligibility: { ...entry.eligibility, reason: "authority-denied" },
      }),
    ).toThrow();
  });

  it("decodes manifests, plans, summaries, usage, and capacity facts", () => {
    const manifest = {
      id: ids.manifest,
      subject,
      providerInstanceId: ids.provider,
      modelId: "model-a",
      entries: [entry],
      overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
      createdAt: timestamp,
    } as const;
    expect(decodeContextManifest(manifest)).toEqual(manifest);
    expect(() =>
      decodeContextManifest({
        ...manifest,
        overrides: { pinnedEntryIds: [ids.summary], excludedEntryIds: [] },
      }),
    ).toThrow();
    expect(() =>
      decodeContextManifest({
        ...manifest,
        overrides: { pinnedEntryIds: [ids.entry], excludedEntryIds: [ids.entry] },
      }),
    ).toThrow();

    const plan = {
      id: ids.plan,
      manifestId: ids.manifest,
      safeInputBudget: 24_000,
      plannedInputTokens: 120,
      reserves: {
        response: 4_000,
        reasoning: 1_000,
        framing: 1_000,
        variance: 1_000,
        safety: 1_000,
      },
      entries: [
        {
          entryId: ids.entry,
          state: "included",
          tokens: knownTokens,
          reason: "required",
        },
      ],
      health: "healthy",
      blocked: false,
      remedies: [],
      createdAt: timestamp,
    } as const;
    expect(decodeContextPlan(plan)).toEqual(plan);
    expect(() =>
      decodeContextPlan({ ...plan, plannedInputTokens: plan.safeInputBudget + 1 }),
    ).toThrow();
    expect(() =>
      decodeContextPlan({ ...plan, blocked: true, remedies: [{ kind: "switch-model" }] }),
    ).toThrow();

    const summary = {
      id: ids.summary,
      sourceEntryIds: [ids.entry],
      providerInstanceId: ids.provider,
      modelId: "model-a",
      createdAt: timestamp,
      usageCount: 0,
      summaryTokens: knownTokens,
      originalTokens: { ...knownTokens, tokens: 500 },
      estimatedSavingsTokens: 380,
      replacedSummaryIds: [],
    } as const;
    expect(decodeContextSummary(summary)).toEqual(summary);

    const reconciliation = {
      id: ids.reconciliation,
      planId: ids.plan,
      providerInstanceId: ids.provider,
      modelId: "model-a",
      requestShape: "chat-streaming",
      plannedInputTokens: 120,
      actualInputTokens: 125,
      actualOutputTokens: 20,
      varianceTokens: 5,
      observedAt: timestamp,
    } as const;
    expect(decodeUsageReconciliation(reconciliation)).toEqual(reconciliation);
    expect(() => decodeUsageReconciliation({ ...reconciliation, varianceTokens: -5 })).toThrow();
    const { planId: _planId, ...reconciliationWithoutPlan } = reconciliation;
    expect(
      decodeUsageReconciliation({
        ...reconciliationWithoutPlan,
        requestShape: "image-generation",
        plannedInputTokens: 0,
        actualInputTokens: 0,
        varianceTokens: 0,
        imageUnits: { count: 1, quality: "exact", size: "1024x1024", outputQuality: "high" },
      }).imageUnits?.count,
    ).toBe(1);
    expect(() =>
      decodeUsageReconciliation({
        ...reconciliation,
        requestShape: "image-generation",
        plannedInputTokens: 0,
        actualInputTokens: 0,
        varianceTokens: 0,
      }),
    ).toThrow();

    const reservation = {
      id: ids.reservation,
      subject,
      providerInstanceId: ids.provider,
      modelId: "model-a",
      state: "reserved",
      estimatedTokens: 140,
      requests: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    expect(decodeCapacityReservation(reservation)).toEqual(reservation);
    expect(() => decodeCapacityReservation({ ...reservation, state: "reconciled" })).toThrow();
    expect(() => decodeCapacityReservation({ ...reservation, actualTokens: 130 })).toThrow();
    expect(() =>
      decodeCapacityReservation({
        ...reservation,
        updatedAt: "2026-07-18T18:29:59.000Z",
      }),
    ).toThrow();

    expect(decodeContextManifestCreated({ manifest })).toEqual({ manifest });
    expect(
      decodeContextOverridesUpdated({ manifestId: ids.manifest, overrides: manifest.overrides }),
    ).toEqual({ manifestId: ids.manifest, overrides: manifest.overrides });
    expect(decodeContextPlanCreated({ plan })).toEqual({ plan });
    expect(decodeContextSummaryCreated({ summary })).toEqual({ summary });
    // The generated text is derived from the subject's own conversation, so it
    // is subject content: it lives in the purgeable summary content store and
    // the journaled event refuses to carry it.
    expect(() =>
      decodeContextSummaryCreated({ summary, content: "Compacted conversation." }),
    ).toThrowError();
    expect(decodeContextSummaryContent("Compacted conversation.")).toBe("Compacted conversation.");
    expect(() => decodeContextSummaryContent("")).toThrowError();
    expect(decodeContextUsageReconciled({ reconciliation })).toEqual({ reconciliation });
    expect(decodeContextCapacityReservationUpdated({ reservation })).toEqual({ reservation });
  });

  it("publishes the versioned context event vocabulary", () => {
    expect(CONTEXT_EVENT_NAMES).toEqual([
      "context.manifest-created@1",
      "context.overrides-updated@1",
      "context.plan-created@1",
      "context.summary-created@1",
      "context.usage-reconciled@1",
      "context.capacity-reservation-updated@1",
    ]);
  });
});
