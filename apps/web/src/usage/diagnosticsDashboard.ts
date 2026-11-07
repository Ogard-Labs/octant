import type { TurnDiagnosticsReport, TurnFailureFacts } from "@octant/contracts";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBarListBlock,
  type CanvasChartBlock,
  type CanvasMetricBlock,
} from "@octant/contracts/canvas";

/**
 * The Diagnostics dashboard as Canvas blocks, so it draws with the same
 * metric tiles, charts, and ranked bars as every other Octant visual: one
 * formatter, hover readings, and a disclosed table behind each chart. Built
 * from the host's report alone; a figure the host did not measure is left out
 * of a series rather than drawn as zero.
 */

const SPARKLINE_POINTS = 60;
const MAX_CHART_POINTS = 744;
const MAX_MODELS_CHARTED = 12;

const CATEGORY_WORDS: Readonly<Record<TurnFailureFacts["category"], string>> = {
  unavailable: "Provider unavailable",
  unauthenticated: "Not signed in",
  incompatible: "Incompatible runtime",
  unsupported: "Unsupported request",
  unauthorized: "Not authorized",
  interrupted: "Interrupted",
  "stale-resume": "Could not resume session",
  "invalid-configuration": "Invalid configuration",
  protocol: "Protocol error",
  "rate-limited": "Rate limited",
  "provider-failed": "Provider failed",
};

export interface DiagnosticsDashboard {
  readonly kpis: ReadonlyArray<CanvasMetricBlock>;
  readonly turnsOverTime: CanvasChartBlock | undefined;
  readonly troubledShareOverTime: CanvasChartBlock | undefined;
  readonly firstTokenOverTime: CanvasChartBlock | undefined;
  readonly speedOverTime: CanvasChartBlock | undefined;
  readonly firstTokenByModel: CanvasBarListBlock | undefined;
  readonly speedByModel: CanvasBarListBlock | undefined;
  readonly failureCauses: CanvasBarListBlock | undefined;
  readonly toolFailures: CanvasBarListBlock | undefined;
}

interface Figures {
  readonly turns: number;
  readonly successRate: number | undefined;
  readonly failed: number;
  readonly toolFailureRate: number | undefined;
  readonly firstTokenP50s: number | undefined;
  readonly speedP50: number | undefined;
  readonly turnP95s: number | undefined;
  readonly retries: number;
  readonly costUsd: number | undefined;
  readonly likelyCacheMisses: number;
}

function figures(report: TurnDiagnosticsReport): Figures {
  const { totals } = report;
  const finished = totals.stopReasons["end-of-turn"] + totals.stopReasons["max-tokens"];
  let cost: number | undefined;
  for (const model of report.models) {
    if (model.costUsd !== undefined) cost = (cost ?? 0) + model.costUsd;
  }
  return {
    turns: report.turns,
    successRate: report.turns === 0 ? undefined : finished / report.turns,
    failed: totals.stopReasons.failed,
    toolFailureRate: totals.toolCalls === 0 ? undefined : totals.toolFailures / totals.toolCalls,
    firstTokenP50s: seconds(totals.timeToFirstTokenMs?.p50),
    speedP50: totals.decodeTokensPerSecond?.p50,
    turnP95s: seconds(totals.wallMs?.p95),
    retries: totals.retries.reduce((sum, tally) => sum + tally.count, 0),
    costUsd: cost,
    likelyCacheMisses: totals.likelyCacheMisses,
  };
}

/**
 * `previous` is the same span immediately before, when there is one; each tile
 * then states its change, toned by whether up is good for that measure.
 */
