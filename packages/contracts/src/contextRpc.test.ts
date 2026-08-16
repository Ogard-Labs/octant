import { describe, expect, it } from "vitest";
import {
  decodeContextCommand,
  decodeContextCommandResult,
  decodeContextFailure,
  decodeContextInspectorRequest,
  decodeContextInspectorSnapshot,
} from "./contextRpc";

const subject = {
  aggregateType: "context-subject",
  aggregateId: "10000000-0000-4000-8000-000000000001",
};
const providerInstanceId = "20000000-0000-4000-8000-000000000001";
const manifestId = "30000000-0000-4000-8000-000000000001";
const planId = "40000000-0000-4000-8000-000000000001";
const entryId = "50000000-0000-4000-8000-000000000001";
const timestamp = "2026-07-18T20:00:00.000Z";

describe("context RPC contracts", () => {
  it("strictly decodes replay-aware inspector requests and rejects invented thread fields", () => {
    expect(decodeContextInspectorRequest({ subject, afterSequence: 41 })).toEqual({
      subject,
      afterSequence: 41,
    });
    expect(() =>
      decodeContextInspectorRequest({ subject, afterSequence: 41, threadId: "secret" }),
    ).toThrow();
  });

  it("decodes an attributed snapshot without calling unknown limits unlimited", () => {
    const decoded = decodeContextInspectorSnapshot(snapshot());
    expect(decoded.next.plan.health).toBe("watch");
    expect(decoded.serviceLimits.requests).toEqual({ status: "unavailable" });
    expect(decoded.next.manifest.entries[0]?.preview).toEqual({ redacted: true, label: "Request" });
  });

  it("rejects inconsistent snapshot subjects, providers, models, and plan identities", () => {
    expect(() =>
      decodeContextInspectorSnapshot({
        ...snapshot(),
        next: {
          ...snapshot().next,
          plan: { ...snapshot().next.plan, manifestId: "30000000-0000-4000-8000-000000000099" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeContextInspectorSnapshot({
        ...snapshot(),
        modelLimits: {
          ...snapshot().modelLimits,
          providerInstanceId: "20000000-0000-4000-8000-000000000099",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeContextInspectorSnapshot({
        ...snapshot(),
        latestUsage: {
          ...snapshot().latestUsage,
          planId: "40000000-0000-4000-8000-000000000099",
        },
      }),
    ).toThrow();
  });

  it("requires every planned entry to identify exactly one manifest entry", () => {
    expect(() =>
      decodeContextInspectorSnapshot({
        ...snapshot(),
        next: {
          ...snapshot().next,
          plan: { ...snapshot().next.plan, entries: [] },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeContextInspectorSnapshot({
        ...snapshot(),
        next: {
          ...snapshot().next,
          plan: {
            ...snapshot().next.plan,
            entries: [...snapshot().next.plan.entries, { ...snapshot().next.plan.entries[0] }],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeContextInspectorSnapshot({
        ...snapshot(),
        next: {
          ...snapshot().next,
          plan: {
            ...snapshot().next.plan,
            entries: [
              {
                ...snapshot().next.plan.entries[0],
                entryId: "50000000-0000-4000-8000-000000000099",
              },
            ],
          },
        },
      }),
    ).toThrow();
  });

  it("accepts cross-provider summaries and durable historical source provenance", () => {
    const historical = {
      ...summary(),
      providerInstanceId: "20000000-0000-4000-8000-000000000099",
      modelId: "maintenance-model",
      sourceEntryIds: ["50000000-0000-4000-8000-000000000099"],
    };
    expect(
      decodeContextInspectorSnapshot({ ...snapshot(), summaries: [historical] }).summaries[0],
    ).toMatchObject(historical);
    expect(() =>
      decodeContextInspectorSnapshot({
        ...snapshot(),
        summaries: [{ ...historical, sourceEntryIds: [] }],
      }),
    ).toThrow();
  });

  it("requires stale-write protection for turn-scoped override and rebuild commands", () => {
    expect(
      decodeContextCommand({
        kind: "update-context-overrides",
        subject,
        expectedManifestId: manifestId,
        overrides: { pinnedEntryIds: [entryId], excludedEntryIds: [] },
      }).kind,
    ).toBe("update-context-overrides");
    expect(
      decodeContextCommand({
        kind: "rebuild-context-plan",
        subject,
        expectedManifestId: manifestId,
      }).kind,
    ).toBe("rebuild-context-plan");
    expect(() => decodeContextCommand({ kind: "rebuild-context-plan", subject })).toThrow();
    expect(() =>
      decodeContextCommand({
        kind: "update-context-overrides",
        subject,
        expectedManifestId: manifestId,
        overrides: { pinnedEntryIds: [], excludedEntryIds: [], sendAnyway: true },
      }),
    ).toThrow();
  });

  it("uses closed command results and redacted failure categories", () => {
    expect(decodeContextCommandResult({ kind: "context-updated", snapshot: snapshot() }).kind).toBe(
      "context-updated",
    );
    expect(decodeContextFailure({ category: "stale", message: "Reload context." })).toEqual({
      category: "stale",
      message: "Reload context.",
    });
    expect(() =>
      decodeContextFailure({ category: "stale", message: "Reload context.", raw: "token=secret" }),
    ).toThrow();
  });
});

function snapshot(overrides: Record<string, unknown> = {}) {
  const entry = {
    id: entryId,
    source: { kind: "message", referenceId: "canonical-message-1" },
    category: "current-request",
    label: "Current request",
    eligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    posture: "required",
    retention: "active",
    priority: 100,
    originalSize: 180,
    includedSize: 180,
    tokens: { kind: "known", tokens: 42, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 3,
    reuseCount: 0,
    preview: { redacted: true, label: "Request" },
  };
  const manifest = {
    id: manifestId,
    subject,
    providerInstanceId,
    modelId: "model-a",
    entries: [entry],
    overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
    createdAt: timestamp,
  };
  const plan = {
    id: planId,
    manifestId,
    safeInputBudget: 900,
    plannedInputTokens: 42,
    reserves: { response: 50, reasoning: 10, framing: 10, variance: 20, safety: 10 },
    entries: [
      {
        entryId,
        state: "included",
        tokens: { kind: "known", tokens: 42, accuracy: "exact-tokenizer" },
        reason: "required",
      },
    ],
    health: "watch",
    blocked: false,
    remedies: [],
    createdAt: timestamp,
  };
  return {
    subject,
    sequence: 41,
    displayLabel: "Context fixture",
    snapshotAt: timestamp,
    modelLimits: {
      providerInstanceId,
      modelId: "model-a",
      contextWindow: 1000,
      maxOutput: 100,
      extendedContext: { kind: "unavailable" },
      reasoning: "included",
      compaction: "manual",
      tokenizer: { kind: "exact", id: "fixture" },
      source: "runtime-reported",
      confidence: "high",
      conflicts: [],
      verifiedAt: timestamp,
    },
    serviceLimits: {
      providerInstanceId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "available", limit: 2, remaining: 1 },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "medium",
      updatedAt: timestamp,
    },
    next: { manifest, plan },
    latestSent: { manifest, plan },
    summaries: [],
    latestUsage: {
      id: "60000000-0000-4000-8000-000000000001",
      planId,
      providerInstanceId,
      modelId: "model-a",
      requestShape: "fixture-turn",
      plannedInputTokens: 42,
      actualInputTokens: 44,
      actualOutputTokens: 10,
      varianceTokens: 2,
      observedAt: timestamp,
    },
    capacity: undefined,
    capabilities: { loadedTools: 2, availableTools: 8, loadedMcp: 0, availableMcp: 3 },
    ...overrides,
  };
}

function summary() {
  return {
    id: "80000000-0000-4000-8000-000000000001",
    sourceEntryIds: [entryId],
    providerInstanceId,
    modelId: "model-a",
    createdAt: timestamp,
    usageCount: 1,
    summaryTokens: { kind: "known", tokens: 10, accuracy: "exact-tokenizer" },
    originalTokens: { kind: "known", tokens: 42, accuracy: "exact-tokenizer" },
    estimatedSavingsTokens: 32,
    replacedSummaryIds: [],
  };
}
