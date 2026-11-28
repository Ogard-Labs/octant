import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ImageUsageUnits } from "./imageGeneration";
import { AggregateReference, UtcTimestamp } from "./events";
import { ProviderDriverKind, ProviderInstanceId, ProviderModelId } from "./providers";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

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
export const ContextCompactionId = brandedUuid("ContextCompactionId");
export type ContextCompactionId = typeof ContextCompactionId.Type;

export const ContextSubjectRef = AggregateReference;
export type ContextSubjectRef = typeof ContextSubjectRef.Type;

export const ContextAccuracy = Schema.Literals([
  "provider-reported",
  "exact-tokenizer",
  "model-family-estimate",
  "conservative-heuristic",
  "unknown",
]);
export type ContextAccuracy = typeof ContextAccuracy.Type;

export const KnownTokenMeasurement = Schema.Struct({
  kind: Schema.Literal("known"),
  tokens: NonNegativeInt,
  accuracy: Schema.Literals([
    "provider-reported",
    "exact-tokenizer",
    "model-family-estimate",
    "conservative-heuristic",
  ]),
});
export type KnownTokenMeasurement = typeof KnownTokenMeasurement.Type;

export const UnknownTokenMeasurement = Schema.Struct({
  kind: Schema.Literal("unknown"),
  accuracy: Schema.Literal("unknown"),
});
export type UnknownTokenMeasurement = typeof UnknownTokenMeasurement.Type;

export const TokenMeasurement = Schema.Union([KnownTokenMeasurement, UnknownTokenMeasurement]);
export type TokenMeasurement = typeof TokenMeasurement.Type;

export const ContextConfidence = Schema.Literals(["high", "medium", "low", "unknown"]);
export type ContextConfidence = typeof ContextConfidence.Type;

export const ContextMetadataSource = Schema.Literals([
  "conservative-fallback",
  "runtime-reported",
  "provider-discovery",
  "reviewed-catalog",
  "user-supplied",
  "observed-evidence",
]);
export type ContextMetadataSource = typeof ContextMetadataSource.Type;

export const ContextEntryCategory = Schema.Literals([
  "provider-framing",
  "octant-policy",
  "user-instructions",
  "person-instructions",
  "project-instructions",
  "orchestration-instructions",
  "person-memory",
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
]);
export type ContextEntryCategory = typeof ContextEntryCategory.Type;

export const ContextEntryPosture = Schema.Literals([
  "required",
  "compressible",
  "replaceable",
  "removable",
  "reserved",
]);
export type ContextEntryPosture = typeof ContextEntryPosture.Type;

export const ContextEntryState = Schema.Literals([
  "included",
  "summarized",
  "referenced",
  "cached",
  "truncated",
  "omitted",
  "reserved",
]);
export type ContextEntryState = typeof ContextEntryState.Type;

export const ContextRetention = Schema.Literals(["active", "superseded", "stale"]);
export type ContextRetention = typeof ContextRetention.Type;

export const ContextHealth = Schema.Literals([
  "healthy",
  "watch",
  "optimizing",
  "action-needed",
  "blocked",
  "rate-limited",
]);
export type ContextHealth = typeof ContextHealth.Type;

export const ContextSourceRef = Schema.Struct({
  kind: Schema.Literals([
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
  ]),
  referenceId: NonEmptyTrimmedString,
});
export type ContextSourceRef = typeof ContextSourceRef.Type;

export const ContextPreview = Schema.Struct({
  redacted: Schema.Boolean,
  label: Schema.optional(NonEmptyTrimmedString),
});
export type ContextPreview = typeof ContextPreview.Type;

export const ContextRoutingEligibility = Schema.Union([
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    status: Schema.Literal("eligible"),
    reason: Schema.Literal("selected-provider"),
  }),
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    status: Schema.Literal("ineligible"),
    reason: Schema.Literals([
      "provider-mismatch",
      "privacy-local-only",
      "cross-provider-opt-in-required",
      "authority-denied",
      "source-disabled",
      "unknown",
    ]),
  }),
]);
export type ContextRoutingEligibility = typeof ContextRoutingEligibility.Type;

