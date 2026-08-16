import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { UsageReconciliationId } from "./context";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { UsageAttributionEntry, UsageQuality } from "./usage";
import { UsageQueryFilter, UsageSummaryTotals } from "./usageRpc";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const StableRequestShape = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

/** Calendar day key in the viewing time zone the host was asked to bucket by. */
export const UsageDayKey = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/));
export type UsageDayKey = typeof UsageDayKey.Type;

/**
 * Attribution dimensions the dashboard can group by.
 *
 * The dimension list is fixed by the contract so a host can state, per query,
 * which dimensions it actually records. A dimension the host cannot source is
 * reported as unavailable rather than omitted, because an omitted dimension
 * reads as "nothing consumed" while an unavailable one reads as "not measured".
 */
export const UsageAttributionDimension = Schema.Literal(
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
);
export type UsageAttributionDimension = typeof UsageAttributionDimension.Type;

export const UsageDimensionSourceStatus = Schema.Literal("recorded", "partial", "unavailable");
export type UsageDimensionSourceStatus = typeof UsageDimensionSourceStatus.Type;

export const UsageDimensionSource = Schema.Struct({
  dimension: UsageAttributionDimension,
  status: UsageDimensionSourceStatus,
  /** Why the host can or cannot attribute this dimension, in reader-facing words. */
  detail: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type UsageDimensionSource = typeof UsageDimensionSource.Type;

export const UsagePeakDay = Schema.Struct({
  date: UsageDayKey,
  totalTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
}).annotations(strict);
export type UsagePeakDay = typeof UsagePeakDay.Type;

export const UsagePeakModel = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  totalTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
}).annotations(strict);
export type UsagePeakModel = typeof UsagePeakModel.Type;

export const UsageCoverageSlice = Schema.Struct({
  quality: UsageQuality,
  requestCount: NonNegativeInt,
}).annotations(strict);
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
}).annotations(strict);
export type UsageDashboardSummary = typeof UsageDashboardSummary.Type;

/**
 * Activity state of one calendar day. `no-activity` and `unavailable` are
 * distinct: the first means the host recorded no request, the second means it
 * recorded requests whose usage the provider never reported.
 */
export const UsageActivityState = Schema.Literal(
  "no-activity",
  "measured",
  "partially-unavailable",
  "unavailable",
);
export type UsageActivityState = typeof UsageActivityState.Type;

export const UsageActivityCell = Schema.Struct({
  date: UsageDayKey,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
  unavailableRequestCount: NonNegativeInt,
  state: UsageActivityState,
}).annotations(strict);
export type UsageActivityCell = typeof UsageActivityCell.Type;

export const UsageBreakdownAvailability = Schema.Literal("recorded", "unavailable");
export type UsageBreakdownAvailability = typeof UsageBreakdownAvailability.Type;

export const UsageBreakdownRow = Schema.Struct({
  /** Immutable id kept across renames; empty for the unavailable bucket. */
  key: Schema.String,
  /** Safe display label derived from the id; never provider or prompt prose. */
  label: Schema.NonEmptyTrimmedString,
  availability: UsageBreakdownAvailability,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  requestCount: NonNegativeInt,
  unavailableRequestCount: NonNegativeInt,
  /** Planned composition, present only for the context-category dimension. */
  plannedTokens: Schema.optional(NonNegativeInt),
}).annotations(strict);
export type UsageBreakdownRow = typeof UsageBreakdownRow.Type;

export const UsageBreakdownGroup = Schema.Struct({
  dimension: UsageAttributionDimension,
  rows: Schema.Array(UsageBreakdownRow),
  truncated: Schema.Boolean,
}).annotations(strict);
export type UsageBreakdownGroup = typeof UsageBreakdownGroup.Type;

export const UsageDetailRow = Schema.Struct({
  reconciliationId: UsageReconciliationId,
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  requestShape: StableRequestShape,
  subjectType: Schema.NonEmptyTrimmedString,
  subjectId: Schema.String,
  mode: Schema.optional(OctantMode),
  projectId: Schema.optional(ProjectId),
  quality: UsageQuality,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  plannedInputTokens: NonNegativeInt,
  varianceTokens: Schema.Int,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  providerExecutionDurationMs: Schema.optional(NonNegativeInt),
  attribution: Schema.Array(UsageAttributionEntry),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type UsageDetailRow = typeof UsageDetailRow.Type;

export const UsageHostStatus = Schema.Literal("contributing", "stale");
export type UsageHostStatus = typeof UsageHostStatus.Type;

export const UsageHostCoverage = Schema.Struct({
  hostId: HostId,
  requestCount: NonNegativeInt,
  lastObservedAt: UtcTimestamp,
  status: UsageHostStatus,
}).annotations(strict);
export type UsageHostCoverage = typeof UsageHostCoverage.Type;

export const UsageDashboardRequest = Schema.Struct({
  filter: Schema.optional(UsageQueryFilter),
  timeZone: Schema.optional(Schema.NonEmptyTrimmedString),
  detailLimit: Schema.optional(Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(200))),
  breakdownLimit: Schema.optional(Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(50))),
}).annotations(strict);
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
  scanTruncated: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  hosts: Schema.Array(UsageHostCoverage),
  dimensionSources: Schema.Array(UsageDimensionSource),
  timeZone: Schema.NonEmptyTrimmedString,
  queryAt: UtcTimestamp,
}).annotations(strict);
export type UsageDashboardResponse = typeof UsageDashboardResponse.Type;

export const decodeUsageDimensionSource = Schema.decodeUnknownSync(UsageDimensionSource);
export const decodeUsageActivityCell = Schema.decodeUnknownSync(UsageActivityCell);
export const decodeUsageBreakdownGroup = Schema.decodeUnknownSync(UsageBreakdownGroup);
export const decodeUsageDetailRow = Schema.decodeUnknownSync(UsageDetailRow);
export const decodeUsageHostCoverage = Schema.decodeUnknownSync(UsageHostCoverage);
export const decodeUsageDashboardRequest = Schema.decodeUnknownSync(UsageDashboardRequest);
export const decodeUsageDashboardResponse = Schema.decodeUnknownSync(UsageDashboardResponse);
