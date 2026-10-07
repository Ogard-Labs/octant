import type {
  NativeHarnessSessionView,
  SessionMetrics,
  TurnMetrics,
  TurnMetricsPrecision,
  TurnMetricsRecord,
  TurnMetricsSummary,
  TurnUsage,
  UsageCost,
} from "@octant/contracts";
import { estimateApiEquivalentCost, type PricingProvider } from "./localUsagePricing";
import {
  addTurnToSessionMetrics,
  addTurnUsage,
  cacheHitRate,
  tokensPerSecond,
} from "./turnMetricsPolicy";

/**
 * How a thread's token, cache, speed, and cost figures are worded, in one place
 * so the web composer, the usage page, the harness session card, the terminal
 * footer, and the phone cannot drift apart. Every rule that keeps a figure honest lives here:
 *
 * - A figure the provider did not report, or whose denominator is zero, is
 *   absent. Nothing is rendered as a zero it never measured.
 * - A cache hit is never rounded up to a whole: a partial hit gains decimals
 *   (99.5, then 99.95) until it stops reading as 100.
 * - A speed measured over a window that held tool time says so with a leading
 *   tilde. An unavailable speed is absent.
 * - A cost says "est." unless the provider reported it, and is absent when no
 *   price is known for the model.
 */

export type ThreadStatKey = "input" | "output" | "cache" | "speed" | "first-token" | "cost";

export interface ThreadStat {
  readonly key: ThreadStatKey;
  /** What the quiet line shows, e.g. `41 tok/s`. */
  readonly text: string;
  /** The same figure as a sentence, for assistive technology and the detail view. */
  readonly label: string;
  /** What the figure leaves out or how it was derived; shown as a tooltip. */
  readonly hint?: string;
}

/** The timing a speed and a first-token figure are drawn from. */
export interface SpeedFigures {
  readonly precision: TurnMetricsPrecision;
  readonly decodeOutputTokens?: number | undefined;
  readonly decodeMs?: number | undefined;
  /** Time to the first token; the mean over measured turns for a thread. */
  readonly firstTokenMs?: number | undefined;
  /** How many turns the figures cover; 1 for a single turn. */
  readonly turns: number;
}

export interface ThreadCost {
  readonly amountUsd: number;
  /** False only when every turn's cost was reported by its provider. */
  readonly estimated: boolean;
  /** Set when the figure covers only the most recent turns of a longer thread. */
  readonly latestTurns?: number;
}

export interface ThreadStatsInput {
  readonly usage?: TurnUsage | undefined;
  readonly speed?: SpeedFigures | undefined;
  readonly cost?: ThreadCost | undefined;
}

const APPROXIMATE_SPEED_HINT =
  "Approximate. Speed is measured per turn and includes some tool time.";

/** `48k`, `3.1k`, `1.2M`: three significant figures at most, never a rounded-up thousand. */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  const whole = Math.round(count);
  if (whole < 1_000) return String(whole);
  if (whole < 1_000_000) {
    const thousands = whole / 1_000;
    const text = thousands < 10 ? trimZero(thousands.toFixed(1)) : String(Math.round(thousands));
    if (Number(text) < 1_000) return `${text}k`;
  }
  const millions = whole / 1_000_000;
  return millions < 10 ? `${trimZero(millions.toFixed(1))}M` : `${String(Math.round(millions))}M`;
}

