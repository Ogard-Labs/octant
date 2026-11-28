import { Effect, Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { UsageLatencyStats } from "./usageRpc";
import { UsageReconciliationId } from "./context";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { UsageAttributionEntry, UsageQuality } from "./usage";
import { UsageQueryFilter, UsageSummaryTotals } from "./usageRpc";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StableRequestShape = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const StableCacheKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const Ratio = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** Calendar day key in the viewing time zone the host was asked to bucket by. */
export const UsageDayKey = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type UsageDayKey = typeof UsageDayKey.Type;

/**
 * Attribution dimensions the dashboard can group by.
 *
 * The dimension list is fixed by the contract so a host can state, per query,
 * which dimensions it actually records. A dimension the host cannot source is
 * reported as unavailable rather than omitted, because an omitted dimension
 * reads as "nothing consumed" while an unavailable one reads as "not measured".
 */
export const UsageAttributionDimension = Schema.Literals([
  "provider",
  "model",
  "host",
  "mode",
  "project",
  "thread",
  "request-shape",
  "context-category",
  "component",
  "cost",
]);
export type UsageAttributionDimension = typeof UsageAttributionDimension.Type;

/**
 * The "thread" breakdown key for usage whose thread was purged. The rows keep
 * their token aggregates but carry no thread identity, so they group under one
 * anonymous line instead of under a subject reference.
 */
export const USAGE_ERASED_THREADS_KEY = "erased-threads";

export const UsageDimensionSourceStatus = Schema.Literals(["recorded", "partial", "unavailable"]);
export type UsageDimensionSourceStatus = typeof UsageDimensionSourceStatus.Type;

export const UsageDimensionSource = Schema.Struct({
  dimension: UsageAttributionDimension,
  status: UsageDimensionSourceStatus,
  /** Why the host can or cannot attribute this dimension, in reader-facing words. */
  detail: NonEmptyTrimmedString,
});
export type UsageDimensionSource = typeof UsageDimensionSource.Type;

export const UsagePeakDay = Schema.Struct({
  date: UsageDayKey,
  totalTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
});
export type UsagePeakDay = typeof UsagePeakDay.Type;

export const UsagePeakModel = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  totalTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
});
export type UsagePeakModel = typeof UsagePeakModel.Type;

export const UsageCoverageSlice = Schema.Struct({
  quality: UsageQuality,
  requestCount: NonNegativeInt,
});
export type UsageCoverageSlice = typeof UsageCoverageSlice.Type;

export const UsageDashboardSummary = Schema.Struct({
  totals: UsageSummaryTotals,
  /** Requests the provider could not report token facts for; never counted as zero usage. */
  requestsWithUnavailableUsage: NonNegativeInt,
  coverage: Schema.Array(UsageCoverageSlice),
  peakDay: Schema.optional(UsagePeakDay),
  peakModel: Schema.optional(UsagePeakModel),
  /**
   * Durable records the host refused to aggregate because they were malformed,
   * negative, or would overflow a total. Failing closed keeps a contradictory
   * record out of the totals while still telling the reader it existed.
   */
  excludedRecordCount: NonNegativeInt,
});
export type UsageDashboardSummary = typeof UsageDashboardSummary.Type;

/**
 * Activity state of one calendar day. `no-activity` and `unavailable` are
 * distinct: the first means the host recorded no request, the second means it
 * recorded requests whose usage the provider never reported.
 */
export const UsageActivityState = Schema.Literals([
  "no-activity",
  "measured",
  "partially-unavailable",
  "unavailable",
]);
export type UsageActivityState = typeof UsageActivityState.Type;

export const UsageActivityCell = Schema.Struct({
  date: UsageDayKey,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
  unavailableRequestCount: NonNegativeInt,
  state: UsageActivityState,
});
export type UsageActivityCell = typeof UsageActivityCell.Type;

export const UsageBreakdownAvailability = Schema.Literals(["recorded", "unavailable"]);
export type UsageBreakdownAvailability = typeof UsageBreakdownAvailability.Type;

export const UsageBreakdownRow = Schema.Struct({
  /** Immutable id kept across renames; empty for the unavailable bucket. */
  key: Schema.String,
  /** Safe display label derived from the id; never provider or prompt prose. */
  label: NonEmptyTrimmedString,
  availability: UsageBreakdownAvailability,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
  unavailableRequestCount: NonNegativeInt,
  /** Planned composition, present only for the context-category dimension. */
  plannedTokens: Schema.optional(NonNegativeInt),
});
export type UsageBreakdownRow = typeof UsageBreakdownRow.Type;

export const UsageBreakdownGroup = Schema.Struct({
  dimension: UsageAttributionDimension,
  rows: Schema.Array(UsageBreakdownRow),
  truncated: Schema.Boolean,
});
export type UsageBreakdownGroup = typeof UsageBreakdownGroup.Type;

export const UsageDetailRow = Schema.Struct({
  reconciliationId: UsageReconciliationId,
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  requestShape: StableRequestShape,
  subjectType: NonEmptyTrimmedString,
  subjectId: Schema.NullOr(Schema.String),
  mode: Schema.optional(OctantMode),
  projectId: Schema.optional(ProjectId),
  quality: UsageQuality,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  plannedInputTokens: Schema.optional(NonNegativeInt),
  varianceTokens: Schema.optional(Schema.Int),
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  attribution: Schema.Array(UsageAttributionEntry),
  observedAt: UtcTimestamp,
});
export type UsageDetailRow = typeof UsageDetailRow.Type;

