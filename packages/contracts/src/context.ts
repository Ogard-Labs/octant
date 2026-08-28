import { Schema } from "effect";
import { ImageUsageUnits } from "./imageGeneration";
import { AggregateReference, UtcTimestamp } from "./events";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const ContextManifestId = brandedUuid("ContextManifestId");
export type ContextManifestId = typeof ContextManifestId.Type;
export const ContextPlanId = brandedUuid("ContextPlanId");
export type ContextPlanId = typeof ContextPlanId.Type;
export const ContextEntryId = brandedUuid("ContextEntryId");
export type ContextEntryId = typeof ContextEntryId.Type;
export const ContextSummaryId = brandedUuid("ContextSummaryId");
export type ContextSummaryId = typeof ContextSummaryId.Type;
export const UsageReconciliationId = brandedUuid("UsageReconciliationId");
export type UsageReconciliationId = typeof UsageReconciliationId.Type;
export const CapacityReservationId = brandedUuid("CapacityReservationId");
export type CapacityReservationId = typeof CapacityReservationId.Type;

export const ContextSubjectRef = AggregateReference;
export type ContextSubjectRef = typeof ContextSubjectRef.Type;

export const ContextAccuracy = Schema.Literal(
  "provider-reported",
  "exact-tokenizer",
  "model-family-estimate",
  "conservative-heuristic",
  "unknown",
);
export type ContextAccuracy = typeof ContextAccuracy.Type;

export const KnownTokenMeasurement = Schema.Struct({
  kind: Schema.Literal("known"),
  tokens: NonNegativeInt,
  accuracy: Schema.Literal(
    "provider-reported",
    "exact-tokenizer",
    "model-family-estimate",
    "conservative-heuristic",
  ),
}).annotations(strict);
export type KnownTokenMeasurement = typeof KnownTokenMeasurement.Type;

export const UnknownTokenMeasurement = Schema.Struct({
  kind: Schema.Literal("unknown"),
  accuracy: Schema.Literal("unknown"),
}).annotations(strict);
export type UnknownTokenMeasurement = typeof UnknownTokenMeasurement.Type;

export const TokenMeasurement = Schema.Union(KnownTokenMeasurement, UnknownTokenMeasurement);
export type TokenMeasurement = typeof TokenMeasurement.Type;

export const ContextConfidence = Schema.Literal("high", "medium", "low", "unknown");
export type ContextConfidence = typeof ContextConfidence.Type;

export const ContextMetadataSource = Schema.Literal(
  "runtime-reported",
  "provider-discovery",
  "reviewed-catalog",
  "user-supplied",
  "observed-evidence",
);
export type ContextMetadataSource = typeof ContextMetadataSource.Type;

export const ContextEntryCategory = Schema.Literal(
  "provider-framing",
  "octant-policy",
  "user-instructions",
  "project-instructions",
  "project-memory",
  "conversation",
  "current-request",
  "workspace-context",
  "extension-instructions",
  "octant-tools",
  "mcp",
  "tool-results",
  "subagent-results",
  "reserves",
);
export type ContextEntryCategory = typeof ContextEntryCategory.Type;

export const ContextEntryPosture = Schema.Literal(
  "required",
  "compressible",
  "replaceable",
  "removable",
  "reserved",
);
export type ContextEntryPosture = typeof ContextEntryPosture.Type;

export const ContextEntryState = Schema.Literal(
  "included",
  "summarized",
  "referenced",
  "cached",
  "truncated",
  "omitted",
  "reserved",
);
export type ContextEntryState = typeof ContextEntryState.Type;

export const ContextRetention = Schema.Literal("active", "superseded", "stale");
export type ContextRetention = typeof ContextRetention.Type;

export const ContextHealth = Schema.Literal(
  "healthy",
  "watch",
  "optimizing",
  "action-needed",
  "blocked",
  "rate-limited",
);
export type ContextHealth = typeof ContextHealth.Type;

