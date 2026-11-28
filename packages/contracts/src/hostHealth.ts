import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Days of host-health samples a host keeps. */
export const HOST_HEALTH_RETENTION_DAYS = 14;
/** One sample a minute, so a full retention window is 20,160 samples. */
export const HOST_HEALTH_SAMPLE_INTERVAL_MS = 60_000;
/** The most points one read returns; a longer span is rolled up to hours. */
export const MAX_HOST_HEALTH_POINTS = 2_016;

/** One host measurement's latency inside a sample window. */
export const HostHealthLatency = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  count: PositiveInt,
  p50Ms: NonNegativeInt,
  p95Ms: NonNegativeInt,
  maxMs: NonNegativeInt,
});
export type HostHealthLatency = typeof HostHealthLatency.Type;

/**
 * How the host process was doing over one window: memory, event-loop stalls,
 * slow database statements, the database's size, and each host measurement's
 * latency. Numbers only: no route, SQL, thread, or Project appears.
 * `processStartedAt` changes when the host restarts, which is how a reader
 * marks restarts on a timeline.
 */
export const HostHealthSample = Schema.Struct({
  sampledAt: UtcTimestamp,
  windowMs: PositiveInt,
  processStartedAt: UtcTimestamp,
  rssBytes: NonNegativeInt,
  heapUsedBytes: NonNegativeInt,
  databaseBytes: Schema.optional(NonNegativeInt),
  eventLoopLagCount: NonNegativeInt,
  eventLoopLagWorstMs: NonNegativeInt,
  slowStatementCount: NonNegativeInt,
  slowStatementWorstMs: NonNegativeInt,
  latency: Schema.Array(HostHealthLatency).check(Schema.isMaxLength(16)),
});
export type HostHealthSample = typeof HostHealthSample.Type;

export const HostHealthResolution = Schema.Literals(["minute", "hour"]);
export type HostHealthResolution = typeof HostHealthResolution.Type;

export const HostHealthHistoryRequest = Schema.Struct({
  from: Schema.optional(UtcTimestamp),
  to: Schema.optional(UtcTimestamp),
  /**
   * Absent picks minutes when they fit in `MAX_HOST_HEALTH_POINTS`, else hours.
   * Minutes asked for over a longer span return the newest
   * `MAX_HOST_HEALTH_POINTS` of them.
   */
  resolution: Schema.optional(HostHealthResolution),
}).check(
  Schema.makeFilter(
    (request) =>
      request.from === undefined || request.to === undefined || request.from <= request.to,
  ),
);
export type HostHealthHistoryRequest = typeof HostHealthHistoryRequest.Type;

/**
 * Host-health samples over a span, oldest first. An hour point sums the counts
 * of its minutes and keeps their worst figures: the highest memory, the worst
 * stall, and the highest p95 and maximum latency of any minute in it.
 */
export const HostHealthHistory = Schema.Struct({
  generatedAt: UtcTimestamp,
  resolution: HostHealthResolution,
  retentionDays: PositiveInt,
  /**
   * The host process starts that replaced an earlier process, oldest first,
   * read from the minute samples before any roll-up so restarts inside one
   * hour are all counted. The process already running when the span began is
   * not a restart, and neither is the first process seen when nothing was
   * recorded before the span; a process that started inside the span, after one
   * recorded before it, is.
   */
  restarts: Schema.Array(UtcTimestamp).check(Schema.isMaxLength(MAX_HOST_HEALTH_POINTS)),
  samples: Schema.Array(HostHealthSample).check(Schema.isMaxLength(MAX_HOST_HEALTH_POINTS)),
});
export type HostHealthHistory = typeof HostHealthHistory.Type;

export const decodeHostHealthSample = Schema.decodeUnknownSync(
  HostHealthSample,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostHealthHistoryRequest = Schema.decodeUnknownSync(
  HostHealthHistoryRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostHealthHistory = Schema.decodeUnknownSync(
  HostHealthHistory,
  STRICT_DECODE_OPTIONS,
);
