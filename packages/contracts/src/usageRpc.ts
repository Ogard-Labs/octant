import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ContextEntryCategory } from "./context";
import { OctantMode } from "./modes";
import { HostId } from "./host";
import { UsageQuality, UsageRecord } from "./usage";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const StableRequestShape = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

export const UsageQueryFilter = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  modelId: Schema.optional(ProviderModelId),
  subjectAggregateType: Schema.optional(Schema.NonEmptyTrimmedString),
  subjectAggregateId: Schema.optional(Schema.String),
  mode: Schema.optional(OctantMode),
  projectId: Schema.optional(Schema.String),
  requestShape: Schema.optional(StableRequestShape),
  category: Schema.optional(ContextEntryCategory),
  hostId: Schema.optional(HostId),
  quality: Schema.optional(UsageQuality),
  from: Schema.optional(UtcTimestamp),
  to: Schema.optional(UtcTimestamp),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (filter) => filter.from === undefined || filter.to === undefined || filter.from <= filter.to,
    ),
  );
export type UsageQueryFilter = typeof UsageQueryFilter.Type;

export const UsageQueryRequest = Schema.Struct({
  filter: Schema.optional(UsageQueryFilter),
  limit: Schema.optional(Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(500))),
  afterSequence: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  timeZone: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
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
}).annotations(strict);
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
}).annotations(strict);
export type UsageByProvider = typeof UsageByProvider.Type;

export const UsageByCategory = Schema.Struct({
  category: ContextEntryCategory,
  plannedTokens: NonNegativeInt,
  entryCount: NonNegativeInt,
}).annotations(strict);
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
}).annotations(strict);
export type UsageTimeBucket = typeof UsageTimeBucket.Type;

export const UsageCumulativePoint = Schema.Struct({
  bucketStart: UtcTimestamp,
  cumulativeInputTokens: NonNegativeInt,
  cumulativeOutputTokens: NonNegativeInt,
  cumulativeRequests: NonNegativeInt,
}).annotations(strict);
export type UsageCumulativePoint = typeof UsageCumulativePoint.Type;

export const UsageTopConsumer = Schema.Struct({
  subjectType: Schema.NonEmptyTrimmedString,
  subjectId: Schema.String,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
}).annotations(strict);
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
}).annotations(strict);
export type UsageQueryResponse = typeof UsageQueryResponse.Type;

const ConfirmedBoolean = Schema.Boolean.pipe(Schema.filter((value) => value === true));

export const UsageExportFormat = Schema.Literal("csv", "json");
export type UsageExportFormat = typeof UsageExportFormat.Type;

export const UsageExportRequest = Schema.Struct({
  format: UsageExportFormat,
  confirm: ConfirmedBoolean,
  filter: Schema.optional(UsageQueryFilter),
}).annotations(strict);
export type UsageExportRequest = typeof UsageExportRequest.Type;

export const UsageResetRequest = Schema.Struct({
  confirm: ConfirmedBoolean,
}).annotations(strict);
export type UsageResetRequest = typeof UsageResetRequest.Type;

export const UsageRetentionRequest = Schema.Struct({
  olderThan: UtcTimestamp,
  confirm: ConfirmedBoolean,
}).annotations(strict);
export type UsageRetentionRequest = typeof UsageRetentionRequest.Type;

export const UsagePurgeResult = Schema.Struct({
  purgedCount: NonNegativeInt,
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type UsagePurgeResult = typeof UsagePurgeResult.Type;

export const decodeUsageQueryFilter = Schema.decodeUnknownSync(UsageQueryFilter);
export const decodeUsageQueryRequest = Schema.decodeUnknownSync(UsageQueryRequest);
export const decodeUsageSummaryTotals = Schema.decodeUnknownSync(UsageSummaryTotals);
export const decodeUsageByProvider = Schema.decodeUnknownSync(UsageByProvider);
export const decodeUsageByCategory = Schema.decodeUnknownSync(UsageByCategory);
export const decodeUsageTimeBucket = Schema.decodeUnknownSync(UsageTimeBucket);
export const decodeUsageCumulativePoint = Schema.decodeUnknownSync(UsageCumulativePoint);
export const decodeUsageTopConsumer = Schema.decodeUnknownSync(UsageTopConsumer);
export const decodeUsageQueryResponse = Schema.decodeUnknownSync(UsageQueryResponse);
export const decodeUsageExportRequest = Schema.decodeUnknownSync(UsageExportRequest);
export const decodeUsageResetRequest = Schema.decodeUnknownSync(UsageResetRequest);
export const decodeUsageRetentionRequest = Schema.decodeUnknownSync(UsageRetentionRequest);
export const decodeUsagePurgeResult = Schema.decodeUnknownSync(UsagePurgeResult);
