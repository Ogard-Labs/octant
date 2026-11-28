import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BoundedKey = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255));
const SourceId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));

export const LocalUsageHistorySourceKind = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
);
export type LocalUsageHistorySourceKind = typeof LocalUsageHistorySourceKind.Type;

export const LocalUsageHistoryStatus = Schema.Literals([
  "ready",
  "partial",
  "unavailable",
  "failed",
]);
export type LocalUsageHistoryStatus = typeof LocalUsageHistoryStatus.Type;

export const LocalUsageHistoryCost = Schema.Struct({
  amount: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite()),
  currency: Schema.Literal("USD"),
  kind: Schema.Literals(["api-estimate", "provider-recorded"]),
  pricingRevision: Schema.optional(BoundedKey),
  pricingSource: Schema.optional(BoundedKey),
  cacheSavingsUsd: Schema.optional(Schema.Number.check(Schema.isFinite())),
});
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
  /** Claude prompt-cache writes split by their independently priced TTL. */
  cacheWrite5mInputTokens: Schema.optional(NonNegativeInt),
  cacheWrite1hInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteDuration: Schema.optional(Schema.Literals(["5-minute", "1-hour", "unknown"])),
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cost: Schema.optional(LocalUsageHistoryCost),
});
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
  detail: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
});
export type LocalUsageHistoryCoverage = typeof LocalUsageHistoryCoverage.Type;

export const LocalUsageHistoryPricingReference = Schema.Struct({
  revision: BoundedKey,
  source: Schema.String.check(Schema.isPattern(/^https:\/\//), Schema.isMaxLength(255)),
});
export type LocalUsageHistoryPricingReference = typeof LocalUsageHistoryPricingReference.Type;

export const LocalUsageHistoryCostTotals = Schema.Struct({
  providerRecordedUsd: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite()),
  ),
  apiEstimateUsd: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite()),
  ),
  pricedRecordCount: NonNegativeInt,
  unpricedRecordCount: NonNegativeInt,
  providerRecordedRecordCount: Schema.optional(NonNegativeInt),
  apiEstimateRecordCount: Schema.optional(NonNegativeInt),
  excludedRecordCount: Schema.optional(NonNegativeInt),
  cacheSavingsUsd: Schema.optional(Schema.Number.check(Schema.isFinite())),
  cacheSavingsRecordCount: Schema.optional(NonNegativeInt),
  pricingReferences: Schema.optional(
    Schema.Array(LocalUsageHistoryPricingReference).check(Schema.isMaxLength(8)),
  ),
});
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
    uncachedInput: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }),
    cacheRead: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }),
    cacheWrite: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }),
    reasoning: Schema.Struct({ measured: NonNegativeInt, total: NonNegativeInt }),
  }),
});
export type LocalUsageHistoryTokenTotals = typeof LocalUsageHistoryTokenTotals.Type;

export const LocalUsageHistoryGroup = Schema.Struct({
  key: BoundedKey,
  label: BoundedKey,
  providerKey: BoundedKey,
  totals: LocalUsageHistoryTokenTotals,
  cost: LocalUsageHistoryCostTotals,
});
export type LocalUsageHistoryGroup = typeof LocalUsageHistoryGroup.Type;

export const LocalUsageHistoryDay = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  providerKey: BoundedKey,
  totals: LocalUsageHistoryTokenTotals,
  cost: LocalUsageHistoryCostTotals,
});
export type LocalUsageHistoryDay = typeof LocalUsageHistoryDay.Type;

export const LocalUsageHistoryRequest = Schema.Struct({
  from: UtcTimestamp,
  to: UtcTimestamp,
  timeZone: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  /**
   * Answer from the host's last stored reading of this view instead of
   * reading provider history now. A surface that is opened repeatedly asks
   * this way first, paints those totals, and reads again straight away, so an
   * unchanged provider history does not repaint every total from scratch.
   * The stored reading is normally the last completed one; when no reading
   * has ever completed for this view it can be an unfinished one. Inspect
   * coverage[].hasMore and status before treating the totals as complete.
   */
  preferLastRead: Schema.optional(Schema.Boolean),
});
export type LocalUsageHistoryRequest = typeof LocalUsageHistoryRequest.Type;

export const LocalUsageHistoryResponse = Schema.Struct({
  source: Schema.Literal("local-provider-history"),
  from: UtcTimestamp,
  to: UtcTimestamp,
  timeZone: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  queryAt: UtcTimestamp,
  /**
   * Present and true when these totals are the host's earlier reading of this
   * view rather than a reading of the request that asked for them. The range
   * and the read time are that earlier reading's, and the caller is expected
   * to read again for the current answer.
   */
  fromLastRead: Schema.optional(Schema.Boolean),
  totals: LocalUsageHistoryTokenTotals,
  cost: LocalUsageHistoryCostTotals,
  providers: Schema.Array(LocalUsageHistoryGroup).check(Schema.isMaxLength(128)),
  models: Schema.Array(LocalUsageHistoryGroup).check(Schema.isMaxLength(256)),
  days: Schema.Array(LocalUsageHistoryDay).check(Schema.isMaxLength(512)),
  dailyTotals: Schema.Array(LocalUsageHistoryDay).check(Schema.isMaxLength(512)),
  coverage: Schema.Array(LocalUsageHistoryCoverage).check(Schema.isMaxLength(32)),
});
export type LocalUsageHistoryResponse = typeof LocalUsageHistoryResponse.Type;

export const decodeLocalUsageHistoryRecord = Schema.decodeUnknownSync(
  LocalUsageHistoryRecord,
  STRICT_DECODE_OPTIONS,
);
export const decodeLocalUsageHistoryCoverage = Schema.decodeUnknownSync(
  LocalUsageHistoryCoverage,
  STRICT_DECODE_OPTIONS,
);
export function decodeLocalUsageHistoryRequest(value: unknown): LocalUsageHistoryRequest {
  const decoded = Schema.decodeUnknownSync(LocalUsageHistoryRequest, STRICT_DECODE_OPTIONS)(value);
  if (Date.parse(decoded.from) > Date.parse(decoded.to)) {
    throw new Error("Local usage history range is inverted.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: decoded.timeZone }).format();
  } catch {
    throw new Error("Local usage history timezone is invalid.");
  }
  return decoded;
}
export const decodeLocalUsageHistoryResponse = Schema.decodeUnknownSync(
  LocalUsageHistoryResponse,
  STRICT_DECODE_OPTIONS,
);