export function diagnosticsDashboard(
  report: TurnDiagnosticsReport,
  previous: TurnDiagnosticsReport | undefined,
  previousLabel: string | undefined,
): DiagnosticsDashboard {
  const now = figures(report);
  const before = previous === undefined || previous.turns === 0 ? undefined : figures(previous);
  const trend = report.trend.slice(-SPARKLINE_POINTS);
  const caption = before === undefined ? undefined : previousLabel;

  const tile = (
    id: string,
    label: string,
    value: number | undefined,
    options: {
      readonly format?: CanvasMetricBlock["format"];
      readonly unit?: string;
      readonly good?: CanvasMetricBlock["goodDirection"];
      readonly prior?: number | undefined;
      readonly sparkline?: ReadonlyArray<number>;
    } = {},
  ): CanvasMetricBlock | undefined => {
    if (value === undefined) return undefined;
    const delta =
      options.prior === undefined ? undefined : round(value - options.prior, options.format);
    return metricBlock({
      blockId: `diagnostics-kpi-${id}`,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "metric",
      label,
      value: round(value, options.format),
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(options.unit === undefined ? {} : { unit: options.unit }),
      ...(delta === undefined ? {} : { delta }),
      ...(options.good === undefined ? {} : { goodDirection: options.good }),
      ...(options.sparkline === undefined || options.sparkline.length < 2
        ? {}
        : { sparkline: options.sparkline }),
      ...(caption === undefined || delta === undefined ? {} : { caption }),
    });
  };

  const kpis = [
    tile("turns", "Turns", now.turns, {
      format: "number",
      good: "neutral",
      prior: before?.turns,
      sparkline: trend.map((bucket) => bucket.turns),
    }),
    tile("success", "Finished", now.successRate, {
      format: "percent",
      good: "up",
      prior: before?.successRate,
      sparkline: trend.map((bucket) => 1 - (bucket.failed + bucket.cancelled) / bucket.turns),
    }),
    tile("failed", "Failed turns", now.failed, {
      format: "number",
      good: "down",
      prior: before?.failed,
      sparkline: trend.map((bucket) => bucket.failed),
    }),
    tile("tool-failures", "Tool failure rate", now.toolFailureRate, {
      format: "percent",
      good: "down",
      prior: before?.toolFailureRate,
      sparkline: trend.flatMap((bucket) =>
        bucket.toolCalls === 0 ? [] : [bucket.toolFailures / bucket.toolCalls],
      ),
    }),
    tile("first-token", "First token, typical", now.firstTokenP50s, {
      format: "number",
      unit: "s",
      good: "down",
      prior: before?.firstTokenP50s,
      sparkline: trend.flatMap((bucket) =>
        bucket.timeToFirstTokenP50Ms === undefined ? [] : [bucket.timeToFirstTokenP50Ms / 1_000],
      ),
    }),
    tile("speed", "Speed, typical", now.speedP50, {
      format: "number",
      unit: "tok/s",
      good: "up",
      prior: before?.speedP50,
      sparkline: trend.flatMap((bucket) =>
        bucket.decodeTokensPerSecondP50 === undefined ? [] : [bucket.decodeTokensPerSecondP50],
      ),
    }),
    tile("turn-p95", "Turn length, slow (p95)", now.turnP95s, {
      format: "duration",
      good: "down",
      prior: before?.turnP95s,
    }),
    tile("retries", "Retries", now.retries, {
      format: "number",
      good: "down",
      prior: before?.retries,
      sparkline: trend.map((bucket) => bucket.retries),
    }),
    tile("cost", "Provider-reported cost", now.costUsd, {
      format: "number",
      unit: "USD",
      good: "down",
      prior: before?.costUsd,
    }),
    tile("cache-misses", "Likely cache misses", now.likelyCacheMisses, {
      format: "number",
      good: "down",
      prior: before?.likelyCacheMisses,
    }),
  ].flatMap((block) => (block === undefined ? [] : [block]));

  const buckets = report.trend.slice(-MAX_CHART_POINTS);
  const span = report.bucket === "hour" ? "hour (UTC)" : "day";
  // A short axis label: "11-07", or "11-07 14h" for an hour, so ticks are not cut.
  const tick = (key: string) =>
    key.length > 10 ? `${key.slice(5, 10)} ${key.slice(11, 13)}h` : key.slice(5);
  const turnsOverTime =
    buckets.length === 0
      ? undefined
      : chart("turns-over-time", "stacked-bar", `How turns ended, by ${span}`, undefined, [
          series(
            "finished",
            "Finished",
            buckets.map((bucket) => ({
              x: tick(bucket.key),
              y: bucket.turns - bucket.failed - bucket.cancelled,
            })),
          ),
          // Third in the series order takes the alarm hue, so failures read red.
          series(
            "stopped",
            "Stopped",
            buckets.map((bucket) => ({ x: tick(bucket.key), y: bucket.cancelled })),
          ),
          series(
            "failed",
            "Failed",
            buckets.map((bucket) => ({ x: tick(bucket.key), y: bucket.failed })),
          ),
        ]);
  const troubledShareOverTime =
    buckets.length === 0
      ? undefined
      : chart(
          "troubled-share",
          "bar",
          `Share of turns that failed or stopped (%), by ${span}`,
          "number",
          [
            series(
              "troubled-share",
              "Failed or stopped",
              buckets.map((bucket) => ({
                x: tick(bucket.key),
                y: round(((bucket.failed + bucket.cancelled) / bucket.turns) * 100, "number"),
              })),
            ),
          ],
        );

  const ttftPoints = buckets.flatMap((bucket) =>
    bucket.timeToFirstTokenP50Ms === undefined
      ? []
      : [{ x: tick(bucket.key), y: round(bucket.timeToFirstTokenP50Ms / 1_000, "duration") }],
  );
  const speedPoints = buckets.flatMap((bucket) =>
    bucket.decodeTokensPerSecondP50 === undefined
      ? []
      : [{ x: tick(bucket.key), y: bucket.decodeTokensPerSecondP50 }],
  );

  const models = [...report.models]
    .sort((left, right) => right.turns - left.turns)
    .slice(0, MAX_MODELS_CHARTED);
  const ttftModels = models.flatMap((row) =>
    row.timeToFirstTokenMs === undefined
      ? []
      : [
          {
            label: String(row.modelId),
            p50: row.timeToFirstTokenMs.p50,
            p95: row.timeToFirstTokenMs.p95,
          },
        ],
  );
  const speedModels = models.flatMap((row) =>
    row.decodeTokensPerSecond === undefined
      ? []
      : [
          {
            label: String(row.modelId),
            p50: row.decodeTokensPerSecond.p50,
            p95: row.decodeTokensPerSecond.p95,
          },
        ],
  );

  const failureRows = report.failureGroups.map((group) => ({
    label: `${CATEGORY_WORDS[group.category]}${group.processKind === undefined ? "" : ` · ${group.processKind}`}`,
    value: group.count,
  }));
  const toolRows = report.tools
    .filter((tool) => tool.failed > 0)
    .map((tool) => ({ label: tool.toolName, value: tool.failed, secondaryValue: tool.calls }));

  return {
    kpis,
    turnsOverTime,
    troubledShareOverTime,
    firstTokenOverTime:
      ttftPoints.length === 0
        ? undefined
        : chart("first-token-over-time", "line", `Typical first token, by ${span}`, "duration", [
            series("first-token", "First token (p50)", ttftPoints),
          ]),
    speedOverTime:
      speedPoints.length === 0
        ? undefined
        : chart(
            "speed-over-time",
            "line",
            `Typical speed in tokens per second, by ${span}`,
            "number",
            [series("speed", "Speed (p50)", speedPoints)],
          ),
    // Ranked bars keep a model's full name, which a grouped chart's axis cuts.
    firstTokenByModel:
      ttftModels.length === 0
        ? undefined
        : barList(
            "first-token-by-model",
            ttftModels.map((row) => ({
              label: row.label,
              value: round(row.p50 / 1_000, "duration"),
              secondaryValue: round(row.p95 / 1_000, "duration"),
            })),
            "Typical (p50), seconds",
            "Slow (p95), seconds",
            "neutral",
          ),
    speedByModel:
      speedModels.length === 0
        ? undefined
        : barList(
            "speed-by-model",
            speedModels.map((row) => ({
              label: row.label,
              value: row.p50,
              secondaryValue: row.p95,
            })),
            "Typical (p50), tokens per second",
            "Fast (p95), tokens per second",
            "neutral",
          ),
    failureCauses:
      failureRows.length === 0 ? undefined : barList("failure-causes", failureRows, "Failed turns"),
    toolFailures:
      toolRows.length === 0
        ? undefined
        : barList("tool-failures", toolRows, "Failed calls", "Calls"),
  };
}