export const ExtendedContextMode = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
  Schema.Struct({
    kind: Schema.Literal("available"),
    modes: Schema.NonEmptyArray(NonEmptyTrimmedString),
    activeMode: Schema.optional(NonEmptyTrimmedString),
  }).check(
    Schema.makeFilter(
      (value) => value.activeMode === undefined || value.modes.includes(value.activeMode),
    ),
  ),
]);
export type ExtendedContextMode = typeof ExtendedContextMode.Type;

export const ContextTokenizer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["exact", "family-estimate", "heuristic"]),
    id: NonEmptyTrimmedString,
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]);
export type ContextTokenizer = typeof ContextTokenizer.Type;

export const ModelLimitConflict = Schema.Struct({
  field: Schema.Literals(["contextWindow", "maxOutput"]),
  values: Schema.NonEmptyArray(PositiveInt),
  sources: Schema.NonEmptyArray(ContextMetadataSource),
});
export type ModelLimitConflict = typeof ModelLimitConflict.Type;

export const ModelContextLimits = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  contextWindow: PositiveInt,
  maxOutput: Schema.optional(PositiveInt),
  extendedContext: ExtendedContextMode,
  reasoning: Schema.Literals(["included", "separate", "unknown"]),
  compaction: Schema.Literals(["automatic", "manual", "none", "unknown"]),
  tokenizer: ContextTokenizer,
  source: ContextMetadataSource,
  confidence: ContextConfidence,
  conflicts: Schema.Array(ModelLimitConflict),
  verifiedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (limits) => limits.maxOutput === undefined || limits.maxOutput <= limits.contextWindow,
  ),
);
export type ModelContextLimits = typeof ModelContextLimits.Type;

export const ServiceLimitBucket = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({
    status: Schema.Literal("available"),
    limit: PositiveInt,
    remaining: NonNegativeInt,
    resetsAt: Schema.optional(UtcTimestamp),
  }).check(Schema.makeFilter((bucket) => bucket.remaining <= bucket.limit)),
]);
export type ServiceLimitBucket = typeof ServiceLimitBucket.Type;

export const ServiceRetryState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("inactive") }),
  Schema.Struct({ status: Schema.Literal("active"), until: UtcTimestamp }),
]);
export type ServiceRetryState = typeof ServiceRetryState.Type;

/**
 * A provider-reported rolling usage window. Providers do not all expose an
 * absolute request/token quota; utilization is therefore optional and is
 * never converted into a fabricated limit or remaining count.
 */
export const ProviderRateLimitOverage = Schema.Struct({
  status: Schema.Literals(["allowed", "warning", "exhausted"]),
  inUse: Schema.optional(Schema.Boolean),
  resetsAt: Schema.optional(UtcTimestamp),
  disabledReason: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  ),
});
export type ProviderRateLimitOverage = typeof ProviderRateLimitOverage.Type;

export const ProviderRateLimitWindow = Schema.Struct({
  window: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  status: Schema.Literals(["allowed", "warning", "exhausted"]),
  utilization: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  resetsAt: Schema.optional(UtcTimestamp),
  observedAt: UtcTimestamp,
  overage: Schema.optional(ProviderRateLimitOverage),
});
export type ProviderRateLimitWindow = typeof ProviderRateLimitWindow.Type;

export const ProviderServiceLimits = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  scope: Schema.Literals(["provider-instance", "model", "account", "unknown"]),
  requests: ServiceLimitBucket,
  tokens: ServiceLimitBucket,
  concurrency: ServiceLimitBucket,
  retry: ServiceRetryState,
  quota: Schema.Literals(["available", "exhausted", "unavailable", "unknown"]),
  source: ContextMetadataSource,
  confidence: ContextConfidence,
  updatedAt: UtcTimestamp,
  rateLimitWindows: Schema.optional(
    Schema.Array(ProviderRateLimitWindow).check(Schema.isMaxLength(32)),
  ),
});
export type ProviderServiceLimits = typeof ProviderServiceLimits.Type;

