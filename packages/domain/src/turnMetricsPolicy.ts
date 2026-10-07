import type {
  ProviderRuntimeEvent,
  SessionMetrics,
  TurnMetrics,
  TurnUsage,
} from "@octant/contracts";

/**
 * How fast a turn ran, derived once from the normalized runtime events every
 * provider produces, so no driver measures anything itself.
 *
 * A turn is timed from the moment its prompt was sent. The first text or
 * reasoning delta ends the wait for a first token, and decode speed is the
 * output tokens over the time from that delta to completion with tool time
 * taken out. What the figure can promise depends on what the provider
 * reported:
 *
 * - A usage report that names the request it covers (`requestStartedAt`)
 *   times that one model request. The time between requests is tool time by
 *   construction, so the figure is exact.
 * - A usage report for the whole turn can only be timed as a whole. A turn that
 *   ran no tool and made no wait is still one request, so it is exact. A turn
 *   with tool calls or waits is approximate: the spans the provider streamed
 *   are taken out of the window, and any it did not stream stay in.
 * - No output tokens, or nothing streamed to time them against, leaves the
 *   figure unavailable.
 */

export interface TurnMetricsState {
  readonly startedAtMs: number;
  /** The first text or reasoning delta of the turn. */
  readonly firstDeltaMs: number | undefined;
  readonly lastDeltaMs: number | undefined;
  /** The first delta since the last request-scoped report closed a request. */
  readonly requestFirstDeltaMs: number | undefined;
  /** Where the answering attempt of the current request began, after a retry's wait. */
  readonly retryResumeMs: number | undefined;
  readonly retries: number;
  readonly calls: ReadonlyArray<ModelCall>;
  /** What the request-scoped reports added up to. */
  readonly requestUsage: TurnUsage | undefined;
  /** The latest report that covered the whole turn; a later one replaces it. */
  readonly turnUsage: TurnUsage | undefined;
  readonly lastUsageMs: number | undefined;
  readonly openTools: Readonly<Record<string, number>>;
  readonly spans: ReadonlyArray<Span>;
  /** Where an unanswered tool request or approval began waiting. */
  readonly waitingSinceMs: number | undefined;
  /** Whether any tool call or wait happened inside the turn. */
  readonly sawToolTime: boolean;
}

interface ModelCall {
  readonly startMs: number;
  readonly firstDeltaMs: number | undefined;
  readonly endMs: number;
  readonly outputTokens: number;
}

type Span = readonly [startMs: number, endMs: number];

export interface TurnMetricsOutcome {
  readonly metrics: TurnMetrics;
  /** Absent when the provider reported no usage, which is not the same as zero. */
  readonly usage: TurnUsage | undefined;
}

export function startTurnMetrics(startedAt: string): TurnMetricsState {
  return {
    startedAtMs: Date.parse(startedAt),
    firstDeltaMs: undefined,
    lastDeltaMs: undefined,
    requestFirstDeltaMs: undefined,
    retryResumeMs: undefined,
    retries: 0,
    calls: [],
    requestUsage: undefined,
    turnUsage: undefined,
    lastUsageMs: undefined,
    openTools: {},
    spans: [],
    waitingSinceMs: undefined,
    sawToolTime: false,
  };
}

/** Events that end the wait a tool request or an approval opened. */
const RESUMING_KINDS: ReadonlySet<ProviderRuntimeEvent["kind"]> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-start",
  "usage",
  "completed",
  "failed",
  "interrupted",
]);

