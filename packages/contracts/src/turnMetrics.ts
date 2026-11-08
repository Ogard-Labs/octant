import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import {
  ProviderFailureCategory,
  ProviderInstanceId,
  ProviderModelId,
  ProviderOutputStopReason,
  ProviderProcessDiagnostic,
  ProviderRefusalReason,
  ProviderUsageLimit,
} from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());

/**
 * What one turn cost, as the provider reported it. `inputTokens` is all input,
 * cached or not; `cacheReadInputTokens` and `cacheWriteInputTokens` are the
 * parts of it read from or written to the prompt cache, and `reasoningTokens`
 * is the part of `outputTokens` spent thinking. A figure the provider did not
 * report is absent rather than zero. Host API estimates remain separate from provider costs.
 */
export const TurnUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  costUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
  /** Host estimate across known request boundaries; null means incomplete/unpriced. */
  estimatedCostUsd: Schema.optional(
    Schema.NullOr(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
  ),
}).annotations(strict);
export type TurnUsage = typeof TurnUsage.Type;

/**
 * How a speed figure was measured, stated by the host and never inferred by a
 * surface.
 *
 * - `exact`: the window holds model time only. A report for one model request,
 *   or a turn that made a single request and ran no tool.
 * - `approximate`: one report for a turn whose window also held tool calls or
 *   waits. Tool spans the provider streamed are taken out; any it did not
 *   stream stay in.
 * - `unavailable`: the provider reported no output tokens, streamed no text or
 *   reasoning to time them against, or delivered the reply in a burst too short
 *   to carry a rate (see `MIN_DECODE_WINDOW_MS`). The figures are absent.
 */
export const TurnMetricsPrecision = Schema.Literal("exact", "approximate", "unavailable");
export type TurnMetricsPrecision = typeof TurnMetricsPrecision.Type;

/**
 * The timing facts of one turn. Decode speed is `decodeOutputTokens` over
 * `decodeMs`, kept as the two figures it divides so a total over many turns is
 * weighted rather than an average of ratios.
 */
export const TurnMetrics = Schema.Struct({
  precision: TurnMetricsPrecision,
  /** From the prompt being sent to the end of the turn. */
  wallMs: NonNegativeInt,
  /** The prompt being sent to the first text or reasoning delta. */
  timeToFirstTokenMs: Schema.optional(NonNegativeInt),
  /** Output tokens that were produced inside `decodeMs`. */
  decodeOutputTokens: Schema.optional(PositiveInt),
  /** First delta to completion, with tool time taken out. */
  decodeMs: Schema.optional(PositiveInt),
  /** Tool and wait time between the first delta and completion. */
  toolMs: Schema.optional(NonNegativeInt),
  /** Model requests the figures cover: more than one only when `exact`. */
  modelCalls: Schema.optional(PositiveInt),
  /** Times the endpoint failed in a way that usually passes and was asked again. */
  retries: Schema.optional(PositiveInt),
})
  .annotations(strict)
  .pipe(
    Schema.filter((metrics) => {
      const timed =
        metrics.timeToFirstTokenMs !== undefined &&
        metrics.decodeOutputTokens !== undefined &&
        metrics.decodeMs !== undefined &&
        metrics.toolMs !== undefined &&
        metrics.modelCalls !== undefined;
      const untimed =
        metrics.timeToFirstTokenMs === undefined &&
        metrics.decodeOutputTokens === undefined &&
        metrics.decodeMs === undefined &&
        metrics.toolMs === undefined &&
        metrics.modelCalls === undefined;
      return metrics.precision === "unavailable" ? untimed : timed;
    }),
  );
export type TurnMetrics = typeof TurnMetrics.Type;

/**
 * Timing over many turns. Only measured turns contribute, and the precision is
 * the weakest of theirs: one approximate turn makes the whole figure
 * approximate. Tokens per second is `decodeOutputTokens` over `decodeMs`, so
 * long turns weigh more than short ones.
 */