export const ContextEntry = Schema.Struct({
  id: ContextEntryId,
  source: ContextSourceRef,
  category: ContextEntryCategory,
  label: NonEmptyTrimmedString,
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
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.includedSize <= entry.originalSize &&
      (entry.state !== "omitted" || entry.includedSize === 0) &&
      (entry.eligibility.status === "eligible" || entry.state === "omitted"),
  ),
);
export type ContextEntry = typeof ContextEntry.Type;

const UniqueContextEntryIds = Schema.Array(ContextEntryId).check(
  Schema.makeFilter((ids) => new Set(ids).size === ids.length),
);

export const ContextTurnOverrides = Schema.Struct({
  pinnedEntryIds: UniqueContextEntryIds,
  excludedEntryIds: UniqueContextEntryIds,
}).check(
  Schema.makeFilter(
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
}).check(
  Schema.makeFilter(
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
});
export type ContextReserveBreakdown = typeof ContextReserveBreakdown.Type;

export const ContextRemedy = Schema.Struct({
  kind: Schema.Literals([
    "unpin-context",
    "exclude-context",
    "compact-range",
    "unload-capabilities",
    "replace-with-reference",
    "reduce-output-reserve",
    "switch-model",
    "fork-thread",
  ]),
  entryId: Schema.optional(ContextEntryId),
});
export type ContextRemedy = typeof ContextRemedy.Type;

export const ContextPlanEntryReason = Schema.Literals([
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
]);
export type ContextPlanEntryReason = typeof ContextPlanEntryReason.Type;

export const PlannedContextEntry = Schema.Struct({
  entryId: ContextEntryId,
  state: ContextEntryState,
  tokens: TokenMeasurement,
  reason: ContextPlanEntryReason,
});
export type PlannedContextEntry = typeof PlannedContextEntry.Type;

export const ContextCapabilityCounts = Schema.Struct({
  loadedTools: NonNegativeInt,
  availableTools: NonNegativeInt,
  loadedMcp: NonNegativeInt,
  availableMcp: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (counts) =>
      counts.loadedTools <= counts.availableTools && counts.loadedMcp <= counts.availableMcp,
  ),
);
export type ContextCapabilityCounts = typeof ContextCapabilityCounts.Type;

export const ContextPlanInspection = Schema.Struct({
  displayLabel: NonEmptyTrimmedString,
  modelLimits: ModelContextLimits,
  serviceLimits: ProviderServiceLimits,
  capabilities: ContextCapabilityCounts,
  requestShape: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  watchHeadroomTokens: NonNegativeInt,
});
export type ContextPlanInspection = typeof ContextPlanInspection.Type;

export const ContextPlan = Schema.Struct({
  id: ContextPlanId,
  manifestId: ContextManifestId,
  inspection: Schema.optional(ContextPlanInspection),
  safeInputBudget: NonNegativeInt,
  plannedInputTokens: NonNegativeInt,
  reserves: ContextReserveBreakdown,
  entries: Schema.Array(PlannedContextEntry),
  health: ContextHealth,
  blocked: Schema.Boolean,
  remedies: Schema.Array(ContextRemedy),
  createdAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
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
}).check(
  Schema.makeFilter((summary) => summary.summaryTokens.tokens <= summary.originalTokens.tokens),
);
export type ContextSummary = typeof ContextSummary.Type;

const StableRequestShape = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

/**
 * What one reconciled request cost, in integer micro-dollars (1e-6 USD).
 * Absent means the request could not be priced — the ledger keeps the row and
 * a monetary spend ceiling treats the window as unpriceable, never as free.
 */