export function observeTurnMetrics(
  state: TurnMetricsState,
  event: ProviderRuntimeEvent,
): TurnMetricsState {
  const at = Date.parse(event.occurredAt);
  if (!Number.isFinite(at)) return state;
  const resumed =
    state.waitingSinceMs !== undefined && RESUMING_KINDS.has(event.kind)
      ? {
          ...state,
          spans: [...state.spans, [state.waitingSinceMs, at] as const],
          waitingSinceMs: undefined,
        }
      : state;
  switch (event.kind) {
    case "text-delta":
    case "reasoning-delta":
      return {
        ...resumed,
        firstDeltaMs: resumed.firstDeltaMs ?? at,
        lastDeltaMs: at,
        requestFirstDeltaMs: resumed.requestFirstDeltaMs ?? at,
      };
    case "tool-start":
      return {
        ...resumed,
        openTools: { ...resumed.openTools, [event.toolCallId]: at },
        sawToolTime: true,
      };
    case "tool-success":
    case "tool-failure": {
      const startedAt = resumed.openTools[event.toolCallId];
      if (startedAt === undefined) return { ...resumed, sawToolTime: true };
      const { [event.toolCallId]: _closed, ...stillOpen } = resumed.openTools;
      return {
        ...resumed,
        openTools: stillOpen,
        spans: [...resumed.spans, [startedAt, at] as const],
        sawToolTime: true,
      };
    }
    case "tool-request":
    case "approval-request":
    case "user-input-request":
      return {
        ...resumed,
        waitingSinceMs: resumed.waitingSinceMs ?? at,
        sawToolTime: true,
      };
    case "retrying":
      return { ...resumed, retries: resumed.retries + 1, retryResumeMs: at + event.delayMs };
    case "usage":
      return observeUsage(resumed, event, at);
    default:
      return resumed;
  }
}

function observeUsage(
  state: TurnMetricsState,
  event: Extract<ProviderRuntimeEvent, { kind: "usage" }>,
  at: number,
): TurnMetricsState {
  const usage = usageOf(event);
  if (event.requestStartedAt === undefined) {
    return { ...state, turnUsage: usage, lastUsageMs: at };
  }
  const sentAt = Date.parse(event.requestStartedAt);
  if (!Number.isFinite(sentAt)) return { ...state, turnUsage: usage, lastUsageMs: at };
  const startMs =
    state.retryResumeMs !== undefined ? Math.max(sentAt, state.retryResumeMs) : sentAt;
  const firstDeltaMs =
    state.requestFirstDeltaMs !== undefined && state.requestFirstDeltaMs >= startMs
      ? state.requestFirstDeltaMs
      : undefined;
  return {
    ...state,
    calls: [...state.calls, { startMs, firstDeltaMs, endMs: at, outputTokens: usage.outputTokens }],
    requestUsage: addTurnUsage(state.requestUsage, usage),
    requestFirstDeltaMs: undefined,
    retryResumeMs: undefined,
    lastUsageMs: at,
  };
}

function usageOf(event: Extract<ProviderRuntimeEvent, { kind: "usage" }>): TurnUsage {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens }),
    ...(event.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: event.cacheReadInputTokens }),
    ...(event.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: event.cacheWriteInputTokens }),
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
  };
}

export function finishTurnMetrics(state: TurnMetricsState, endedAt: string): TurnMetricsOutcome {
  const endedAtMs = Math.max(state.startedAtMs, Date.parse(endedAt));
  const wallMs = Math.max(0, Math.round(endedAtMs - state.startedAtMs));
  const usage = state.calls.length > 0 ? state.requestUsage : state.turnUsage;
  const retries = state.retries > 0 ? { retries: state.retries } : {};
  const unavailable = { precision: "unavailable", wallMs, ...retries } as const;
  const measured =
    state.calls.length > 0
      ? measureRequests(state, wallMs, retries)
      : measureTurn(state, endedAtMs, wallMs, usage, retries);
  return { metrics: measured ?? unavailable, usage };
}

