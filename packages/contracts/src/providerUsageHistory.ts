import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const BoundedKey = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));
const SourceId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));

export const LocalUsageHistorySourceKind = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
export type LocalUsageHistorySourceKind = typeof LocalUsageHistorySourceKind.Type;

export const LocalUsageHistoryStatus = Schema.Literal("ready", "partial", "unavailable", "failed");
export type LocalUsageHistoryStatus = typeof LocalUsageHistoryStatus.Type;

export const LocalUsageHistoryCost = Schema.Struct({
  amount: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()),
  currency: Schema.Literal("USD"),
  kind: Schema.Literal("api-estimate", "provider-recorded"),
  pricingRevision: Schema.optional(BoundedKey),
  pricingSource: Schema.optional(BoundedKey),
  cacheSavingsUsd: Schema.optional(Schema.Number.pipe(Schema.finite())),
}).annotations(strict);
export type LocalUsageHistoryCost = typeof LocalUsageHistoryCost.Type;

/** One accounting-only event projected from a provider's local history. */
export const LocalUsageHistoryRecord = Schema.Struct({
  sourceKind: LocalUsageHistorySourceKind,
  sourceInstallationId: SourceId,
  sourceSessionId: SourceId,
  sourceEventId: SourceId,
  providerKey: BoundedKey,
  modelId: BoundedKey,
  observedAt: UtcTimestamp,
  /** Processed input, including cache reads/writes; never add caches again. */
  inputTokens: NonNegativeInt,
  uncachedInputTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteDuration: Schema.optional(Schema.Literal("5-minute", "1-hour", "unknown")),
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cost: Schema.optional(LocalUsageHistoryCost),
}).annotations(strict);
export type LocalUsageHistoryRecord = typeof LocalUsageHistoryRecord.Type;

export const LocalUsageHistoryCoverage = Schema.Struct({
  sourceKind: LocalUsageHistorySourceKind,
  sourceInstallationId: SourceId,
  status: LocalUsageHistoryStatus,
  scannedFileCount: NonNegativeInt,
  acceptedRecordCount: NonNegativeInt,
  omittedRecordCount: NonNegativeInt,
  coveredFrom: Schema.optional(UtcTimestamp),
  coveredTo: Schema.optional(UtcTimestamp),
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  detail: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);
export type LocalUsageHistoryCoverage = typeof LocalUsageHistoryCoverage.Type;

export const LocalUsageHistoryPricingReference = Schema.Struct({
  revision: BoundedKey,
  source: Schema.String.pipe(Schema.pattern(/^https:\/\//), Schema.maxLength(255)),
}).annotations(strict);
export type LocalUsageHistoryPricingReference = typeof LocalUsageHistoryPricingReference.Type;

export const LocalUsageHistoryCostTotals = Schema.Struct({
  providerRecordedUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
  apiEstimateUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
  pricedRecordCount: NonNegativeInt,
  unpricedRecordCount: NonNegativeInt,
  providerRecordedRecordCount: Schema.optional(NonNegativeInt),
  apiEstimateRecordCount: Schema.optional(NonNegativeInt),
  excludedRecordCount: Schema.optional(NonNegativeInt),
  cacheSavingsUsd: Schema.optional(Schema.Number.pipe(Schema.finite())),
  cacheSavingsRecordCount: Schema.optional(NonNegativeInt),
  pricingReferences: Schema.optional(
    Schema.Array(LocalUsageHistoryPricingReference).pipe(Schema.maxItems(8)),
  ),
}).annotations(strict);
export type LocalUsageHistoryCostTotals = typeof LocalUsageHistoryCostTotals.Type;

export const LocalUsageHistoryTokenTotals = Schema.Struct({
  inputTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  uncachedInputTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  requestCount: NonNegativeInt,
  sessionCount: NonNegativeInt,
  excludedRecordCount: Schema.optional(NonNegativeInt),
  componentCoverage: Schema.Struct({
    uncachedInput: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }).annotations(
      strict,
    ),
    cacheRead: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }).annotations(
      strict,
    ),
    cacheWrite: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }).annotations(
      strict,
    ),
    reasoning: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }).annotations(
      strict,
    ),
  }).annotations(strict),
}).annotations(strict);
export type LocalUsageHistoryTokenTotals = typeof LocalUsageHistoryTokenTotals.Type;

export const LocalUsageHistoryGroup = Schema.Struct({
  key: BoundedKey,
  label: BoundedKey,
  providerKey: BoundedKey,
  totals: LocalUsageHistoryTokenTotals,
  cost: LocalUsageHistoryCostTotals,
}).annotations(strict);
export type LocalUsageHistoryGroup = typeof LocalUsageHistoryGroup.Type;

export const LocalUsageHistoryDay = Schema.Struct({
  day: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
  providerKey: BoundedKey,
  totals: LocalUsageHistoryTokenTotals,
  cost: LocalUsageHistoryCostTotals,
}).annotations(strict);
export type LocalUsageHistoryDay = typeof LocalUsageHistoryDay.Type;

export const LocalUsageHistoryRequest = Schema.Struct({
  from: UtcTimestamp,
  to: UtcTimestamp,
  timeZone: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
}).annotations(strict);
export type LocalUsageHistoryRequest = typeof LocalUsageHistoryRequest.Type;

export const LocalUsageHistoryResponse = Schema.Struct({
  source: Schema.Literal("local-provider-history"),
  from: UtcTimestamp,
  to: UtcTimestamp,
  timeZone: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  queryAt: UtcTimestamp,
  totals: LocalUsageHistoryTokenTotals,
  cost: LocalUsageHistoryCostTotals,
  providers: Schema.Array(LocalUsageHistoryGroup).pipe(Schema.maxItems(128)),
  models: Schema.Array(LocalUsageHistoryGroup).pipe(Schema.maxItems(256)),
  days: Schema.Array(LocalUsageHistoryDay).pipe(Schema.maxItems(512)),
  dailyTotals: Schema.Array(LocalUsageHistoryDay).pipe(Schema.maxItems(512)),
  coverage: Schema.Array(LocalUsageHistoryCoverage).pipe(Schema.maxItems(32)),
}).annotations(strict);
export type LocalUsageHistoryResponse = typeof LocalUsageHistoryResponse.Type;

export const decodeLocalUsageHistoryRecord = Schema.decodeUnknownSync(LocalUsageHistoryRecord);
export const decodeLocalUsageHistoryCoverage = Schema.decodeUnknownSync(LocalUsageHistoryCoverage);
export const decodeLocalUsageHistoryRequest = Schema.decodeUnknownSync(LocalUsageHistoryRequest);
export const decodeLocalUsageHistoryResponse = Schema.decodeUnknownSync(LocalUsageHistoryResponse);