export const UsageCost = Schema.Struct({
  kind: Schema.Literals(["provider-recorded", "api-estimate"]),
  usdMicros: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type UsageCost = typeof UsageCost.Type;

/**
 * A managed child run's turn. The context planner is not on the child path, so
 * this is the one non-image request reconciled without a plan.
 */
export const AGENT_RUN_TURN_REQUEST_SHAPE = "agent-run-turn";

/**
 * The per-run aggregate a child run's usage is journaled on. The `agent-run`
 * aggregate's versions belong to its lifecycle commands, so usage cannot be
 * appended there without invalidating the version a command expects.
 */
export const AGENT_RUN_USAGE_AGGREGATE_TYPE = "agent-run-usage";

/**
 * One Octant Shield review's model call. Like a child turn it has no context
 * plan, so it reconciles against nothing.
 */
export const SHIELD_REVIEW_REQUEST_SHAPE = "shield-review";

/**
 * The per-thread aggregate a Code thread's Shield reviews are journaled on,
 * apart from the thread's own versions. The usage ledger records each under
 * the reviewed thread, so the thread's and its Project's spend ceilings count
 * it.
 */
export const SHIELD_REVIEW_USAGE_AGGREGATE_TYPE = "shield-review-usage";

/**
 * One person-memory distillation of an ended thread. Like a Shield review it
 * has no context plan, so it reconciles against nothing.
 */
export const PERSON_MEMORY_REQUEST_SHAPE = "person-memory";
export const PROVIDER_CLOUD_TURN_REQUEST_SHAPE = "provider-cloud-turn";

/**
 * The per-thread aggregate a thread's distillation is journaled on. The usage
 * ledger records it under the distilled Chat, Work, or Code thread.
 */
export const PERSON_MEMORY_USAGE_AGGREGATE_TYPE = "person-memory-usage";

/**
 * One second opinion on a Work or Code decision. Like a distillation it has no
 * context plan, and it is recorded under the thread that asked.
 */
export const DECISION_REVIEW_REQUEST_SHAPE = "decision-review";
export const DECISION_REVIEW_USAGE_AGGREGATE_TYPE = "decision-review-usage";

/**
 * One image described by the Sees images model for a thread whose model
 * cannot read images. Like a second opinion it has no context plan, and it is
 * recorded under the Chat, Work, or Code thread whose image it was.
 */
export const IMAGE_DESCRIPTION_REQUEST_SHAPE = "image-description";
export const IMAGE_DESCRIPTION_USAGE_AGGREGATE_TYPE = "image-description-usage";

/**
 * One branch name a person asked a model to suggest for a new worktree. No
 * thread exists yet, so it is recorded under the Code Project it was for.
 */
export const WORKTREE_BRANCH_SUGGESTION_REQUEST_SHAPE = "worktree-branch-suggestion";
export const WORKTREE_BRANCH_SUGGESTION_USAGE_AGGREGATE_TYPE = "worktree-branch-suggestion-usage";

export const THREAD_TITLE_REQUEST_SHAPE = "thread-title";
export const THREAD_TITLE_USAGE_AGGREGATE_TYPE = "thread-title-usage";

/**
 * One second-model pull request review turn. Like a Shield review or second
 * opinion it has no context plan, and it is recorded under the reviewed Code
 * thread so the thread's and its Project's spend ceilings count it.
 */
export const PULL_REQUEST_REVIEW_REQUEST_SHAPE = "pull-request-review";
export const VIDEO_GENERATION_REQUEST_SHAPE = "video-generation";
export const PULL_REQUEST_REVIEW_USAGE_AGGREGATE_TYPE = "pull-request-review-usage";

export const UsageReconciliation = Schema.Struct({
  id: UsageReconciliationId,
  planId: Schema.optional(ContextPlanId),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  requestShape: StableRequestShape,
  plannedInputTokens: NonNegativeInt,
  actualInputTokens: NonNegativeInt,
  actualOutputTokens: NonNegativeInt,
  contextTokens: Schema.optional(NonNegativeInt),
  contextWindow: Schema.optional(PositiveInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  varianceTokens: Schema.Int,
  nextVarianceReserve: Schema.optional(NonNegativeInt),
  observedAt: UtcTimestamp,
  imageUnits: Schema.optional(ImageUsageUnits),
  /**
   * Absent or true means the provider reported token facts. False means the
   * request completed without them: the ledger still has a row, classified
   * unavailable, so "requests without reported usage" can count it.
   */
  providerReported: Schema.optional(Schema.Boolean),
  cost: Schema.optional(UsageCost),
}).check(
  Schema.makeFilter((reconciliation) => {
    const variance = reconciliation.actualInputTokens - reconciliation.plannedInputTokens;
    if (!Number.isSafeInteger(variance) || reconciliation.varianceTokens !== variance) {
      return false;
    }
    const imageGeneration = reconciliation.requestShape === "image-generation";
    // An image job has no context plan. One that completed counts its
    // images; one that failed after its provider answered delivered none,
    // and carries no units rather than a count of zero.
    if (imageGeneration) return reconciliation.planId === undefined;
    if (
      reconciliation.requestShape === AGENT_RUN_TURN_REQUEST_SHAPE ||
      reconciliation.requestShape === SHIELD_REVIEW_REQUEST_SHAPE ||
      reconciliation.requestShape === PROVIDER_CLOUD_TURN_REQUEST_SHAPE ||
      reconciliation.requestShape === PERSON_MEMORY_REQUEST_SHAPE ||
      reconciliation.requestShape === DECISION_REVIEW_REQUEST_SHAPE ||
      reconciliation.requestShape === IMAGE_DESCRIPTION_REQUEST_SHAPE ||
      reconciliation.requestShape === THREAD_TITLE_REQUEST_SHAPE ||
      reconciliation.requestShape === WORKTREE_BRANCH_SUGGESTION_REQUEST_SHAPE ||
      reconciliation.requestShape === PULL_REQUEST_REVIEW_REQUEST_SHAPE ||
      // A video job has no context plan and counts no images.
      reconciliation.requestShape === VIDEO_GENERATION_REQUEST_SHAPE
    ) {
      return reconciliation.planId === undefined && reconciliation.imageUnits === undefined;
    }
    return reconciliation.planId !== undefined && reconciliation.imageUnits === undefined;
  }),
);
export type UsageReconciliation = typeof UsageReconciliation.Type;

export const CapacityReservationState = Schema.Literals([
  "requested",
  "reserved",
  "running",
  "reconciled",
  "released",
  "ambiguous",
]);
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
}).check(
  Schema.makeFilter(
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

export const ContextManifestCreated = Schema.Struct({ manifest: ContextManifest });
export type ContextManifestCreated = typeof ContextManifestCreated.Type;
export const ContextOverridesUpdated = Schema.Struct({
  manifestId: ContextManifestId,
  overrides: ContextTurnOverrides,
});
export type ContextOverridesUpdated = typeof ContextOverridesUpdated.Type;
export const ContextPlanCreated = Schema.Struct({ plan: ContextPlan });
export type ContextPlanCreated = typeof ContextPlanCreated.Type;
/**
 * A summary is generated from the subject's own conversation, so its text is
 * subject content and must be purgeable when the subject is deleted. The text
 * is written to the subject-owned summary content store under the summary's
 * id, and the event carries only that identity — never the text itself. It
 * stays bounded because context maintenance only ever summarizes bounded
 * material.
 */
export const ContextSummaryContent = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(20_000),
);
export type ContextSummaryContent = typeof ContextSummaryContent.Type;

export const ContextSummaryCreated = Schema.Struct({
  summary: ContextSummary,
});
export type ContextSummaryCreated = typeof ContextSummaryCreated.Type;
export const ContextUsageReconciled = Schema.Struct({
  reconciliation: UsageReconciliation,
});
export type ContextUsageReconciled = typeof ContextUsageReconciled.Type;
export const ContextCapacityReservationUpdated = Schema.Struct({
  reservation: CapacityReservation,
});
export type ContextCapacityReservationUpdated = typeof ContextCapacityReservationUpdated.Type;

/** The request shape a requested compaction's own model request is recorded under. */
export const CONTEXT_COMPACTION_REQUEST_SHAPE = "context-compaction";

/**
 * Why a compaction was refused. Every refusal is decided before anything is
 * journaled, reserved, or sent, so a refused request leaves no trace.
 */
export const ContextCompactionRefusalReason = Schema.Literals([
  "nothing-to-compact",
  "no-session",
  "runtime-version-unsupported",
  "runtime-cannot-compact",
  "turn-running",
  "compaction-running",
  "provider-unavailable",
  "spend-ceiling-reached",
  "mode-disabled",
  "remote-client",
  "project-unavailable",
  "model-options-unsupported",
  "thread-paused",
]);
export type ContextCompactionRefusalReason = typeof ContextCompactionRefusalReason.Type;

/** Why a journaled compaction ended without changing what the model sees. */
export const ContextCompactionFailureReason = Schema.Literals([
  "runtime-failed",
  "summary-failed",
  "summary-not-smaller",
  "context-changed",
  "timed-out",
  "subject-unavailable",
  "interrupted",
]);
export type ContextCompactionFailureReason = typeof ContextCompactionFailureReason.Type;

export const ContextCompactionExecutor = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("host"),
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  }),
  Schema.Struct({
    kind: Schema.Literal("runtime"),
    driverKind: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    modelId: Schema.optional(ProviderModelId),
  }),
]);
export type ContextCompactionExecutor = typeof ContextCompactionExecutor.Type;