/** Each request timed on its own; the time between requests is tool time. */
function measureRequests(
  state: TurnMetricsState,
  wallMs: number,
  retries: { readonly retries?: number },
): TurnMetrics | undefined {
  const timed = state.calls.filter(
    (call) =>
      call.firstDeltaMs !== undefined && call.outputTokens > 0 && call.endMs > call.firstDeltaMs,
  );
  const first = timed[0];
  if (first?.firstDeltaMs === undefined) return undefined;
  let decodeMs = 0;
  let decodeOutputTokens = 0;
  for (const call of timed) {
    decodeMs += call.endMs - (call.firstDeltaMs ?? call.endMs);
    decodeOutputTokens += call.outputTokens;
  }
  let toolMs = 0;
  state.calls.forEach((call, index) => {
    const before = state.calls[index - 1];
    if (before !== undefined) toolMs += Math.max(0, call.startMs - before.endMs);
  });
  return {
    precision: "exact",
    wallMs,
    timeToFirstTokenMs: Math.max(0, Math.round(first.firstDeltaMs - state.startedAtMs)),
    decodeOutputTokens,
    decodeMs: Math.round(decodeMs),
    toolMs: Math.round(toolMs),
    modelCalls: timed.length,
    ...retries,
  };
}

/** One report for the turn: the window is first delta to the last sign of output. */
function measureTurn(
  state: TurnMetricsState,
  endedAtMs: number,
  wallMs: number,
  usage: TurnUsage | undefined,
  retries: { readonly retries?: number },
): TurnMetrics | undefined {
  if (usage === undefined || usage.outputTokens <= 0) return undefined;
  const windowStart = state.firstDeltaMs;
  if (windowStart === undefined) return undefined;
  const windowEnd = Math.min(
    endedAtMs,
    Math.max(state.lastDeltaMs ?? windowStart, state.lastUsageMs ?? windowStart),
  );
  const still: Span[] = [
    ...state.spans,
    ...Object.values(state.openTools).map((start) => [start, windowEnd] as const),
    ...(state.waitingSinceMs === undefined ? [] : [[state.waitingSinceMs, windowEnd] as const]),
  ];
  const toolMs = mergedLength(still, windowStart, windowEnd);
  const decodeMs = windowEnd - windowStart - toolMs;
  if (decodeMs <= 0) return undefined;
  return {
    precision: state.sawToolTime ? "approximate" : "exact",
    wallMs,
    timeToFirstTokenMs: Math.max(0, Math.round(windowStart - state.startedAtMs)),
    decodeOutputTokens: usage.outputTokens,
    decodeMs: Math.round(decodeMs),
    toolMs: Math.round(toolMs),
    modelCalls: 1,
    ...retries,
  };
}