export const ContextSourceRef = Schema.Struct({
  kind: Schema.Literal(
    "provider",
    "instruction",
    "memory",
    "message",
    "file",
    "artifact",
    "skill",
    "plugin",
    "tool",
    "mcp",
    "subagent",
    "reserve",
    "preview-selection",
    "canvas-selection",
    "summary",
  ),
  referenceId: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ContextSourceRef = typeof ContextSourceRef.Type;

export const ContextPreview = Schema.Struct({
  redacted: Schema.Boolean,
  label: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ContextPreview = typeof ContextPreview.Type;

export const ContextRoutingEligibility = Schema.Union(
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    status: Schema.Literal("eligible"),
    reason: Schema.Literal("selected-provider"),
  }).annotations(strict),
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    status: Schema.Literal("ineligible"),
    reason: Schema.Literal(
      "provider-mismatch",
      "privacy-local-only",
      "cross-provider-opt-in-required",
      "authority-denied",
      "source-disabled",
      "unknown",
    ),
  }).annotations(strict),
);
export type ContextRoutingEligibility = typeof ContextRoutingEligibility.Type;

export const ExtendedContextMode = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("unavailable") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("available"),
    modes: Schema.NonEmptyArray(Schema.NonEmptyTrimmedString),
    activeMode: Schema.optional(Schema.NonEmptyTrimmedString),
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (value) => value.activeMode === undefined || value.modes.includes(value.activeMode),
      ),
    ),
);
export type ExtendedContextMode = typeof ExtendedContextMode.Type;

export const ContextTokenizer = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("exact", "family-estimate", "heuristic"),
    id: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unavailable") }).annotations(strict),
);
export type ContextTokenizer = typeof ContextTokenizer.Type;

export const ModelLimitConflict = Schema.Struct({
  field: Schema.Literal("contextWindow", "maxOutput"),
  values: Schema.NonEmptyArray(PositiveInt),
  sources: Schema.NonEmptyArray(ContextMetadataSource),
}).annotations(strict);
export type ModelLimitConflict = typeof ModelLimitConflict.Type;

export const ModelContextLimits = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  contextWindow: PositiveInt,
  maxOutput: PositiveInt,
  extendedContext: ExtendedContextMode,
  reasoning: Schema.Literal("included", "separate", "unknown"),
  compaction: Schema.Literal("automatic", "manual", "none", "unknown"),
  tokenizer: ContextTokenizer,
  source: ContextMetadataSource,
  confidence: ContextConfidence,
  conflicts: Schema.Array(ModelLimitConflict),
  verifiedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((limits) => limits.maxOutput <= limits.contextWindow));
export type ModelContextLimits = typeof ModelContextLimits.Type;

export const ServiceLimitBucket = Schema.Union(
  Schema.Struct({ status: Schema.Literal("unavailable") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("available"),
    limit: PositiveInt,
    remaining: NonNegativeInt,
    resetsAt: Schema.optional(UtcTimestamp),
  })
    .annotations(strict)
    .pipe(Schema.filter((bucket) => bucket.remaining <= bucket.limit)),
);
export type ServiceLimitBucket = typeof ServiceLimitBucket.Type;

export const ServiceRetryState = Schema.Union(
  Schema.Struct({ status: Schema.Literal("inactive") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("active"), until: UtcTimestamp }).annotations(strict),
);
export type ServiceRetryState = typeof ServiceRetryState.Type;

/**
 * A provider-reported rolling usage window. Providers do not all expose an
 * absolute request/token quota; utilization is therefore optional and is
 * never converted into a fabricated limit or remaining count.
 */
export const ProviderRateLimitWindow = Schema.Struct({
  window: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  status: Schema.Literal("allowed", "warning", "exhausted"),
  utilization: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
  resetsAt: Schema.optional(UtcTimestamp),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type ProviderRateLimitWindow = typeof ProviderRateLimitWindow.Type;

export const ProviderServiceLimits = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  scope: Schema.Literal("provider-instance", "model", "account", "unknown"),
  requests: ServiceLimitBucket,
  tokens: ServiceLimitBucket,
  concurrency: ServiceLimitBucket,
  retry: ServiceRetryState,
  quota: Schema.Literal("available", "exhausted", "unavailable", "unknown"),
  source: ContextMetadataSource,
  confidence: ContextConfidence,
  updatedAt: UtcTimestamp,
  rateLimitWindows: Schema.optional(
    Schema.Array(ProviderRateLimitWindow).pipe(Schema.maxItems(32)),
  ),
}).annotations(strict);
export type ProviderServiceLimits = typeof ProviderServiceLimits.Type;