export const ContextCompactionTokensAfter = Schema.Union([
  KnownTokenMeasurement,
  Schema.Struct({ kind: Schema.Literal("pending") }),
]);
export type ContextCompactionTokensAfter = typeof ContextCompactionTokensAfter.Type;

export const ContextCompactionTokensFreed = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["measured", "estimated"]),
    tokens: NonNegativeInt,
    accuracy: KnownTokenMeasurement.fields.accuracy,
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    reason: Schema.Literals(["awaiting-next-report", "not-reported"]),
  }),
]);
export type ContextCompactionTokensFreed = typeof ContextCompactionTokensFreed.Type;

export const ContextCompactionSummary = Schema.Union([
  Schema.Struct({
    visibility: Schema.Literal("stored"),
    summaryId: ContextSummaryId,
    summaryTokens: KnownTokenMeasurement,
    throughTurnId: NonEmptyTrimmedString,
  }),
  Schema.Struct({ visibility: Schema.Literal("runtime-only") }),
]);
export type ContextCompactionSummary = typeof ContextCompactionSummary.Type;

export const ContextCompactionUsage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("reported"),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
    cost: Schema.optional(UsageCost),
  }),
  Schema.Struct({ kind: Schema.Literal("unreported") }),
]);
export type ContextCompactionUsage = typeof ContextCompactionUsage.Type;

