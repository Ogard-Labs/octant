import { Effect, Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ContextEntryCategory } from "./context";
import { OctantMode } from "./modes";
import { HostId } from "./host";
import { TurnMetricsSummary } from "./turnMetrics";
import { UsageQuality, UsageRecord } from "./usage";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StableRequestShape = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const StableLatencyKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

export const UsageLatencyStat = Schema.Struct({
  key: StableLatencyKey,
  label: NonEmptyTrimmedString,
  observationCount: NonNegativeInt,
  p50Ms: Schema.optional(NonNegativeInt),
  p95Ms: Schema.optional(NonNegativeInt),
  maxMs: Schema.optional(NonNegativeInt),
  /** Present only for a measurement that has a slow threshold. */
  slowThresholdMs: Schema.optional(NonNegativeInt),
  slowCount: Schema.optional(NonNegativeInt),
});
export type UsageLatencyStat = typeof UsageLatencyStat.Type;

export const UsageLatencyStats = Schema.Struct({
  measurements: Schema.Array(UsageLatencyStat),
});
export type UsageLatencyStats = typeof UsageLatencyStats.Type;

export const UsageQueryFilter = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  modelId: Schema.optional(ProviderModelId),
  subjectAggregateType: Schema.optional(NonEmptyTrimmedString),
  subjectAggregateId: Schema.optional(Schema.String),
  mode: Schema.optional(OctantMode),
  projectId: Schema.optional(Schema.String),
  requestShape: Schema.optional(StableRequestShape),
  category: Schema.optional(ContextEntryCategory),
  hostId: Schema.optional(HostId),
  quality: Schema.optional(UsageQuality),
  from: Schema.optional(UtcTimestamp),
  to: Schema.optional(UtcTimestamp),
}).check(
  Schema.makeFilter(
    (filter) => filter.from === undefined || filter.to === undefined || filter.from <= filter.to,
  ),
);
export type UsageQueryFilter = typeof UsageQueryFilter.Type;

export const UsageQueryRequest = Schema.Struct({
  filter: Schema.optional(UsageQueryFilter),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500)),
  ),
  afterSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  timeZone: Schema.optional(NonEmptyTrimmedString),
});
export type UsageQueryRequest = typeof UsageQueryRequest.Type;

export const UsageSummaryTotals = Schema.Struct({
  totalInputTokens: NonNegativeInt,
  totalOutputTokens: NonNegativeInt,
  totalReasoningTokens: Schema.optional(NonNegativeInt),
  totalCacheReadInputTokens: Schema.optional(NonNegativeInt),
  totalCacheWriteInputTokens: Schema.optional(NonNegativeInt),
  totalProviderExecutionDurationMs: Schema.optional(NonNegativeInt),
  totalRequests: NonNegativeInt,
  exactCount: NonNegativeInt,
  estimatedCount: NonNegativeInt,
  reconciledCount: NonNegativeInt,
  staleCount: NonNegativeInt,
  unavailableCount: NonNegativeInt,
});
export type UsageSummaryTotals = typeof UsageSummaryTotals.Type;

export const UsageByProvider = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  totalInputTokens: NonNegativeInt,
  totalOutputTokens: NonNegativeInt,
  totalReasoningTokens: Schema.optional(NonNegativeInt),
  totalCacheReadInputTokens: Schema.optional(NonNegativeInt),
  totalCacheWriteInputTokens: Schema.optional(NonNegativeInt),
  totalProviderExecutionDurationMs: Schema.optional(NonNegativeInt),
  requestCount: NonNegativeInt,
});
export type UsageByProvider = typeof UsageByProvider.Type;

export const UsageByCategory = Schema.Struct({
  category: ContextEntryCategory,
  plannedTokens: NonNegativeInt,
  entryCount: NonNegativeInt,
});
export type UsageByCategory = typeof UsageByCategory.Type;

export const UsageTimeBucket = Schema.Struct({
  bucketStart: UtcTimestamp,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  requestCount: NonNegativeInt,
  exactCount: NonNegativeInt,
  estimatedCount: NonNegativeInt,
  reconciledCount: NonNegativeInt,
  staleCount: NonNegativeInt,
  unavailableCount: NonNegativeInt,
});
export type UsageTimeBucket = typeof UsageTimeBucket.Type;