export const ContextEntry = Schema.Struct({
  id: ContextEntryId,
  source: ContextSourceRef,
  category: ContextEntryCategory,
  label: Schema.NonEmptyTrimmedString,
  eligibility: ContextRoutingEligibility,
  posture: ContextEntryPosture,
  retention: ContextRetention,
  priority: NonNegativeInt,
  originalSize: NonNegativeInt,
  includedSize: NonNegativeInt,
  tokens: TokenMeasurement,
  state: ContextEntryState,
  introducedAtTurn: NonNegativeInt,
  lastUsedAtTurn: Schema.optional(NonNegativeInt),
  reuseCount: NonNegativeInt,
  preview: ContextPreview,
  summaryId: Schema.optional(ContextSummaryId),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (entry) =>
        entry.includedSize <= entry.originalSize &&
        (entry.state !== "omitted" || entry.includedSize === 0) &&
        (entry.eligibility.status === "eligible" || entry.state === "omitted"),
    ),
  );
export type ContextEntry = typeof ContextEntry.Type;

const UniqueContextEntryIds = Schema.Array(ContextEntryId).pipe(
  Schema.filter((ids) => new Set(ids).size === ids.length),
);

export const ContextTurnOverrides = Schema.Struct({
  pinnedEntryIds: UniqueContextEntryIds,
  excludedEntryIds: UniqueContextEntryIds,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (overrides) =>
        !overrides.pinnedEntryIds.some((entryId) => overrides.excludedEntryIds.includes(entryId)),
    ),
  );
export type ContextTurnOverrides = typeof ContextTurnOverrides.Type;

export const ContextManifest = Schema.Struct({
  id: ContextManifestId,
  subject: ContextSubjectRef,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  entries: Schema.Array(ContextEntry),
  overrides: ContextTurnOverrides,
  createdAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (manifest) =>
        new Set(manifest.entries.map((entry) => entry.id)).size === manifest.entries.length &&
        manifest.entries.every(
          (entry) => entry.eligibility.providerInstanceId === manifest.providerInstanceId,
        ) &&
        [...manifest.overrides.pinnedEntryIds, ...manifest.overrides.excludedEntryIds].every(
          (entryId) => manifest.entries.some((entry) => entry.id === entryId),
        ),
    ),
  );
export type ContextManifest = typeof ContextManifest.Type;

export const ContextReserveBreakdown = Schema.Struct({
  response: NonNegativeInt,
  reasoning: NonNegativeInt,
  framing: NonNegativeInt,
  variance: NonNegativeInt,
  safety: NonNegativeInt,
}).annotations(strict);
export type ContextReserveBreakdown = typeof ContextReserveBreakdown.Type;

export const ContextRemedy = Schema.Struct({
  kind: Schema.Literal(
    "unpin-context",
    "exclude-context",
    "compact-range",
    "unload-capabilities",
    "replace-with-reference",
    "reduce-output-reserve",
    "switch-model",
    "fork-thread",
  ),
  entryId: Schema.optional(ContextEntryId),
}).annotations(strict);
export type ContextRemedy = typeof ContextRemedy.Type;

export const ContextPlanEntryReason = Schema.Literal(
  "required",
  "pinned",
  "selected",
  "duplicate",
  "superseded",
  "stale",
  "summarized",
  "referenced",
  "cached",
  "truncated",
  "omitted-to-fit",
  "reserved",
  "ineligible",
  "unknown-size",
);
export type ContextPlanEntryReason = typeof ContextPlanEntryReason.Type;