/** The whole count with thousands separators, for the detail view. */
export function formatExactCount(count: number): string {
  return String(Math.max(0, Math.round(count))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * A share of input served from the prompt cache. A whole percentage is used
 * until it would read as 100 for a hit that was not total; then one decimal,
 * then two. A tiny nonzero share reads `<1%` rather than 0.
 */
export function formatCacheHit(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < 0) return "0%";
  if (fraction >= 1) return "100%";
  const percent = fraction * 100;
  if (percent > 0 && percent < 0.5) return "<1%";
  for (const decimals of [0, 1, 2]) {
    const scale = 10 ** decimals;
    const rounded = Math.round(percent * scale) / scale;
    if (rounded < 100) return `${rounded.toFixed(decimals)}%`;
  }
  return ">99.99%";
}

/** Whole numbers from 10 up, one decimal below, with a tilde when approximate. */
export function formatTokensPerSecond(rate: number, precision: TurnMetricsPrecision): string {
  const tenths = Math.round(rate * 10) / 10;
  const text = tenths >= 10 ? String(Math.round(rate)) : tenths.toFixed(1);
  return `${precision === "approximate" ? "~" : ""}${text} tok/s`;
}

/** `0.9 s`, `41 s`, `2 m 05 s`; a span too short to read as a tenth says so. */
export function formatSeconds(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  const tenths = Math.round(ms / 100);
  if (tenths === 0) return "<0.1 s";
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${String(seconds)} s`;
  return `${String(Math.floor(seconds / 60))} m ${String(seconds % 60).padStart(2, "0")} s`;
}

/** Whole cents, with a floor for anything cheaper. */
export function formatCostUsd(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.005) return "<$0.01";
  return `$${amountUsd.toFixed(2)}`;
}

export function speedFiguresOfTurn(metrics: TurnMetrics | undefined): SpeedFigures | undefined {
  if (metrics === undefined) return undefined;
  return {
    precision: metrics.precision,
    decodeOutputTokens: metrics.decodeOutputTokens,
    decodeMs: metrics.decodeMs,
    firstTokenMs: metrics.timeToFirstTokenMs,
    turns: 1,
  };
}

export function speedFiguresOfSession(
  metrics: SessionMetrics | undefined,
): SpeedFigures | undefined {
  if (metrics === undefined || metrics.measuredTurns === 0) return undefined;
  return {
    precision: metrics.precision,
    decodeOutputTokens: metrics.decodeOutputTokens,
    decodeMs: metrics.decodeMs,
    firstTokenMs: Math.round(metrics.timeToFirstTokenTotalMs / metrics.measuredTurns),
    turns: metrics.measuredTurns,
  };
}

/**
 * What a model's tokens would cost at standard API rates. The price table is
 * keyed by model id, and the two vendors' ids do not overlap, so the id picks
 * the table. A provider that reports no cache figure is priced with none used,
 * which can only overstate; the result is always an estimate. Absent when the
 * model has no price or the counts are not coherent.
 */
export function estimateTurnCostUsd(modelId: string, usage: TurnUsage): number | undefined {
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheWriteInputTokens ?? 0;
  const uncached = usage.inputTokens - read - write;
  if (uncached < 0) return undefined;
  const providers: ReadonlyArray<PricingProvider> = ["openai", "anthropic"];
  for (const provider of providers) {
    const result = estimateApiEquivalentCost(provider, {
      modelId,
      inputTokens: usage.inputTokens,
      uncachedInputTokens: uncached,
      cacheReadInputTokens: read,
      cacheWriteInputTokens: write,
      outputTokens: usage.outputTokens,
      ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    });
    if (result.kind === "api-estimate") return result.amount;
  }
  return undefined;
}

/** The cost of one turn: the provider's own figure wins over an estimate. */
export function turnCost(
  modelId: string,
  usage: TurnUsage | undefined,
): { readonly amountUsd: number; readonly estimated: boolean } | undefined {
  if (usage === undefined) return undefined;
  if (usage.costUsd !== undefined) return { amountUsd: usage.costUsd, estimated: false };
  const amountUsd = estimateTurnCostUsd(modelId, usage);
  return amountUsd === undefined ? undefined : { amountUsd, estimated: true };
}

/**
 * What a request costs in the usage ledger, in whole micro-dollars. The same
 * rule as `turnCost`, so the ledger, the composer line, and a money ceiling
 * price a turn alike: the provider's own figure is `provider-recorded`, a
 * standard-rate figure for a priced model is `api-estimate`, and anything else
 * is absent. Absent is unpriced, never free: a money ceiling refuses on it.
 */
export function ledgerUsageCost(modelId: string, usage: TurnUsage): UsageCost | undefined {
  const cost = turnCost(modelId, usage);
  if (cost === undefined) return undefined;
  const usdMicros = Math.round(cost.amountUsd * 1_000_000);
  if (!Number.isSafeInteger(usdMicros) || usdMicros < 0) return undefined;
  return { kind: cost.estimated ? "api-estimate" : "provider-recorded", usdMicros };
}

/**
 * The cost over several turns, each priced on its own model. A turn that
 * reported no usage adds nothing; a turn that reported usage the model has no
 * price for makes the whole figure absent, because a sum with a hole in it
 * would read as a total.
 */
export function costOfTurns(
  turns: ReadonlyArray<{ readonly modelId: string; readonly usage?: TurnUsage | undefined }>,
  coveredAllTurns: boolean,
): ThreadCost | undefined {
  let amountUsd = 0;
  let estimated = false;
  let priced = 0;
  for (const turn of turns) {
    if (turn.usage === undefined) continue;
    const cost = turnCost(turn.modelId, turn.usage);
    if (cost === undefined) return undefined;
    amountUsd += cost.amountUsd;
    estimated ||= cost.estimated;
    priced += 1;
  }
  if (priced === 0 || amountUsd <= 0) return undefined;
  return {
    amountUsd,
    estimated,
    ...(coveredAllTurns ? {} : { latestTurns: turns.length }),
  };
}

/** The figures of a thread read from the host's turn summary. */
export function threadStatsInputOf(summary: TurnMetricsSummary | undefined): ThreadStatsInput {
  if (summary === undefined) return {};
  const cost = costOfTurns(
    summary.turns.map((turn) => ({ modelId: String(turn.modelId), usage: turn.usage })),
    summary.turnCount <= summary.turns.length,
  );
  return {
    usage: summary.usage,
    speed: speedFiguresOfSession(summary.metrics),
    cost,
  };
}

/**
 * The figures of an Octant Harness session. The session keeps totals past the
 * bounded turn list, so tokens and speed come from it; a host that predates
 * the totals falls back to what the list still holds. Each turn is priced on
 * the model its route chose, and a provider-reported session cost covers turns
 * the list has already scrolled out.
 */
export function sessionStatsInputOf(
  view: Pick<NativeHarnessSessionView, "session" | "turns">,
): ThreadStatsInput {
  const { session, turns } = view;
  const usage =
    session.usage ??
    (turns.length === 0
      ? undefined
      : turns.map((turn) => turn.usage).reduce<TurnUsage | undefined>(addTurnUsage, undefined));
  const complete = turns.length >= session.turnsRun;
  const priced = costOfTurns(
    turns.map((turn) => ({
      modelId: String(
        "candidate" in turn.route ? turn.route.candidate.modelId : session.lead.modelId,
      ),
      usage: turn.usage,
    })),
    complete,
  );
  const cost =
    !complete && session.usage?.costUsd !== undefined && session.usage.costUsd > 0
      ? { amountUsd: session.usage.costUsd, estimated: false }
      : priced;
  return { usage, speed: speedFiguresOfSession(session.metrics), cost };
}

/**
 * The figures that can be stated, in the order the quiet line shows them.
 * An empty list means there is nothing honest to say, and a surface shows no
 * line at all.
 */
export function threadStats(input: ThreadStatsInput): ReadonlyArray<ThreadStat> {
  const stats: ThreadStat[] = [];
  const { usage, speed, cost } = input;
  if (usage !== undefined && usage.inputTokens > 0) {
    stats.push({
      key: "input",
      text: `↑ ${formatTokenCount(usage.inputTokens)} in`,
      label: `${formatExactCount(usage.inputTokens)} input tokens`,
    });
  }
  if (usage !== undefined && usage.outputTokens > 0) {
    stats.push({
      key: "output",
      text: `↓ ${formatTokenCount(usage.outputTokens)} out`,
      label: `${formatExactCount(usage.outputTokens)} output tokens`,
    });
  }
  const hit = cacheHitRate(usage);
  if (hit !== undefined) {
    const share = formatCacheHit(hit);
    stats.push({
      key: "cache",
      text: `cache ${share}`,
      label: `${share} of input served from the prompt cache`,
    });
  }
  const rate =
    speed === undefined || speed.precision === "unavailable" ? undefined : tokensPerSecond(speed);
  if (speed !== undefined && rate !== undefined) {
    const text = formatTokensPerSecond(rate, speed.precision);
    stats.push({
      key: "speed",
      text,
      label: `${text.replace("~", "about ")} output speed`,
      ...(speed.precision === "approximate" ? { hint: APPROXIMATE_SPEED_HINT } : {}),
    });
  }
  if (
    speed !== undefined &&
    speed.precision !== "unavailable" &&
    speed.firstTokenMs !== undefined
  ) {
    const text = `${formatSeconds(speed.firstTokenMs)} first token`;
    stats.push({
      key: "first-token",
      text,
      label: speed.turns > 1 ? `${text} on average` : text,
      ...(speed.turns > 1 ? { hint: `Average over ${String(speed.turns)} turns.` } : {}),
    });
  }
  if (cost !== undefined && cost.amountUsd > 0) {
    const text = `${formatCostUsd(cost.amountUsd)}${cost.estimated ? " est." : ""}`;
    const basis = cost.estimated
      ? "Estimated at standard API rates for the model; a plan may bill differently."
      : "Reported by the provider.";
    stats.push({
      key: "cost",
      text,
      label: cost.estimated ? `${text.replace(" est.", "")} estimated cost` : `${text} cost`,
      hint:
        cost.latestTurns === undefined
          ? basis
          : `${basis} Covers the latest ${String(cost.latestTurns)} turns only.`,
    });
  }
  return stats;
}

/** The quiet line as plain text, for the terminal footer. */
export function threadStatsLine(input: ThreadStatsInput): string {
  return threadStats(input)
    .map((stat) => stat.text)
    .join(" · ");
}

/** The figure columns a thread table can show, in the order the quiet line uses. */
export const USAGE_THREAD_FIGURE_KEYS = [
  "input",
  "output",
  "cache",
  "speed",
  "first-token",
  "cost",
] as const satisfies ReadonlyArray<ThreadStatKey>;

export type UsageThreadFigureKey = (typeof USAGE_THREAD_FIGURE_KEYS)[number];

export interface UsageThreadRow {
  readonly threadId: string;
  readonly mode: TurnMetricsRecord["mode"];
  /** Newest last, the same order a turn drill-in steps through. */
  readonly turns: ReadonlyArray<TurnMetricsRecord>;
  /** The figures the composer line states for this thread. */
  readonly stats: ReadonlyArray<ThreadStat>;
}

export interface UsageThreadReading {
  readonly rows: ReadonlyArray<UsageThreadRow>;
  /**
   * The host listed only the latest turns, and they are not one thread's
   * reading, so a row covers the turns still listed rather than that thread's
   * full total. A reading of one thread uses that thread's totals, which is
   * what the composer shows.
   */
  readonly listedTurnsOnly: boolean;
}

export interface UsageThreadReadingOptions {
  /**
   * The query named one thread, so the summary totals belong to it even when
   * the listed turns are only the latest tail.
   */
  readonly scopedToThread?: boolean;
}

/**
 * Per-thread rows for a usage reading, worded by the same rules as the
 * composer line. A figure the provider did not report is absent. When the
 * reading is one thread — every matching turn is listed, or the query named
 * that thread — the row uses the reading's totals, so it matches the composer.
 * A reading that mixes threads is split by the turns still listed, and does
 * not borrow the mixed total once older turns have scrolled off.
 */
export function usageThreadReading(
  summary: TurnMetricsSummary | undefined,
  options: UsageThreadReadingOptions = {},
): UsageThreadReading {
  if (summary === undefined || summary.turns.length === 0) {
    return { rows: [], listedTurnsOnly: false };
  }
  const byThread = new Map<string, TurnMetricsRecord[]>();
  for (const turn of summary.turns) {
    const existing = byThread.get(turn.threadId);
    if (existing === undefined) byThread.set(turn.threadId, [turn]);
    else existing.push(turn);
  }
  const truncated = summary.turnCount > summary.turns.length;
  const oneThread = byThread.size === 1;
  const useSummaryTotals = oneThread && (!truncated || options.scopedToThread === true);
  const rows: UsageThreadRow[] = [];
  for (const [threadId, turns] of byThread) {
    const latest = turns[turns.length - 1];
    if (latest === undefined) continue;
    const stats = threadStats(
      useSummaryTotals ? threadStatsInputOf(summary) : inputOfListedTurns(turns, !truncated),
    );
    rows.push({ threadId, mode: latest.mode, turns, stats });
  }
  rows.sort((left, right) => {
    const leftEnded = left.turns[left.turns.length - 1]?.endedAt ?? "";
    const rightEnded = right.turns[right.turns.length - 1]?.endedAt ?? "";
    return rightEnded.localeCompare(leftEnded);
  });
  return { rows, listedTurnsOnly: !useSummaryTotals && truncated };
}

/** Columns that have a figure on at least one row. The rest stay hidden. */
export function usageThreadColumns(
  rows: ReadonlyArray<UsageThreadRow>,
): ReadonlyArray<UsageThreadFigureKey> {
  const present = new Set(rows.flatMap((row) => row.stats.map((stat) => stat.key)));
  return USAGE_THREAD_FIGURE_KEYS.filter((key) => present.has(key));
}

function inputOfListedTurns(
  turns: ReadonlyArray<TurnMetricsRecord>,
  coveredAllTurns: boolean,
): ThreadStatsInput {
  const first = turns[0];
  if (first === undefined) return {};
  let usage = first.usage;
  let metrics = addTurnToSessionMetrics(undefined, first.metrics);
  for (const turn of turns.slice(1)) {
    if (turn.usage !== undefined) usage = addTurnUsage(usage, turn.usage);
    metrics = addTurnToSessionMetrics(metrics, turn.metrics);
  }
  return threadStatsInputOf({
    turns: [...turns],
    turnCount: coveredAllTurns ? turns.length : turns.length + 1,
    ...(usage === undefined ? {} : { usage }),
    metrics,
  });
}

export interface TurnDetailRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

export interface TurnDetail {
  readonly tokens: ReadonlyArray<TurnDetailRow>;
  readonly timing: ReadonlyArray<TurnDetailRow>;
  readonly cost: TurnDetailRow | undefined;
  /** What this turn cannot say, in words. */
  readonly notes: ReadonlyArray<string>;
}

const ENDED_LABEL: Readonly<Record<TurnMetricsRecord["stopReason"], string>> = {
  "end-of-turn": "Finished",
  "max-tokens": "Cut off at the output limit",
  cancelled: "Stopped",
  failed: "Failed",
  waiting: "Waiting",
};

/** One turn as labelled rows: tokens, timing, and cost, each only when known. */
export function turnDetail(record: TurnMetricsRecord): TurnDetail {
  const { usage, metrics } = record;
  const notes: string[] = [];
  const tokens: TurnDetailRow[] = [];
  if (usage === undefined) {
    notes.push("The provider reported no token usage for this turn.");
  } else {
    tokens.push({ key: "input", label: "Input", value: formatExactCount(usage.inputTokens) });
    if (usage.cacheReadInputTokens !== undefined) {
      tokens.push({
        key: "cache-read",
        label: "Cache read",
        value: formatExactCount(usage.cacheReadInputTokens),
      });
    }
    if (usage.cacheWriteInputTokens !== undefined) {
      tokens.push({
        key: "cache-write",
        label: "Cache write",
        value: formatExactCount(usage.cacheWriteInputTokens),
      });
    }
    tokens.push({ key: "output", label: "Output", value: formatExactCount(usage.outputTokens) });
    if (usage.reasoningTokens !== undefined) {
      tokens.push({
        key: "reasoning",
        label: "Reasoning",
        value: formatExactCount(usage.reasoningTokens),
        hint: "Part of the output tokens.",
      });
    }
    const hit = cacheHitRate(usage);
    if (hit !== undefined) {
      tokens.push({ key: "cache-hit", label: "Cache hit", value: formatCacheHit(hit) });
    }
  }
  const timing: TurnDetailRow[] = [];
  const speed = speedFiguresOfTurn(metrics);
  const rate =
    speed === undefined || speed.precision === "unavailable" ? undefined : tokensPerSecond(speed);
  if (metrics.precision === "unavailable") {
    notes.push("Speed was not measured: nothing was streamed to time the output against.");
  } else {
    if (metrics.timeToFirstTokenMs !== undefined) {
      timing.push({
        key: "first-token",
        label: "First token",
        value: formatSeconds(metrics.timeToFirstTokenMs),
      });
    }
    if (rate !== undefined) {
      timing.push({
        key: "speed",
        label: "Speed",
        value: formatTokensPerSecond(rate, metrics.precision),
        ...(metrics.precision === "approximate" ? { hint: APPROXIMATE_SPEED_HINT } : {}),
      });
    }
    if (metrics.timeToFirstTokenMs !== undefined && metrics.decodeMs !== undefined) {
      timing.push({
        key: "model-time",
        label: "Model time",
        value: formatSeconds(metrics.timeToFirstTokenMs + metrics.decodeMs),
        hint: "Waiting for the first token plus generating, with tool time left out.",
      });
    }
    if (metrics.toolMs !== undefined && metrics.toolMs > 0) {
      timing.push({ key: "tool-time", label: "Tool time", value: formatSeconds(metrics.toolMs) });
    }
    if (metrics.modelCalls !== undefined && metrics.modelCalls > 1) {
      timing.push({
        key: "model-calls",
        label: "Model requests",
        value: String(metrics.modelCalls),
      });
    }
  }
  timing.push({ key: "total-time", label: "Total time", value: formatSeconds(metrics.wallMs) });
  if (metrics.retries !== undefined) {
    timing.push({
      key: "retries",
      label: "Retries",
      value: String(metrics.retries),
      hint: "Times the endpoint failed in a way that usually passes and was asked again.",
    });
  }
  timing.push({ key: "ended", label: "Ended", value: ENDED_LABEL[record.stopReason] });
  const spent = turnCost(String(record.modelId), usage);
  const cost: TurnDetailRow | undefined =
    spent === undefined || spent.amountUsd <= 0
      ? undefined
      : {
          key: "cost",
          label: "This turn",
          value: `${formatCostUsd(spent.amountUsd)}${spent.estimated ? " est." : ""}`,
          hint: spent.estimated
            ? "Estimated at standard API rates for the model; a plan may bill differently."
            : "Reported by the provider.",
        };
  return { tokens, timing, cost, notes };
}
