import {
  MAX_DIAGNOSTICS_CACHE_MISSES,
  MAX_DIAGNOSTICS_FAILURE_GROUPS,
  MAX_DIAGNOSTICS_MODELS,
  MAX_DIAGNOSTICS_RECENT_FAILURES,
  MAX_DIAGNOSTICS_TOOLS,
  MAX_DIAGNOSTICS_TREND_BUCKETS,
  type DiagnosticsPercentiles,
  type TurnDiagnosticsBucket,
  type TurnDiagnosticsBucketSize,
  type TurnDiagnosticsCacheMiss,
  type TurnDiagnosticsFailureGroup,
  type TurnDiagnosticsModelRow,
  type TurnDiagnosticsReport,
  type TurnDiagnosticsToolRow,
  type TurnDiagnosticsTroubledTurn,
  type TurnMetricsRecord,
  type TurnRetryTally,
  type TurnStopReasonCounts,
  type UtcTimestamp,
} from "@octant/contracts";

/**
 * How a set of recorded turns went, built fresh on each read from the turn
 * frames alone: stop reasons, failures grouped by cause, tool reliability,
 * retries and rate-limit pressure, likely prompt-cache misses, and
 * per-model speed percentiles for benchmarking.
 *
 * A turn recorded before diagnostics were counted still counts toward its
 * stop reason and speed, and toward nothing that needs its diagnostics, so an
 * old turn never reads as a clean one.
 */

/**
 * The longest gap after which a following turn is still expected to read the
 * prompt cache. Providers keep a written prefix for about five minutes.
 */
export const CACHE_EXPECTATION_WINDOW_MS = 5 * 60_000;
/** Prompts smaller than this are often below a provider's cacheable minimum. */
export const CACHE_EXPECTATION_MIN_INPUT_TOKENS = 2_048;

export interface TurnDiagnosticsReportOptions {
  readonly generatedAt: string;
  readonly bucket: TurnDiagnosticsBucketSize;
  /** Places day boundaries. An unknown zone falls back to UTC. */
  readonly timeZone: string;
}

const RETRY_REASONS: ReadonlyArray<TurnRetryTally["reason"]> = [
  "rate-limited",
  "unavailable",
  "stream-interrupted",
  "empty-completion",
];

interface ModelAccumulator {
  readonly providerInstanceId: TurnMetricsRecord["providerInstanceId"];
  readonly modelId: TurnMetricsRecord["modelId"];
  turns: number;
  diagnosedTurns: number;
  stopReasons: Record<keyof TurnStopReasonCounts, number>;
  contentFilterStops: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  rateLimitedTurns: number;
  ttft: number[];
  decodeRates: number[];
  wall: number[];
  inputTokens: number;
  outputTokens: number;
  cache: { inputTokens: number; readTokens: number; writeTokens: number } | undefined;
  likelyCacheMisses: number;
  costUsd: number | undefined;
}

interface ToolAccumulator {
  turns: number;
  calls: number;
  failed: number;
  unfinished: number;
  nonZeroExits: number;
  totalMs: number;
  maxMs: number;
}

interface BucketAccumulator {
  turns: number;
  failed: number;
  cancelled: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  ttft: number[];
  decodeRates: number[];
}

function emptyStopReasons(): Record<keyof TurnStopReasonCounts, number> {
  return { "end-of-turn": 0, "max-tokens": 0, cancelled: 0, failed: 0, waiting: 0 };
}