/**
 * The share of a model's context window at which a rule the person set
 * compacts a thread. Below half, a compaction would cost more than it frees;
 * above 95 the next reply may not fit before the runtime runs out of room.
 */
export const MIN_AUTO_COMPACT_WINDOW_PERCENT = 50;
export const MAX_AUTO_COMPACT_WINDOW_PERCENT = 95;
export const AutoCompactWindowPercent = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AUTO_COMPACT_WINDOW_PERCENT,
    maximum: MAX_AUTO_COMPACT_WINDOW_PERCENT,
  }),
);
export type AutoCompactWindowPercent = typeof AutoCompactWindowPercent.Type;

export const MIN_AUTO_COMPACT_IDLE_MINUTES = 5;
export const MAX_AUTO_COMPACT_IDLE_MINUTES = 1_440;
export const AutoCompactIdleMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AUTO_COMPACT_IDLE_MINUTES,
    maximum: MAX_AUTO_COMPACT_IDLE_MINUTES,
  }),
);
export type AutoCompactIdleMinutes = typeof AutoCompactIdleMinutes.Type;

export const MIN_AUTO_COMPACT_LIMIT_PERCENT = 50;
export const MAX_AUTO_COMPACT_LIMIT_PERCENT = 99;
export const AutoCompactLimitPercent = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AUTO_COMPACT_LIMIT_PERCENT,
    maximum: MAX_AUTO_COMPACT_LIMIT_PERCENT,
  }),
);
export type AutoCompactLimitPercent = typeof AutoCompactLimitPercent.Type;

/**
 * Why Octant compacted a thread on its own, by a rule the person set. Absent
 * on a compaction the person asked for and on one a runtime made by itself.
 */
