import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId, ProviderProcessDiagnostic } from "./providers";
import {
  TurnFailureFacts,
  TurnFailureMessage,
  TurnRetryTally,
  TurnStopReason,
} from "./turnMetrics";
import { UsageQueryFilter } from "./usageRpc";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonNegativeNumber = Schema.Number.pipe(Schema.nonNegative(), Schema.finite());

export const MAX_DIAGNOSTICS_MODELS = 100;
export const MAX_DIAGNOSTICS_TOOLS = 100;
export const MAX_DIAGNOSTICS_FAILURE_GROUPS = 50;
export const MAX_DIAGNOSTICS_RECENT_FAILURES = 50;
export const MAX_DIAGNOSTICS_CACHE_MISSES = 20;
/** Thirty-one days of hours. */
export const MAX_DIAGNOSTICS_TREND_BUCKETS = 744;

export const TurnDiagnosticsBucketSize = Schema.Literal("hour", "day");
export type TurnDiagnosticsBucketSize = typeof TurnDiagnosticsBucketSize.Type;

/**
 * A read of how turns went over a span: the same Project scope and filter as a
 * usage read, grouped into hours or days. `timeZone` places day boundaries;
 * hours are UTC hours.
 */
export const UsageDiagnosticsRequest = Schema.Struct({
  filter: Schema.optional(UsageQueryFilter),
  bucket: Schema.optional(TurnDiagnosticsBucketSize),
  timeZone: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type UsageDiagnosticsRequest = typeof UsageDiagnosticsRequest.Type;

/** How many turns ended each way. */
export const TurnStopReasonCounts = Schema.Struct({
  "end-of-turn": NonNegativeInt,
  "max-tokens": NonNegativeInt,
  cancelled: NonNegativeInt,
  failed: NonNegativeInt,
  waiting: NonNegativeInt,
}).annotations(strict);
export type TurnStopReasonCounts = typeof TurnStopReasonCounts.Type;

/**
 * Nearest-rank percentiles over the turns that measured the figure. Absent
 * from a row when no turn did, so a surface never shows a zero it did not see.
 */
export const DiagnosticsPercentiles = Schema.Struct({
  count: PositiveInt,
  p50: NonNegativeNumber,
  p95: NonNegativeNumber,
  max: NonNegativeNumber,
}).annotations(strict);
export type DiagnosticsPercentiles = typeof DiagnosticsPercentiles.Type;

/**
 * One provider instance and model: how its turns ended, what failed inside
 * them, and how fast they ran. The benchmark row.
 */
export const TurnDiagnosticsModelRow = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  turns: PositiveInt,
  /** Turns recorded with diagnostics; the tool, retry, and limit counts cover only these. */
  diagnosedTurns: NonNegativeInt,
  stopReasons: TurnStopReasonCounts,
  contentFilterStops: NonNegativeInt,
  toolCalls: NonNegativeInt,
  toolFailures: NonNegativeInt,
  retries: NonNegativeInt,
  /** Turns that saw a rate-limit warning or ran out. */
  rateLimitedTurns: NonNegativeInt,
  timeToFirstTokenMs: Schema.optional(DiagnosticsPercentiles),
  /** Per-turn output tokens over decode time. */
  decodeTokensPerSecond: Schema.optional(DiagnosticsPercentiles),
  wallMs: Schema.optional(DiagnosticsPercentiles),
  /** Sums over turns that reported usage. */
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  /**
   * Prompt-cache figures over only the turns that reported them, so a hit rate
   * is `readTokens` over `inputTokens` here and weighted by input. Absent when
   * no turn reported a cache figure: a provider that never says is not a 0%
   * hit rate.
   */
  cache: Schema.optional(
    Schema.Struct({
      inputTokens: NonNegativeInt,
      readTokens: NonNegativeInt,
      writeTokens: NonNegativeInt,
    }).annotations(strict),
  ),
  likelyCacheMisses: NonNegativeInt,
  costUsd: Schema.optional(NonNegativeNumber),
}).annotations(strict);
export type TurnDiagnosticsModelRow = typeof TurnDiagnosticsModelRow.Type;

/** One tool across every matching turn. `turns` counts the turns that called it. */
export const TurnDiagnosticsToolRow = Schema.Struct({
  toolName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  turns: PositiveInt,
  calls: PositiveInt,
  failed: NonNegativeInt,
  unfinished: NonNegativeInt,
  nonZeroExits: NonNegativeInt,
  /** Over calls that finished. */
  totalMs: NonNegativeInt,
  maxMs: NonNegativeInt,
}).annotations(strict);
export type TurnDiagnosticsToolRow = typeof TurnDiagnosticsToolRow.Type;

/**
 * Failed turns that share a provider category and process kind. The message is
 * the most recent one in the group, already redacted when it was recorded.
 */
export const TurnDiagnosticsFailureGroup = Schema.Struct({
  category: TurnFailureFacts.fields.category,
  processKind: Schema.optional(ProviderProcessDiagnostic.fields.kind),
  count: PositiveInt,
  firstAt: UtcTimestamp,
  lastAt: UtcTimestamp,
  lastMessage: Schema.optional(TurnFailureMessage),
}).annotations(strict);
export type TurnDiagnosticsFailureGroup = typeof TurnDiagnosticsFailureGroup.Type;

