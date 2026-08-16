import { Schema } from "effect";
import { AggregateReference, UtcTimestamp } from "./events";
import { ContextEntryCategory, UsageReconciliationId } from "./context";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

export const UsageQuality = Schema.Literal(
  "exact",
  "estimated",
  "reconciled",
  "stale",
  "unavailable",
);
export type UsageQuality = typeof UsageQuality.Type;

export const AttributionQuality = Schema.Literal("exact", "estimated", "unavailable");
export type AttributionQuality = typeof AttributionQuality.Type;

export const UsageAttributionEntry = Schema.Struct({
  category: ContextEntryCategory,
  plannedTokens: NonNegativeInt,
  quality: AttributionQuality,
}).annotations(strict);
export type UsageAttributionEntry = typeof UsageAttributionEntry.Type;

const StableRequestShape = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

export const UsageRecord = Schema.Struct({
  reconciliationId: UsageReconciliationId,
  subject: AggregateReference,
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
  plannedInputTokens: NonNegativeInt,
  varianceTokens: Schema.Int,
  attribution: Schema.Array(UsageAttributionEntry),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type UsageRecord = typeof UsageRecord.Type;

export const decodeUsageQuality = Schema.decodeUnknownSync(UsageQuality);
export const decodeAttributionQuality = Schema.decodeUnknownSync(AttributionQuality);
export const decodeUsageAttributionEntry = Schema.decodeUnknownSync(UsageAttributionEntry);
export const decodeUsageRecord = Schema.decodeUnknownSync(UsageRecord);