export const ContextCompactionCause = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("window-fill"),
    /** How full the window was at the report that crossed the rule, 0 to 100. */
    filledPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    thresholdPercent: AutoCompactWindowPercent,
  }),
  Schema.Struct({
    kind: Schema.Literal("idle"),
    /** Whole minutes since the thread's last turn ended, when the rule acted. */
    idleMinutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    thresholdMinutes: AutoCompactIdleMinutes,
  }),
  Schema.Struct({
    kind: Schema.Literal("limit-near"),
    /** The provider's name for the account window, as its usage reading gives it. */
    window: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    /** How much of that window was used when the rule acted, 0 to 100. */
    usedPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    thresholdPercent: AutoCompactLimitPercent,
  }),
]);
export type ContextCompactionCause = typeof ContextCompactionCause.Type;

export const ContextCompactionReceipt = Schema.Struct({
  compactionId: ContextCompactionId,
  subject: ContextSubjectRef,
  executor: ContextCompactionExecutor,
  trigger: Schema.Literals(["requested", "automatic"]),
  cause: Schema.optional(ContextCompactionCause),
  tokensBefore: KnownTokenMeasurement,
  tokensAfter: ContextCompactionTokensAfter,
  tokensFreed: ContextCompactionTokensFreed,
  summary: ContextCompactionSummary,
  /**
   * A summary the host wrote alongside a runtime's own compaction, so a move
   * to another provider can carry it. Only the limit rule writes one; a
   * compaction the host summarized needs none, since its summary is stored.
   */
  handover: Schema.optional(
    Schema.Struct({
      summaryId: ContextSummaryId,
      /**
       * The last message the summary read. A move carries the summary only
       * while that message is still in the thread, so a rewind past it never
       * brings removed turns back.
       */
      throughSource: ContextSourceRef,
    }),
  ),
  usage: ContextCompactionUsage,
  completedAt: UtcTimestamp,
}).check(
  Schema.makeFilter((receipt) => {
    // The host keeps the text it wrote; a runtime keeps its own.
    if ((receipt.executor.kind === "host") !== (receipt.summary.visibility === "stored")) {
      return false;
    }
    if (receipt.tokensAfter.kind === "pending") {
      return (
        receipt.tokensFreed.kind === "unknown" &&
        receipt.tokensFreed.reason === "awaiting-next-report"
      );
    }
    // Freed is the difference of the two figures shown beside it, never a
    // guess and never negative.
    return (
      receipt.tokensFreed.kind === "unknown" ||
      receipt.tokensFreed.tokens ===
        Math.max(0, receipt.tokensBefore.tokens - receipt.tokensAfter.tokens)
    );
  }),
);
export type ContextCompactionReceipt = typeof ContextCompactionReceipt.Type;

export const ContextCompactionRequested = Schema.Struct({
  compactionId: ContextCompactionId,
  subject: ContextSubjectRef,
  executor: ContextCompactionExecutor,
  // Context commands are local-window only; a paired device is refused first.
  // `host-policy` is the host acting on a rule the person set in Settings.
  requestedBy: Schema.Literals(["local-window", "host-policy"]),
  cause: Schema.optional(ContextCompactionCause),
  requestedAt: UtcTimestamp,
});
export type ContextCompactionRequested = typeof ContextCompactionRequested.Type;
export const ContextCompactionCompleted = Schema.Struct({
  receipt: ContextCompactionReceipt,
});
export type ContextCompactionCompleted = typeof ContextCompactionCompleted.Type;
export const ContextCompactionFailed = Schema.Struct({
  compactionId: ContextCompactionId,
  subject: ContextSubjectRef,
  reason: ContextCompactionFailureReason,
  sessionMayHaveChanged: Schema.Boolean,
  failedAt: UtcTimestamp,
});
export type ContextCompactionFailed = typeof ContextCompactionFailed.Type;

/** Whether the server offers compaction for a thread right now, and why not. */
export const ContextCompactionAvailability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: ContextCompactionRefusalReason,
  }),
]);
export type ContextCompactionAvailability = typeof ContextCompactionAvailability.Type;