export function buildTurnDiagnosticsReport(
  records: ReadonlyArray<TurnMetricsRecord>,
  options: TurnDiagnosticsReportOptions,
): TurnDiagnosticsReport {
  const sorted = [...records].sort((left, right) => left.endedAt.localeCompare(right.endedAt));
  const misses = likelyCacheMisses(sorted);
  const missedTurns = new Set(misses.map((miss) => missKey(miss.threadId, miss.endedAt)));
  const dayKey = dayKeyFormatter(options.timeZone);

  const stopReasons = emptyStopReasons();
  const retryTotals = new Map<TurnRetryTally["reason"], { count: number; waitMs: number }>();
  const models = new Map<string, ModelAccumulator>();
  const tools = new Map<string, ToolAccumulator>();
  const groups = new Map<string, TurnDiagnosticsFailureGroup>();
  const buckets = new Map<string, BucketAccumulator>();
  const troubled: TurnDiagnosticsTroubledTurn[] = [];
  const allTtft: number[] = [];
  const allDecodeRates: number[] = [];
  const allWall: number[] = [];
  let diagnosedTurns = 0;
  let contentFilterStops = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let unfinishedToolCalls = 0;
  let toolTalliesTruncatedTurns = 0;
  let approvalRequests = 0;
  let inputRequests = 0;
  let rateLimitWarnings = 0;
  let rateLimitExhaustedTurns = 0;
  let compactions = 0;

  for (const record of sorted) {
    const diagnostics = record.diagnostics;
    const metrics = record.metrics;
    const ttft = metrics.timeToFirstTokenMs;
    const decodeRate =
      metrics.decodeOutputTokens !== undefined && metrics.decodeMs !== undefined
        ? metrics.decodeOutputTokens / (metrics.decodeMs / 1_000)
        : undefined;
    const turnRetries = diagnostics?.retries?.reduce((sum, tally) => sum + tally.count, 0) ?? 0;
    const rateLimited =
      diagnostics !== undefined &&
      ((diagnostics.rateLimitWarnings ?? 0) > 0 ||
        diagnostics.retries?.some((tally) => tally.reason === "rate-limited") === true ||
        diagnostics.failure?.category === "rate-limited");

    stopReasons[record.stopReason] += 1;
    allWall.push(metrics.wallMs);
    if (ttft !== undefined) allTtft.push(ttft);
    if (decodeRate !== undefined) allDecodeRates.push(decodeRate);

    const modelKey = `${String(record.providerInstanceId)}\u0000${String(record.modelId)}`;
    const model = models.get(modelKey) ?? newModel(record);
    models.set(modelKey, model);
    model.turns += 1;
    model.stopReasons[record.stopReason] += 1;
    model.wall.push(metrics.wallMs);
    if (ttft !== undefined) model.ttft.push(ttft);
    if (decodeRate !== undefined) model.decodeRates.push(decodeRate);
    if (record.usage !== undefined) {
      model.inputTokens += record.usage.inputTokens;
      model.outputTokens += record.usage.outputTokens;
      const { cacheReadInputTokens, cacheWriteInputTokens } = record.usage;
      if (cacheReadInputTokens !== undefined || cacheWriteInputTokens !== undefined) {
        const cache = model.cache ?? { inputTokens: 0, readTokens: 0, writeTokens: 0 };
        cache.inputTokens += record.usage.inputTokens;
        cache.readTokens += cacheReadInputTokens ?? 0;
        cache.writeTokens += cacheWriteInputTokens ?? 0;
        model.cache = cache;
      }
      if (record.usage.costUsd !== undefined) {
        model.costUsd = (model.costUsd ?? 0) + record.usage.costUsd;
      }
    }
    if (missedTurns.has(missKey(record.threadId, record.endedAt))) model.likelyCacheMisses += 1;

    const bucketKey =
      options.bucket === "hour" ? `${record.endedAt.slice(0, 13)}:00:00Z` : dayKey(record.endedAt);
    const bucket = buckets.get(bucketKey) ?? newBucket();
    buckets.set(bucketKey, bucket);
    bucket.turns += 1;
    if (record.stopReason === "failed") bucket.failed += 1;
    if (record.stopReason === "cancelled") bucket.cancelled += 1;
    if (ttft !== undefined) bucket.ttft.push(ttft);
    if (decodeRate !== undefined) bucket.decodeRates.push(decodeRate);

    if (diagnostics !== undefined) {
      diagnosedTurns += 1;
      model.diagnosedTurns += 1;
      toolCalls += diagnostics.toolCalls;
      toolFailures += diagnostics.toolFailures;
      model.toolCalls += diagnostics.toolCalls;
      model.toolFailures += diagnostics.toolFailures;
      model.retries += turnRetries;
      bucket.toolCalls += diagnostics.toolCalls;
      bucket.toolFailures += diagnostics.toolFailures;
      bucket.retries += turnRetries;
      approvalRequests += diagnostics.approvalRequests ?? 0;
      inputRequests += diagnostics.inputRequests ?? 0;
      rateLimitWarnings += diagnostics.rateLimitWarnings ?? 0;
      compactions += diagnostics.compactions ?? 0;
      if (diagnostics.rateLimitExhausted === true) rateLimitExhaustedTurns += 1;
      if (rateLimited) model.rateLimitedTurns += 1;
      if (diagnostics.outputStopReason === "content-filter") {
        contentFilterStops += 1;
        model.contentFilterStops += 1;
      }
      for (const tally of diagnostics.retries ?? []) {
        const total = retryTotals.get(tally.reason) ?? { count: 0, waitMs: 0 };
        retryTotals.set(tally.reason, {
          count: total.count + tally.count,
          waitMs: total.waitMs + tally.waitMs,
        });
      }
      if (diagnostics.toolsTruncated === true) toolTalliesTruncatedTurns += 1;
      for (const tally of diagnostics.tools ?? []) {
        unfinishedToolCalls += tally.unfinished;
        const tool = tools.get(tally.toolName) ?? newTool();
        tools.set(tally.toolName, tool);
        tool.turns += 1;
        tool.calls += tally.calls;
        tool.failed += tally.failed;
        tool.unfinished += tally.unfinished;
        tool.nonZeroExits += tally.nonZeroExits ?? 0;
        tool.totalMs += tally.totalMs;
        tool.maxMs = Math.max(tool.maxMs, tally.maxMs);
      }
      const failure = diagnostics.failure;
      if (failure !== undefined) {
        const groupKey = `${failure.category}\u0000${failure.process?.kind ?? ""}`;
        const existing = groups.get(groupKey);
        groups.set(groupKey, {
          category: failure.category,
          ...(failure.process === undefined ? {} : { processKind: failure.process.kind }),
          count: (existing?.count ?? 0) + 1,
          firstAt: existing?.firstAt ?? record.endedAt,
          lastAt: record.endedAt,
          ...(failure.message === undefined
            ? existing?.lastMessage === undefined
              ? {}
              : { lastMessage: existing.lastMessage }
            : { lastMessage: failure.message }),
        });
      }
    }

    const isTroubled =
      record.stopReason === "failed" ||
      record.stopReason === "cancelled" ||
      record.stopReason === "max-tokens" ||
      (diagnostics?.toolFailures ?? 0) > 0 ||
      turnRetries > 0;
    if (isTroubled) {
      troubled.push({
        threadId: record.threadId,
        mode: record.mode,
        providerInstanceId: record.providerInstanceId,
        modelId: record.modelId,
        stopReason: record.stopReason,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        toolFailures: diagnostics?.toolFailures ?? 0,
        retries: turnRetries,
        ...(diagnostics?.failure === undefined ? {} : { failure: diagnostics.failure }),
      });
    }
  }

  const retries: TurnRetryTally[] = [];
  for (const reason of RETRY_REASONS) {
    const total = retryTotals.get(reason);
    if (total !== undefined) retries.push({ reason, count: total.count, waitMs: total.waitMs });
  }

  const modelRows = [...models.values()]
    .sort((left, right) => right.turns - left.turns || compareModel(left, right))
    .slice(0, MAX_DIAGNOSTICS_MODELS)
    .map(toModelRow);

  const toolRows: TurnDiagnosticsToolRow[] = [...tools.entries()]
    .map(([toolName, tool]) => ({ toolName, ...tool }))
    .sort(
      (left, right) =>
        right.failed - left.failed ||
        right.calls - left.calls ||
        left.toolName.localeCompare(right.toolName),
    )
    .slice(0, MAX_DIAGNOSTICS_TOOLS);

  const failureGroups = [...groups.values()]
    .sort((left, right) => right.count - left.count || right.lastAt.localeCompare(left.lastAt))
    .slice(0, MAX_DIAGNOSTICS_FAILURE_GROUPS);

  const trend: TurnDiagnosticsBucket[] = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-MAX_DIAGNOSTICS_TREND_BUCKETS)
    .map(([key, bucket]) => {
      const ttftP50 = percentile(bucket.ttft, 0.5);
      const rateP50 = percentile(bucket.decodeRates, 0.5);
      return {
        key,
        turns: bucket.turns,
        failed: bucket.failed,
        cancelled: bucket.cancelled,
        toolCalls: bucket.toolCalls,
        toolFailures: bucket.toolFailures,
        retries: bucket.retries,
        ...(ttftP50 === undefined ? {} : { timeToFirstTokenP50Ms: ttftP50 }),
        ...(rateP50 === undefined ? {} : { decodeTokensPerSecondP50: roundRate(rateP50) }),
      };
    });

  const totalTtft = percentiles(allTtft);
  const totalDecode = percentiles(allDecodeRates, roundRate);
  const totalWall = percentiles(allWall);
  return {
    generatedAt: options.generatedAt as UtcTimestamp,
    bucket: options.bucket,
    turns: sorted.length,
    diagnosedTurns,
    totals: {
      stopReasons,
      contentFilterStops,
      toolCalls,
      toolFailures,
      unfinishedToolCalls,
      toolTalliesTruncatedTurns,
      retries,
      approvalRequests,
      inputRequests,
      rateLimitWarnings,
      rateLimitExhaustedTurns,
      compactions,
      likelyCacheMisses: misses.length,
      ...(totalTtft === undefined ? {} : { timeToFirstTokenMs: totalTtft }),
      ...(totalDecode === undefined ? {} : { decodeTokensPerSecond: totalDecode }),
      ...(totalWall === undefined ? {} : { wallMs: totalWall }),
    },
    models: modelRows,
    tools: toolRows,
    failureGroups,
    troubledTurns: troubled.reverse().slice(0, MAX_DIAGNOSTICS_RECENT_FAILURES),
    cacheMisses: [...misses].reverse().slice(0, MAX_DIAGNOSTICS_CACHE_MISSES),
    trend,
  };
}