interface SeriesInput {
  readonly seriesId: string;
  readonly label: string;
  readonly points: ReadonlyArray<{ readonly x: string; readonly y: number }>;
}

function chart(
  id: string,
  chartType: CanvasChartBlock["chartType"],
  title: string,
  format: CanvasChartBlock["format"],
  chartSeries: ReadonlyArray<SeriesInput | undefined>,
): CanvasChartBlock | undefined {
  const present = chartSeries.flatMap((entry) => (entry === undefined ? [] : [entry]));
  if (present.length === 0) return undefined;
  const block = decoded({
    blockId: `diagnostics-${id}`,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType,
    title,
    series: present,
    ...(format === undefined ? {} : { format }),
  });
  return block?.kind === "chart" ? block : undefined;
}

function series(
  seriesId: string,
  label: string,
  points: ReadonlyArray<{ readonly x: string; readonly y: number }>,
): SeriesInput | undefined {
  return points.length === 0 ? undefined : { seriesId, label, points };
}

function barList(
  id: string,
  rows: ReadonlyArray<{
    readonly label: string;
    readonly value: number;
    readonly secondaryValue?: number;
  }>,
  valueLabel: string,
  secondaryLabel?: string,
  scale: CanvasBarListBlock["scale"] = "sequential",
): CanvasBarListBlock | undefined {
  if (rows.length === 0) return undefined;
  const block = decoded({
    blockId: `diagnostics-${id}`,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "bar-list",
    rows,
    valueLabel,
    ...(secondaryLabel === undefined ? {} : { secondaryLabel }),
    format: "number",
    scale,
  });
  return block?.kind === "bar-list" ? block : undefined;
}

function metricBlock(raw: Readonly<Record<string, unknown>>): CanvasMetricBlock | undefined {
  const block = decoded(raw);
  return block?.kind === "metric" ? block : undefined;
}

/**
 * Every block passes the Canvas schema before it is drawn, so a label past a
 * bound or a series the chart type refuses drops that one visual rather than
 * breaking the page.
 */
function decoded(
  raw: Readonly<Record<string, unknown>>,
): ReturnType<typeof decodeCanvasBlock> | undefined {
  try {
    return decodeCanvasBlock(raw);
  } catch {
    return undefined;
  }
}

function seconds(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : ms / 1_000;
}

/** Keeps a tile's value and delta at the precision its format shows. */
function round(value: number, format: CanvasMetricBlock["format"]): number {
  if (format === "percent") return Math.round(value * 1_000) / 1_000;
  if (format === "duration") return Math.round(value * 100) / 100;
  return Math.round(value * 10) / 10;
}
