import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateReference, UtcTimestamp } from "./events";
import { ContextEntryCategory, UsageCost, UsageReconciliationId } from "./context";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const UsageQuality = Schema.Literals([
  "exact",
  "estimated",
  "reconciled",
  "stale",
  "unavailable",
]);
export type UsageQuality = typeof UsageQuality.Type;

export const AttributionQuality = Schema.Literals(["exact", "estimated", "unavailable"]);
export type AttributionQuality = typeof AttributionQuality.Type;

export const UsageAttributionEntry = Schema.Struct({
  category: ContextEntryCategory,
  plannedTokens: NonNegativeInt,
  quality: AttributionQuality,
  imageCount: Schema.optional(PositiveInt),
  imageSize: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32))),
  imageQuality: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32))),
});
export type UsageAttributionEntry = typeof UsageAttributionEntry.Type;

const StableRequestShape = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

/**
 * A usage row's subject after the thread it names was purged: the aggregate
 * kind stays for honest accounting shape, the thread identity is gone.
 */
export const DeLinkedUsageSubject = Schema.Struct({
  aggregateType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  deLinked: Schema.Literal(true),
});
export type DeLinkedUsageSubject = typeof DeLinkedUsageSubject.Type;

export const UsageSubject = Schema.Union([AggregateReference, DeLinkedUsageSubject]);
export type UsageSubject = typeof UsageSubject.Type;

export const UsageRecord = Schema.Struct({
  reconciliationId: UsageReconciliationId,
  subject: UsageSubject,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  requestShape: StableRequestShape,
  quality: UsageQuality,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  /** What the request cost; absent when it could not be priced. */
  cost: Schema.optional(UsageCost),
  plannedInputTokens: Schema.optional(NonNegativeInt),
  varianceTokens: Schema.optional(Schema.Int),
  attribution: Schema.Array(UsageAttributionEntry),
  observedAt: UtcTimestamp,
});
export type UsageRecord = typeof UsageRecord.Type;

export const decodeUsageQuality = Schema.decodeUnknownSync(UsageQuality, STRICT_DECODE_OPTIONS);
export const decodeAttributionQuality = Schema.decodeUnknownSync(
  AttributionQuality,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageAttributionEntry = Schema.decodeUnknownSync(
  UsageAttributionEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageRecord = Schema.decodeUnknownSync(UsageRecord, STRICT_DECODE_OPTIONS);