/**
 * Turns that followed a cache-reading or cache-writing turn of the same thread,
 * provider, and model within the expectation window, sent a prompt large
 * enough to cache, reported their cache figures, and read nothing from it.
 * Oldest first.
 */
export function likelyCacheMisses(
  records: ReadonlyArray<TurnMetricsRecord>,
): ReadonlyArray<TurnDiagnosticsCacheMiss> {
  const byThread = new Map<string, TurnMetricsRecord[]>();
  for (const record of records) {
    const turns = byThread.get(record.threadId) ?? [];
    turns.push(record);
    byThread.set(record.threadId, turns);
  }
  const misses: TurnDiagnosticsCacheMiss[] = [];
  for (const turns of byThread.values()) {
    turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    turns.forEach((turn, index) => {
      const previous = turns[index - 1];
      if (previous === undefined || turn.usage === undefined || previous.usage === undefined) {
        return;
      }
      if (
        String(previous.providerInstanceId) !== String(turn.providerInstanceId) ||
        String(previous.modelId) !== String(turn.modelId)
      ) {
        return;
      }
      const gapMs = Date.parse(turn.startedAt) - Date.parse(previous.endedAt);
      if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs >= CACHE_EXPECTATION_WINDOW_MS) return;
      const previousCached =
        (previous.usage.cacheReadInputTokens ?? 0) > 0 ||
        (previous.usage.cacheWriteInputTokens ?? 0) > 0;
      const reportedCache =
        turn.usage.cacheReadInputTokens !== undefined ||
        turn.usage.cacheWriteInputTokens !== undefined;
      if (
        previousCached &&
        reportedCache &&
        (turn.usage.cacheReadInputTokens ?? 0) === 0 &&
        turn.usage.inputTokens >= CACHE_EXPECTATION_MIN_INPUT_TOKENS
      ) {
        misses.push({
          threadId: turn.threadId,
          providerInstanceId: turn.providerInstanceId,
          modelId: turn.modelId,
          endedAt: turn.endedAt,
          inputTokens: turn.usage.inputTokens,
          gapMs: Math.round(gapMs),
        });
      }
    });
  }
  return misses.sort((left, right) => left.endedAt.localeCompare(right.endedAt));
}