export const SessionMetrics = Schema.Struct({
  turns: NonNegativeInt,
  measuredTurns: NonNegativeInt,
  precision: TurnMetricsPrecision,
  decodeOutputTokens: NonNegativeInt,
  decodeMs: NonNegativeInt,
  toolMs: NonNegativeInt,
  timeToFirstTokenTotalMs: NonNegativeInt,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (metrics) =>
        metrics.measuredTurns <= metrics.turns &&
        (metrics.measuredTurns === 0) === (metrics.precision === "unavailable"),
    ),
  );
export type SessionMetrics = typeof SessionMetrics.Type;

/**
 * Why a turn ended: the provider finished, the reply was cut off at the output
 * limit, a person stopped it, it failed, or its outcome is unknown.
 */
export const TurnStopReason = Schema.Literal(
  "end-of-turn",
  "max-tokens",
  "cancelled",
  "failed",
  "waiting",
);
export type TurnStopReason = typeof TurnStopReason.Type;

export const MAX_TURN_DIAGNOSTIC_TOOLS = 32;
export const MAX_TURN_FAILURE_MESSAGE_LENGTH = 512;

/** A tool name as the runtime reported it, bounded so a frame stays small. */
const DiagnosticToolName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));

/**
 * One tool's calls within a turn. `failed` counts `tool-failure` results and
 * `unfinished` counts calls that started and never reported a result before
 * the turn ended. Durations cover only calls that finished, from `tool-start`
 * to the result.
 */
export const TurnToolTally = Schema.Struct({
  toolName: DiagnosticToolName,
  calls: PositiveInt,
  failed: NonNegativeInt,
  unfinished: NonNegativeInt,
  /** Calls whose shell result reported a non-zero exit status. */
  nonZeroExits: Schema.optional(PositiveInt),
  totalMs: NonNegativeInt,
  maxMs: NonNegativeInt,
})
  .annotations(strict)
  .pipe(Schema.filter((tally) => tally.failed + tally.unfinished <= tally.calls));
export type TurnToolTally = typeof TurnToolTally.Type;

/** The retries one reason caused, and how long they made the turn wait. */
export const TurnRetryTally = Schema.Struct({
  reason: Schema.Literal("rate-limited", "unavailable", "stream-interrupted", "empty-completion"),
  count: PositiveInt,
  waitMs: NonNegativeInt,
}).annotations(strict);
export type TurnRetryTally = typeof TurnRetryTally.Type;

/**
 * The provider's structured reason for failing a turn. Everything but
 * `message` is a closed value the adapter set. `message` is the provider's own
 * line, redacted by the diagnostics rules (credentials, URL sign-ins, and home
 * paths are removed), folded onto one line, and cut to
 * `MAX_TURN_FAILURE_MESSAGE_LENGTH`; it is what a person investigating the
 * failure reads first.
 */
export const TurnFailureFacts = Schema.Struct({
  category: ProviderFailureCategory,
  reason: Schema.optional(ProviderRefusalReason),
  process: Schema.optional(
    Schema.Struct({
      stage: ProviderProcessDiagnostic.fields.stage,
      kind: ProviderProcessDiagnostic.fields.kind,
      exitCode: ProviderProcessDiagnostic.fields.exitCode,
      signal: ProviderProcessDiagnostic.fields.signal,
    }).annotations(strict),
  ),
  usageLimit: Schema.optional(ProviderUsageLimit.fields.kind),
  retryAfterMs: Schema.optional(PositiveInt),
  message: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(MAX_TURN_FAILURE_MESSAGE_LENGTH),
      Schema.pattern(/^[^\n\r]*$/),
    ),
  ),
}).annotations(strict);
export type TurnFailureFacts = typeof TurnFailureFacts.Type;

/**
 * What went wrong, or nearly wrong, inside one turn, counted from the same
 * normalized runtime events its timing is. Counts are absent rather than zero
 * except the two tool totals, which are always stated so a turn that ran no
 * tool reads as zero calls. It holds closed values and numbers, plus the one
 * redacted failure line; tool input, tool output, and tool failure text never
 * appear, because the transcript already holds them for the person who opens
 * the turn.
 */
