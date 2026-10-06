import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());

/**
 * What one turn cost, as the provider reported it. `inputTokens` is all input,
 * cached or not; `cacheReadInputTokens` and `cacheWriteInputTokens` are the
 * parts of it read from or written to the prompt cache, and `reasoningTokens`
 * is the part of `outputTokens` spent thinking. A figure the provider did not
 * report is absent rather than zero, and Octant holds no price list.
 */
export const TurnUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  costUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
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
 * - `unavailable`: the provider reported no output tokens, or streamed no
 *   text or reasoning to time them against. The figures are absent.
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

/** Why a turn ended: the provider finished, a person stopped it, it failed, or its outcome is unknown. */
export const TurnStopReason = Schema.Literal("end-of-turn", "cancelled", "failed", "waiting");
export type TurnStopReason = typeof TurnStopReason.Type;

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
export const decodeTurnMetricsRecord = Schema.decodeUnknownSync(TurnMetricsRecord);
export const decodeTurnMetricsSummary = Schema.decodeUnknownSync(TurnMetricsSummary);