/** A compaction that has ended: completed with its receipt, or failed. */
export const ContextCompactionSettledRecord = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    receipt: ContextCompactionReceipt,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    compactionId: ContextCompactionId,
    executor: ContextCompactionExecutor,
    cause: Schema.optional(ContextCompactionCause),
    reason: ContextCompactionFailureReason,
    sessionMayHaveChanged: Schema.Boolean,
    failedAt: UtcTimestamp,
  }),
]);
export type ContextCompactionSettledRecord = typeof ContextCompactionSettledRecord.Type;

/** The thread's most recent compaction, folded from its journaled events. */
export const ContextCompactionRecord = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("running"),
    compactionId: ContextCompactionId,
    executor: ContextCompactionExecutor,
    cause: Schema.optional(ContextCompactionCause),
    requestedAt: UtcTimestamp,
  }),
  ...ContextCompactionSettledRecord.members,
]);
export type ContextCompactionRecord = typeof ContextCompactionRecord.Type;

export const CONTEXT_COMPACTION_EVENT_NAMES = {
  requested: "context.compaction-requested@1",
  completed: "context.compaction-completed@1",
  failed: "context.compaction-failed@1",
} as const;

export const decodeContextManifestId = Schema.decodeUnknownSync(
  ContextManifestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextPlanId = Schema.decodeUnknownSync(ContextPlanId, STRICT_DECODE_OPTIONS);
export const decodeContextEntryId = Schema.decodeUnknownSync(ContextEntryId, STRICT_DECODE_OPTIONS);
export const decodeContextSummaryId = Schema.decodeUnknownSync(
  ContextSummaryId,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageReconciliationId = Schema.decodeUnknownSync(
  UsageReconciliationId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCapacityReservationId = Schema.decodeUnknownSync(
  CapacityReservationId,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextSubjectRef = Schema.decodeUnknownSync(
  ContextSubjectRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeTokenMeasurement = Schema.decodeUnknownSync(
  TokenMeasurement,
  STRICT_DECODE_OPTIONS,
);
export const decodeModelContextLimits = Schema.decodeUnknownSync(
  ModelContextLimits,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderServiceLimits = Schema.decodeUnknownSync(
  ProviderServiceLimits,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextEntry = Schema.decodeUnknownSync(ContextEntry, STRICT_DECODE_OPTIONS);
export const decodeContextTurnOverrides = Schema.decodeUnknownSync(
  ContextTurnOverrides,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextManifest = Schema.decodeUnknownSync(
  ContextManifest,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextReserveBreakdown = Schema.decodeUnknownSync(
  ContextReserveBreakdown,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextPlan = Schema.decodeUnknownSync(ContextPlan, STRICT_DECODE_OPTIONS);
export const decodeContextSummary = Schema.decodeUnknownSync(ContextSummary, STRICT_DECODE_OPTIONS);
export const decodeContextSummaryContent = Schema.decodeUnknownSync(
  ContextSummaryContent,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageReconciliation = Schema.decodeUnknownSync(
  UsageReconciliation,
  STRICT_DECODE_OPTIONS,
);
export const decodeCapacityReservation = Schema.decodeUnknownSync(
  CapacityReservation,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextManifestCreated = Schema.decodeUnknownSync(
  ContextManifestCreated,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextOverridesUpdated = Schema.decodeUnknownSync(
  ContextOverridesUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextPlanCreated = Schema.decodeUnknownSync(
  ContextPlanCreated,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextSummaryCreated = Schema.decodeUnknownSync(
  ContextSummaryCreated,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextUsageReconciled = Schema.decodeUnknownSync(
  ContextUsageReconciled,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCapacityReservationUpdated = Schema.decodeUnknownSync(
  ContextCapacityReservationUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCompactionId = Schema.decodeUnknownSync(
  ContextCompactionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCompactionReceipt = Schema.decodeUnknownSync(
  ContextCompactionReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCompactionRequested = Schema.decodeUnknownSync(
  ContextCompactionRequested,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCompactionCompleted = Schema.decodeUnknownSync(
  ContextCompactionCompleted,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCompactionFailed = Schema.decodeUnknownSync(
  ContextCompactionFailed,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCompactionRecord = Schema.decodeUnknownSync(
  ContextCompactionRecord,
  STRICT_DECODE_OPTIONS,
);