/** How much of the window the spans cover, counting overlapping calls once. */
function mergedLength(spans: ReadonlyArray<Span>, windowStart: number, windowEnd: number): number {
  const clipped = spans
    .map(([start, end]) => [Math.max(start, windowStart), Math.min(end, windowEnd)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let runEnd = -Infinity;
  for (const [start, end] of clipped) {
    if (start > runEnd) covered += end - start;
    else if (end > runEnd) covered += end - runEnd;
    runEnd = Math.max(runEnd, end);
  }
  return covered;
}

/** The whole derivation over a finished turn's events, in the order they arrived. */
export function deriveTurnMetrics(input: {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
}): TurnMetricsOutcome {
  return finishTurnMetrics(
    input.events.reduce(observeTurnMetrics, startTurnMetrics(input.startedAt)),
    input.endedAt,
  );
}

const PRECISION_RANK = { unavailable: 0, exact: 1, approximate: 2 } as const;

/**
 * Adds one turn to a session's timing. The sums commute, so a session rebuilt
 * from the journal in any batch order has the same totals as the live one.
 */
export function addTurnToSessionMetrics(
  total: SessionMetrics | undefined,
  turn: TurnMetrics,
): SessionMetrics {
  const base: SessionMetrics = total ?? {
    turns: 0,
    measuredTurns: 0,
    precision: "unavailable",
    decodeOutputTokens: 0,
    decodeMs: 0,
    toolMs: 0,
    timeToFirstTokenTotalMs: 0,
  };
  if (
    turn.precision === "unavailable" ||
    turn.decodeOutputTokens === undefined ||
    turn.decodeMs === undefined
  ) {
    return { ...base, turns: base.turns + 1 };
  }
  return {
    turns: base.turns + 1,
    measuredTurns: base.measuredTurns + 1,
    precision:
      PRECISION_RANK[turn.precision] > PRECISION_RANK[base.precision]
        ? turn.precision
        : base.precision,
    decodeOutputTokens: base.decodeOutputTokens + turn.decodeOutputTokens,
    decodeMs: base.decodeMs + turn.decodeMs,
    toolMs: base.toolMs + (turn.toolMs ?? 0),
    timeToFirstTokenTotalMs: base.timeToFirstTokenTotalMs + (turn.timeToFirstTokenMs ?? 0),
  };
}

/** Output tokens per second over decode time; hidden when nothing was timed. */
export function tokensPerSecond(
  metrics:
    | {
        readonly decodeOutputTokens?: number | undefined;
        readonly decodeMs?: number | undefined;
      }
    | undefined,
): number | undefined {
  if (metrics?.decodeOutputTokens === undefined || metrics.decodeMs === undefined) return undefined;
  if (metrics.decodeMs <= 0 || metrics.decodeOutputTokens <= 0) return undefined;
  return metrics.decodeOutputTokens / (metrics.decodeMs / 1000);
}

/**
 * Adds one turn's usage to a running total. A figure appears in the total once
 * some turn reported it and stays absent until then, so a provider that never
 * reports cache use never shows a cache total of zero.
 */
export function addTurnUsage(total: TurnUsage | undefined, turn: TurnUsage): TurnUsage {
  const sum = (left: number | undefined, right: number | undefined) =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const reasoning = sum(total?.reasoningTokens, turn.reasoningTokens);
  const cacheRead = sum(total?.cacheReadInputTokens, turn.cacheReadInputTokens);
  const cacheWrite = sum(total?.cacheWriteInputTokens, turn.cacheWriteInputTokens);
  const cost = sum(total?.costUsd, turn.costUsd);
  return {
    inputTokens: (total?.inputTokens ?? 0) + turn.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + turn.outputTokens,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

/**
 * A turn's usage so far, for the ledger and spend ceilings. A report that
 * names when its one request was sent covers that request only, so those add
 * up; a report without it covers the whole turn so far and replaces what came
 * before, the rule `finishTurnMetrics` applies. Keeping only the latest
 * report instead lost every request but the last of a turn that failed or was
 * cancelled before its whole total arrived. Cost is a total only when every
 * request in it reported one: a sum with a hole in it would read as the whole
 * charge.
 */
export function accumulateTurnUsage(
  total: TurnUsage | undefined,
  report: Extract<ProviderRuntimeEvent, { kind: "usage" }>,
): TurnUsage {
  const usage = usageOf(report);
  if (report.requestStartedAt === undefined || total === undefined) return usage;
  const summed = addTurnUsage(total, usage);
  if (total.costUsd !== undefined && usage.costUsd !== undefined) return summed;
  const { costUsd: _partial, ...withoutCost } = summed;
  return withoutCost;
}

/**
 * The share of all input that came from the prompt cache, as a fraction.
 * `inputTokens` already counts cache reads and writes, so it is the whole
 * denominator. Hidden when the provider reported no cache figure, when nothing
 * was sent, and when the read is larger than the input it should be part of,
 * which means the provider counted input another way. It is never rounded: a
 * partial hit stays below one.
 */
export function cacheHitRate(usage: TurnUsage | undefined): number | undefined {
  if (usage?.cacheReadInputTokens === undefined || usage.inputTokens <= 0) return undefined;
  if (usage.cacheReadInputTokens > usage.inputTokens) return undefined;
  return usage.cacheReadInputTokens / usage.inputTokens;
}