export const UsageHostStatus = Schema.Literals(["contributing", "stale"]);
export type UsageHostStatus = typeof UsageHostStatus.Type;

export const UsageHostCoverage = Schema.Struct({
  hostId: HostId,
  requestCount: NonNegativeInt,
  lastObservedAt: UtcTimestamp,
  status: UsageHostStatus,
});
export type UsageHostCoverage = typeof UsageHostCoverage.Type;

/**
 * Read facts for one server-side cache.
 *
 * A cache is only trustworthy to a reader who can see whether it is being used,
 * how old its contents are, and whether its refresh is currently being paced
 * after failures. Counts are observations since the host started, so they are
 * monotonic within a host lifetime and not comparable across restarts.
 */
export const UsageCacheStat = Schema.Struct({
  /** Stable cache id kept across renames of its display label. */
  key: StableCacheKey,
  label: NonEmptyTrimmedString,
  hitCount: NonNegativeInt,
  missCount: NonNegativeInt,
  /** Absent until the cache has been read at least once; a ratio of no reads is not zero. */
  hitRatio: Schema.optional(Ratio),
  /** Last refresh that reached the source successfully; absent means never. */
  lastRefreshAt: Schema.optional(UtcTimestamp),
  /** Age of the cached contents at query time; absent when nothing is cached. */
  stalenessMs: Schema.optional(NonNegativeInt),
  /** Consecutive failed refreshes; a successful refresh clears the streak. */
  failureStreak: NonNegativeInt,
  /** While present, an unattended refresh is being held back until this time. */
  retryAt: Schema.optional(UtcTimestamp),
});
export type UsageCacheStat = typeof UsageCacheStat.Type;

/**
 * Reported cache traffic for one provider instance. The legacy hitRatio field
 * is reads / (reads + writes), not a prompt-cache hit rate. Missing counters
 * remain unknown, and incomplete traffic has no ratio.
 */
export const UsageProviderTokenCacheStat = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  requestCount: NonNegativeInt,
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  hitRatio: Schema.optional(Ratio),
});
export type UsageProviderTokenCacheStat = typeof UsageProviderTokenCacheStat.Type;

export const UsageCacheStats = Schema.Struct({
  caches: Schema.Array(UsageCacheStat),
  providerTokenCaches: Schema.Array(UsageProviderTokenCacheStat),
  /** Read share of reported cache traffic; absent for incomplete counters. */
  tokenCacheHitRatio: Schema.optional(Ratio),
});
export type UsageCacheStats = typeof UsageCacheStats.Type;

export const UsageDashboardRequest = Schema.Struct({
  filter: Schema.optional(UsageQueryFilter),
  timeZone: Schema.optional(NonEmptyTrimmedString),
  detailLimit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
  ),
  breakdownLimit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
  ),
});
export type UsageDashboardRequest = typeof UsageDashboardRequest.Type;

export const UsageDashboardResponse = Schema.Struct({
  summary: UsageDashboardSummary,
  activity: Schema.Array(UsageActivityCell),
  activityTruncated: Schema.Boolean,
  breakdown: Schema.Array(UsageBreakdownGroup),
  detail: Schema.Array(UsageDetailRow),
  detailTruncated: Schema.Boolean,
  /**
   * The ledger scan reached its row cap, so every total in this response is a
   * floor rather than a complete figure. Distinct from `detailTruncated`, which
   * is also true when only the detail table was trimmed to its display limit —
   * that case leaves the totals complete, so the two must not be conflated when
   * telling a user whether a number can be trusted.
   */
  scanTruncated: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  hosts: Schema.Array(UsageHostCoverage),
  dimensionSources: Schema.Array(UsageDimensionSource),
  /**
   * Cache efficiency at query time. Defaulted so a host that observes no cache
   * yet still answers with an empty reading rather than omitting the field.
   */
  cacheStats: UsageCacheStats.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ caches: [], providerTokenCaches: [] }))),
  ),
  timeZone: NonEmptyTrimmedString,
  queryAt: UtcTimestamp,
  /** Host-process observations since this host started; empty when none have been observed. */
  latencyStats: UsageLatencyStats.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ measurements: [] }))),
  ),
});
export type UsageDashboardResponse = typeof UsageDashboardResponse.Type;

export const decodeUsageDimensionSource = Schema.decodeUnknownSync(
  UsageDimensionSource,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageActivityCell = Schema.decodeUnknownSync(
  UsageActivityCell,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageBreakdownGroup = Schema.decodeUnknownSync(
  UsageBreakdownGroup,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageDetailRow = Schema.decodeUnknownSync(UsageDetailRow, STRICT_DECODE_OPTIONS);
export const decodeUsageHostCoverage = Schema.decodeUnknownSync(
  UsageHostCoverage,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageCacheStats = Schema.decodeUnknownSync(
  UsageCacheStats,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageDashboardRequest = Schema.decodeUnknownSync(
  UsageDashboardRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeUsageDashboardResponse = Schema.decodeUnknownSync(
  UsageDashboardResponse,
  STRICT_DECODE_OPTIONS,
);