/** A turn that failed, was cancelled, or had a tool fail, newest first: the drill-in list. */
export const TurnDiagnosticsTroubledTurn = Schema.Struct({
  threadId: Schema.UUID,
  mode: OctantMode,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  stopReason: TurnStopReason,
  startedAt: UtcTimestamp,
  endedAt: UtcTimestamp,
  toolFailures: NonNegativeInt,
  retries: NonNegativeInt,
  failure: Schema.optional(TurnFailureFacts),
}).annotations(strict);
export type TurnDiagnosticsTroubledTurn = typeof TurnDiagnosticsTroubledTurn.Type;

/**
 * A turn that probably should have read the prompt cache and did not: the one
 * before it in the same thread, on the same provider and model, ended under
 * five minutes earlier and read or wrote the cache, and this one sent a large
 * prompt and read none of it. It is a likelihood, not a fact the provider
 * reported; a changed system prompt or tool list also breaks the cache.
 */
export const TurnDiagnosticsCacheMiss = Schema.Struct({
  threadId: Schema.UUID,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  endedAt: UtcTimestamp,
  inputTokens: PositiveInt,
  /** From the previous turn's end to this turn's start. */
  gapMs: NonNegativeInt,
}).annotations(strict);
export type TurnDiagnosticsCacheMiss = typeof TurnDiagnosticsCacheMiss.Type;

export const TurnDiagnosticsBucket = Schema.Struct({
  /** The bucket's start: an ISO hour in UTC, or a calendar date in the request's time zone. */
  key: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32)),
  turns: PositiveInt,
  failed: NonNegativeInt,
  cancelled: NonNegativeInt,
  toolCalls: NonNegativeInt,
  toolFailures: NonNegativeInt,
  retries: NonNegativeInt,
  timeToFirstTokenP50Ms: Schema.optional(NonNegativeNumber),
  decodeTokensPerSecondP50: Schema.optional(NonNegativeNumber),
}).annotations(strict);
export type TurnDiagnosticsBucket = typeof TurnDiagnosticsBucket.Type;

export const TurnDiagnosticsTotals = Schema.Struct({
  stopReasons: TurnStopReasonCounts,
  contentFilterStops: NonNegativeInt,
  toolCalls: NonNegativeInt,
  toolFailures: NonNegativeInt,
  unfinishedToolCalls: NonNegativeInt,
  /**
   * Turns whose per-tool tallies were cut to the most-called tools when the
   * turn was recorded. Their per-tool figures, including unfinished calls, are
   * partial; the call and failure totals above are not.
   */
  toolTalliesTruncatedTurns: Schema.optional(NonNegativeInt),
  retries: Schema.Array(TurnRetryTally).pipe(Schema.maxItems(4)),
  approvalRequests: NonNegativeInt,
  inputRequests: NonNegativeInt,
  rateLimitWarnings: NonNegativeInt,
  rateLimitExhaustedTurns: NonNegativeInt,
  compactions: NonNegativeInt,
  likelyCacheMisses: NonNegativeInt,
  timeToFirstTokenMs: Schema.optional(DiagnosticsPercentiles),
  decodeTokensPerSecond: Schema.optional(DiagnosticsPercentiles),
  wallMs: Schema.optional(DiagnosticsPercentiles),
}).annotations(strict);
export type TurnDiagnosticsTotals = typeof TurnDiagnosticsTotals.Type;

/**
 * How every matching turn went, built from the recorded turn frames on each
 * read. Lists are cut to their bounds; the totals still count everything.
 */
export const TurnDiagnosticsReport = Schema.Struct({
  generatedAt: UtcTimestamp,
  bucket: TurnDiagnosticsBucketSize,
  turns: NonNegativeInt,
  diagnosedTurns: NonNegativeInt,
  totals: TurnDiagnosticsTotals,
  models: Schema.Array(TurnDiagnosticsModelRow).pipe(Schema.maxItems(MAX_DIAGNOSTICS_MODELS)),
  tools: Schema.Array(TurnDiagnosticsToolRow).pipe(Schema.maxItems(MAX_DIAGNOSTICS_TOOLS)),
  failureGroups: Schema.Array(TurnDiagnosticsFailureGroup).pipe(
    Schema.maxItems(MAX_DIAGNOSTICS_FAILURE_GROUPS),
  ),
  troubledTurns: Schema.Array(TurnDiagnosticsTroubledTurn).pipe(
    Schema.maxItems(MAX_DIAGNOSTICS_RECENT_FAILURES),
  ),
  cacheMisses: Schema.Array(TurnDiagnosticsCacheMiss).pipe(
    Schema.maxItems(MAX_DIAGNOSTICS_CACHE_MISSES),
  ),
  trend: Schema.Array(TurnDiagnosticsBucket).pipe(Schema.maxItems(MAX_DIAGNOSTICS_TREND_BUCKETS)),
}).annotations(strict);
export type TurnDiagnosticsReport = typeof TurnDiagnosticsReport.Type;

export const decodeUsageDiagnosticsRequest = Schema.decodeUnknownSync(UsageDiagnosticsRequest);
export const decodeTurnDiagnosticsReport = Schema.decodeUnknownSync(TurnDiagnosticsReport);
