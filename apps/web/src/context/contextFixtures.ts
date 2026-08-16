import {
  decodeContextInspectorSnapshot,
  type ContextInspectorSnapshot,
} from "@octant/contracts/context-rpc";
import type { ContextHealth } from "@octant/contracts/context";

export interface ContextFixtureOptions {
  readonly health?: ContextHealth;
  readonly plannedReduction?: boolean;
  readonly sequence?: number;
  readonly serviceUpdatedAt?: string;
  readonly snapshotAt?: string;
  readonly unknownTokens?: boolean;
  readonly sourceReference?: string;
}

export function contextFixture(options: ContextFixtureOptions = {}): ContextInspectorSnapshot {
  const health = options.health ?? "healthy";
  const blocked = health === "blocked";
  const subject = {
    aggregateType: "context-subject",
    aggregateId: "10000000-0000-4000-8000-000000000001",
  };
  const providerInstanceId = "20000000-0000-4000-8000-000000000001";
  const manifestId = "30000000-0000-4000-8000-000000000001";
  const planId = "40000000-0000-4000-8000-000000000001";
  const requiredId = "50000000-0000-4000-8000-000000000001";
  const optionalId = "50000000-0000-4000-8000-000000000002";
  const timestamp = "2026-07-18T20:00:00.000Z";
  const snapshotAt = options.snapshotAt ?? timestamp;
  const serviceUpdatedAt = options.serviceUpdatedAt ?? timestamp;
  const required = {
    id: requiredId,
    source: { kind: "message", referenceId: options.sourceReference ?? "canonical-message-1" },
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
    preview: { redacted: true, label: "Request details hidden" },
  };
  const optional = {
    id: optionalId,
    source: { kind: "tool", referenceId: "tool-schema-1" },
    category: "octant-tools",
    label: "Repository search",
    eligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    posture: "removable",
    retention: "active",
    priority: 10,
    originalSize: 240,
    includedSize: 240,
    tokens: options.unknownTokens
      ? { kind: "unknown", accuracy: "unknown" }
      : { kind: "known", tokens: 58, accuracy: "model-family-estimate" },
    state: "included",
    introducedAtTurn: 2,
    lastUsedAtTurn: 2,
    reuseCount: 1,
    preview: { redacted: true, label: "Schema details hidden" },
  };
  const manifest = {
    id: manifestId,
    subject,
    providerInstanceId,
    modelId: "model-a",
    entries: [required, optional],
    overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
    createdAt: timestamp,
  };
  const optionalPlan = options.plannedReduction
    ? {
        entryId: optionalId,
        state: "truncated",
        tokens: { kind: "known", tokens: 21, accuracy: "conservative-heuristic" },
        reason: "truncated",
      }
    : { entryId: optionalId, state: "included", tokens: optional.tokens, reason: "selected" };
  const plannedInputTokens = options.plannedReduction ? 63 : 100;
  const plan = {
    id: planId,
    manifestId,
    safeInputBudget: blocked ? 50 : 900,
    plannedInputTokens,
    reserves: { response: 50, reasoning: 10, framing: 10, variance: 20, safety: 10 },
    entries: [
      { entryId: requiredId, state: "included", tokens: required.tokens, reason: "required" },
      optionalPlan,
    ],
    health,
    blocked,
    remedies: blocked ? [{ kind: "exclude-context", entryId: optionalId }] : [],
    createdAt: timestamp,
  };
  return decodeContextInspectorSnapshot({
    subject,
    sequence: options.sequence ?? 8,
    displayLabel: "Fixture thread",
    snapshotAt,
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
      concurrency: {
        status: "available",
        limit: 2,
        remaining: 1,
        resetsAt: "2026-07-18T20:10:00.000Z",
      },
      retry:
        health === "rate-limited"
          ? { status: "active", until: "2026-07-18T20:05:00.000Z" }
          : { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "medium",
      updatedAt: serviceUpdatedAt,
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
      plannedInputTokens,
      actualInputTokens: plannedInputTokens + 4,
      actualOutputTokens: 20,
      varianceTokens: 4,
      observedAt: timestamp,
    },
    capacity: {
      id: "70000000-0000-4000-8000-000000000001",
      subject,
      providerInstanceId,
      modelId: "model-a",
      state: health === "rate-limited" ? "requested" : "reserved",
      estimatedTokens: 120,
      requests: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    capabilities: { loadedTools: 2, availableTools: 8, loadedMcp: 0, availableMcp: 3 },
  });
}

export function contextStaleFixture(): ContextInspectorSnapshot {
  return contextFixture({
    sequence: 9,
    serviceUpdatedAt: "2026-07-18T20:00:00.000Z",
    snapshotAt: "2026-07-18T20:10:01.000Z",
  });
}

export function contextReplayFixture(): ContextInspectorSnapshot {
  return contextFixture({ sequence: 10, snapshotAt: "2026-07-18T20:00:02.000Z" });
}

export function contextReconnectFixture(): ContextInspectorSnapshot {
  return contextFixture({ sequence: 12, snapshotAt: "2026-07-18T20:00:04.000Z" });
}