/** Nearest-rank percentile; undefined over no values. */
export function percentile(values: ReadonlyArray<number>, fraction: number): number | undefined {
  return rank(
    [...values].sort((left, right) => left - right),
    fraction,
  );
}

function rank(sorted: ReadonlyArray<number>, fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function percentiles(
  values: ReadonlyArray<number>,
  round: (value: number) => number = Math.round,
): DiagnosticsPercentiles | undefined {
  const sorted = [...values].sort((left, right) => left - right);
  const p50 = rank(sorted, 0.5);
  const p95 = rank(sorted, 0.95);
  const max = rank(sorted, 1);
  if (p50 === undefined || p95 === undefined || max === undefined) return undefined;
  return { count: values.length, p50: round(p50), p95: round(p95), max: round(max) };
}

/** Tokens per second, to one decimal place. */
function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

function toModelRow(model: ModelAccumulator): TurnDiagnosticsModelRow {
  const ttft = percentiles(model.ttft);
  const decode = percentiles(model.decodeRates, roundRate);
  const wall = percentiles(model.wall);
  return {
    providerInstanceId: model.providerInstanceId,
    modelId: model.modelId,
    turns: model.turns,
    diagnosedTurns: model.diagnosedTurns,
    stopReasons: model.stopReasons,
    contentFilterStops: model.contentFilterStops,
    toolCalls: model.toolCalls,
    toolFailures: model.toolFailures,
    retries: model.retries,
    rateLimitedTurns: model.rateLimitedTurns,
    ...(ttft === undefined ? {} : { timeToFirstTokenMs: ttft }),
    ...(decode === undefined ? {} : { decodeTokensPerSecond: decode }),
    ...(wall === undefined ? {} : { wallMs: wall }),
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
    ...(model.cache === undefined ? {} : { cache: { ...model.cache } }),
    likelyCacheMisses: model.likelyCacheMisses,
    ...(model.costUsd === undefined ? {} : { costUsd: model.costUsd }),
  };
}

function compareModel(left: ModelAccumulator, right: ModelAccumulator): number {
  return (
    String(left.providerInstanceId).localeCompare(String(right.providerInstanceId)) ||
    String(left.modelId).localeCompare(String(right.modelId))
  );
}

function newModel(record: TurnMetricsRecord): ModelAccumulator {
  return {
    providerInstanceId: record.providerInstanceId,
    modelId: record.modelId,
    turns: 0,
    diagnosedTurns: 0,
    stopReasons: emptyStopReasons(),
    contentFilterStops: 0,
    toolCalls: 0,
    toolFailures: 0,
    retries: 0,
    rateLimitedTurns: 0,
    ttft: [],
    decodeRates: [],
    wall: [],
    inputTokens: 0,
    outputTokens: 0,
    cache: undefined,
    likelyCacheMisses: 0,
    costUsd: undefined,
  };
}

function newTool(): ToolAccumulator {
  return { turns: 0, calls: 0, failed: 0, unfinished: 0, nonZeroExits: 0, totalMs: 0, maxMs: 0 };
}

function newBucket(): BucketAccumulator {
  return {
    turns: 0,
    failed: 0,
    cancelled: 0,
    toolCalls: 0,
    toolFailures: 0,
    retries: 0,
    ttft: [],
    decodeRates: [],
  };
}

function missKey(threadId: string, endedAt: string): string {
  return `${threadId}\u0000${endedAt}`;
}

/** A calendar date (`YYYY-MM-DD`) in the zone, or in UTC when the zone is unknown. */
function dayKeyFormatter(timeZone: string): (timestamp: string) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return (timestamp) => timestamp.slice(0, 10);
  }
  return (timestamp) => {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? format.format(parsed) : timestamp.slice(0, 10);
  };
}