export const PlannedContextEntry = Schema.Struct({
  entryId: ContextEntryId,
  state: ContextEntryState,
  tokens: TokenMeasurement,
  reason: ContextPlanEntryReason,
}).annotations(strict);
export type PlannedContextEntry = typeof PlannedContextEntry.Type;

export const ContextPlan = Schema.Struct({
  id: ContextPlanId,
  manifestId: ContextManifestId,
  safeInputBudget: NonNegativeInt,
  plannedInputTokens: NonNegativeInt,
  reserves: ContextReserveBreakdown,
  entries: Schema.Array(PlannedContextEntry),
  health: ContextHealth,
  blocked: Schema.Boolean,
  remedies: Schema.Array(ContextRemedy),
  createdAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (plan) =>
        (plan.blocked || plan.plannedInputTokens <= plan.safeInputBudget) &&
        (plan.blocked ? plan.remedies.length > 0 : plan.remedies.length === 0) &&
        plan.blocked === (plan.health === "blocked"),
    ),
  );
export type ContextPlan = typeof ContextPlan.Type;

export const ContextSummary = Schema.Struct({
  id: ContextSummaryId,
  sourceEntryIds: Schema.NonEmptyArray(ContextEntryId),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  createdAt: UtcTimestamp,
  usageCount: NonNegativeInt,
  summaryTokens: KnownTokenMeasurement,
  originalTokens: KnownTokenMeasurement,
  estimatedSavingsTokens: NonNegativeInt,
  replacedSummaryIds: Schema.Array(ContextSummaryId),
})
  .annotations(strict)
  .pipe(Schema.filter((summary) => summary.summaryTokens.tokens <= summary.originalTokens.tokens));
export type ContextSummary = typeof ContextSummary.Type;

const StableRequestShape = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

export const UsageReconciliation = Schema.Struct({
  id: UsageReconciliationId,
  planId: Schema.optional(ContextPlanId),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  requestShape: StableRequestShape,
  plannedInputTokens: NonNegativeInt,
  actualInputTokens: NonNegativeInt,
  actualOutputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  varianceTokens: Schema.Int,
  observedAt: UtcTimestamp,
  imageUnits: Schema.optional(ImageUsageUnits),
})
  .annotations(strict)
  .pipe(
    Schema.filter((reconciliation) => {
      const variance = reconciliation.actualInputTokens - reconciliation.plannedInputTokens;
      if (!Number.isSafeInteger(variance) || reconciliation.varianceTokens !== variance) {
        return false;
      }
      const imageGeneration = reconciliation.requestShape === "image-generation";
      if (imageGeneration) return reconciliation.imageUnits !== undefined;
      return reconciliation.planId !== undefined && reconciliation.imageUnits === undefined;
    }),
  );
export type UsageReconciliation = typeof UsageReconciliation.Type;

export const CapacityReservationState = Schema.Literal(
  "requested",
  "reserved",
  "running",
  "reconciled",
  "released",
  "ambiguous",
);
export type CapacityReservationState = typeof CapacityReservationState.Type;

export const CapacityReservation = Schema.Struct({
  id: CapacityReservationId,
  subject: ContextSubjectRef,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  state: CapacityReservationState,
  estimatedTokens: NonNegativeInt,
  actualTokens: Schema.optional(NonNegativeInt),
  requests: PositiveInt,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (reservation) =>
        reservation.updatedAt >= reservation.createdAt &&
        (reservation.state === "reconciled"
          ? reservation.actualTokens !== undefined
          : reservation.state === "requested" ||
              reservation.state === "reserved" ||
              reservation.state === "running"
            ? reservation.actualTokens === undefined
            : true),
    ),
  );
export type CapacityReservation = typeof CapacityReservation.Type;