export const TurnDiagnostics = Schema.Struct({
  toolCalls: NonNegativeInt,
  toolFailures: NonNegativeInt,
  /** Per-tool tallies, the most-called first, cut to `MAX_TURN_DIAGNOSTIC_TOOLS`. */
  tools: Schema.optional(
    Schema.Array(TurnToolTally).pipe(Schema.maxItems(MAX_TURN_DIAGNOSTIC_TOOLS)),
  ),
  /** Set when more distinct tools ran than `tools` holds; the totals still count them. */
  toolsTruncated: Schema.optional(Schema.Literal(true)),
  retries: Schema.optional(Schema.Array(TurnRetryTally).pipe(Schema.maxItems(4))),
  approvalRequests: Schema.optional(PositiveInt),
  inputRequests: Schema.optional(PositiveInt),
  /** Rolling-window or bucket reports at warning or exhausted while the turn ran. */
  rateLimitWarnings: Schema.optional(PositiveInt),
  rateLimitExhausted: Schema.optional(Schema.Literal(true)),
  compactions: Schema.optional(PositiveInt),
  /** The runtime's own reason a completed reply stopped, when it gave one. */
  outputStopReason: Schema.optional(ProviderOutputStopReason),
  /** Present when the provider ended the turn with a structured failure. */
  failure: Schema.optional(TurnFailureFacts),
})
  .annotations(strict)
  .pipe(Schema.filter((diagnostics) => diagnostics.toolFailures <= diagnostics.toolCalls));
export type TurnDiagnostics = typeof TurnDiagnostics.Type;

/**
 * One turn of any thread on any provider, recorded when it ends however it
 * ends. Failed and cancelled turns are recorded too: what they cost and how
 * long they ran still happened.
 */
export const TurnMetricsRecord = Schema.Struct({
  threadId: Schema.UUID,
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  stopReason: TurnStopReason,
  /** Absent when the provider reported no usage, which is not the same as zero. */
  usage: Schema.optional(TurnUsage),
  metrics: TurnMetrics,
  /** Absent on turns recorded before diagnostics were counted. */
  diagnostics: Schema.optional(TurnDiagnostics),
  startedAt: UtcTimestamp,
  endedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((record) => record.endedAt >= record.startedAt));
export type TurnMetricsRecord = typeof TurnMetricsRecord.Type;

export const MAX_TURN_METRICS_SUMMARY_TURNS = 50;

/**
 * What a read of turn metrics returns: the recent tail of turns, newest last,
 * and totals over every matching turn, so the tail scrolling on does not move
 * the totals.
 */
export const TurnMetricsSummary = Schema.Struct({
  turns: Schema.Array(TurnMetricsRecord).pipe(Schema.maxItems(MAX_TURN_METRICS_SUMMARY_TURNS)),
  turnCount: NonNegativeInt,
  /** Absent when no matching turn reported usage. */
  usage: Schema.optional(TurnUsage),
  metrics: SessionMetrics,
}).annotations(strict);
export type TurnMetricsSummary = typeof TurnMetricsSummary.Type;

export const TURN_METRICS_AGGREGATE_TYPE = "thread-turn-metrics";
export const TURN_METRICS_EVENT_NAMES = {
  recorded: "turn-metrics-recorded@1",
} as const;

export const decodeTurnUsage = Schema.decodeUnknownSync(TurnUsage);
export const decodeTurnMetrics = Schema.decodeUnknownSync(TurnMetrics);
export const decodeSessionMetrics = Schema.decodeUnknownSync(SessionMetrics);
export const decodeTurnDiagnostics = Schema.decodeUnknownSync(TurnDiagnostics);
export const decodeTurnMetricsRecord = Schema.decodeUnknownSync(TurnMetricsRecord);
export const decodeTurnMetricsSummary = Schema.decodeUnknownSync(TurnMetricsSummary);