export const UsageCumulativePoint = Schema.Struct({
  bucketStart: UtcTimestamp,
  cumulativeInputTokens: NonNegativeInt,
  cumulativeOutputTokens: NonNegativeInt,
  cumulativeRequests: NonNegativeInt,
});
export type UsageCumulativePoint = typeof UsageCumulativePoint.Type;

export const UsageTopConsumer = Schema.Struct({
  subjectType: NonEmptyTrimmedString,
  subjectId: Schema.NullOr(Schema.String),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
});
export type UsageTopConsumer = typeof UsageTopConsumer.Type;

export const UsageQueryResponse = Schema.Struct({
  records: Schema.Array(UsageRecord),
  totals: UsageSummaryTotals,
  byProvider: Schema.Array(UsageByProvider),
  byCategory: Schema.Array(UsageByCategory),
  byDay: Schema.Array(UsageTimeBucket),
  byWeek: Schema.Array(UsageTimeBucket),
  cumulative: Schema.Array(UsageCumulativePoint),
  topConsumers: Schema.Array(UsageTopConsumer),
  hasMore: Schema.Boolean,
  queryAt: UtcTimestamp,
  /**
   * Turns of every provider with their full usage and speed, within the same
   * Project scope as `records`. Absent when the query names a filter turns do
   * not carry, because an unfiltered figure would answer a different question.
   */
  turnMetrics: Schema.optional(TurnMetricsSummary),
  /** Host-process observations since this host started; empty when none have been observed. */
  latencyStats: UsageLatencyStats.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ measurements: [] }))),
  ),
});
export type UsageQueryResponse = typeof UsageQueryResponse.Type;

const ConfirmedBoolean = Schema.Boolean.check(Schema.makeFilter((value) => value === true));

export const UsageExportFormat = Schema.Literals(["csv", "json"]);
export type UsageExportFormat = typeof UsageExportFormat.Type;

export const UsageExportRequest = Schema.Struct({
  format: UsageExportFormat,
  confirm: ConfirmedBoolean,
  filter: Schema.optional(UsageQueryFilter),
});
export type UsageExportRequest = typeof UsageExportRequest.Type;

export const UsageResetRequest = Schema.Struct({
  confirm: ConfirmedBoolean,
});
export type UsageResetRequest = typeof UsageResetRequest.Type;

export const UsageRetentionRequest = Schema.Struct({
  olderThan: UtcTimestamp,
  confirm: ConfirmedBoolean,
});
export type UsageRetentionRequest = typeof UsageRetentionRequest.Type;

export const UsagePurgeResult = Schema.Struct({
  purgedCount: NonNegativeInt,
  occurredAt: UtcTimestamp,
});
export type UsagePurgeResult = typeof UsagePurgeResult.Type;

export const decodeUsageQueryFilter = Schema.decodeUnknownSync(
  UsageQueryFilter,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageQueryRequest = Schema.decodeUnknownSync(
  UsageQueryRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageSummaryTotals = Schema.decodeUnknownSync(
  UsageSummaryTotals,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageByProvider = Schema.decodeUnknownSync(
  UsageByProvider,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageByCategory = Schema.decodeUnknownSync(
  UsageByCategory,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageTimeBucket = Schema.decodeUnknownSync(
  UsageTimeBucket,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageCumulativePoint = Schema.decodeUnknownSync(
  UsageCumulativePoint,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageTopConsumer = Schema.decodeUnknownSync(
  UsageTopConsumer,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageQueryResponse = Schema.decodeUnknownSync(
  UsageQueryResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageExportRequest = Schema.decodeUnknownSync(
  UsageExportRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageResetRequest = Schema.decodeUnknownSync(
  UsageResetRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageRetentionRequest = Schema.decodeUnknownSync(
  UsageRetentionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsagePurgeResult = Schema.decodeUnknownSync(
  UsagePurgeResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageLatencyStats = Schema.decodeUnknownSync(
  UsageLatencyStats,
  STRICT_DECODE_OPTIONS,
);