export const ContextManifestCreated = Schema.Struct({ manifest: ContextManifest }).annotations(
  strict,
);
export type ContextManifestCreated = typeof ContextManifestCreated.Type;
export const ContextOverridesUpdated = Schema.Struct({
  manifestId: ContextManifestId,
  overrides: ContextTurnOverrides,
}).annotations(strict);
export type ContextOverridesUpdated = typeof ContextOverridesUpdated.Type;
export const ContextPlanCreated = Schema.Struct({ plan: ContextPlan }).annotations(strict);
export type ContextPlanCreated = typeof ContextPlanCreated.Type;
/**
 * A summary is generated from the subject's own conversation, so its text is
 * subject content and must be purgeable when the subject is deleted. The text
 * is written to the subject-owned summary content store under the summary's
 * id, and the event carries only that identity — never the text itself. It
 * stays bounded because context maintenance only ever summarizes bounded
 * material.
 */
export const ContextSummaryContent = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(20_000));
export type ContextSummaryContent = typeof ContextSummaryContent.Type;

export const ContextSummaryCreated = Schema.Struct({
  summary: ContextSummary,
}).annotations(strict);
export type ContextSummaryCreated = typeof ContextSummaryCreated.Type;
export const ContextUsageReconciled = Schema.Struct({
  reconciliation: UsageReconciliation,
}).annotations(strict);
export type ContextUsageReconciled = typeof ContextUsageReconciled.Type;
export const ContextCapacityReservationUpdated = Schema.Struct({
  reservation: CapacityReservation,
}).annotations(strict);
export type ContextCapacityReservationUpdated = typeof ContextCapacityReservationUpdated.Type;

export const CONTEXT_EVENT_NAMES = [
  "context.manifest-created@1",
  "context.overrides-updated@1",
  "context.plan-created@1",
  "context.summary-created@1",
  "context.usage-reconciled@1",
  "context.capacity-reservation-updated@1",
] as const;

export const decodeContextManifestId = Schema.decodeUnknownSync(ContextManifestId);
export const decodeContextPlanId = Schema.decodeUnknownSync(ContextPlanId);
export const decodeContextEntryId = Schema.decodeUnknownSync(ContextEntryId);
export const decodeContextSummaryId = Schema.decodeUnknownSync(ContextSummaryId);
export const decodeUsageReconciliationId = Schema.decodeUnknownSync(UsageReconciliationId);
export const decodeCapacityReservationId = Schema.decodeUnknownSync(CapacityReservationId);
export const decodeContextSubjectRef = Schema.decodeUnknownSync(ContextSubjectRef);
export const decodeTokenMeasurement = Schema.decodeUnknownSync(TokenMeasurement);
export const decodeModelContextLimits = Schema.decodeUnknownSync(ModelContextLimits);
export const decodeProviderServiceLimits = Schema.decodeUnknownSync(ProviderServiceLimits);
export const decodeContextEntry = Schema.decodeUnknownSync(ContextEntry);
export const decodeContextTurnOverrides = Schema.decodeUnknownSync(ContextTurnOverrides);
export const decodeContextManifest = Schema.decodeUnknownSync(ContextManifest);
export const decodeContextReserveBreakdown = Schema.decodeUnknownSync(ContextReserveBreakdown);
export const decodeContextPlan = Schema.decodeUnknownSync(ContextPlan);
export const decodeContextSummary = Schema.decodeUnknownSync(ContextSummary);
export const decodeContextSummaryContent = Schema.decodeUnknownSync(ContextSummaryContent);
export const decodeUsageReconciliation = Schema.decodeUnknownSync(UsageReconciliation);
export const decodeCapacityReservation = Schema.decodeUnknownSync(CapacityReservation);
export const decodeContextManifestCreated = Schema.decodeUnknownSync(ContextManifestCreated);
export const decodeContextOverridesUpdated = Schema.decodeUnknownSync(ContextOverridesUpdated);
export const decodeContextPlanCreated = Schema.decodeUnknownSync(ContextPlanCreated);
export const decodeContextSummaryCreated = Schema.decodeUnknownSync(ContextSummaryCreated);
export const decodeContextUsageReconciled = Schema.decodeUnknownSync(ContextUsageReconciled);
export const decodeContextCapacityReservationUpdated = Schema.decodeUnknownSync(
  ContextCapacityReservationUpdated,
);
