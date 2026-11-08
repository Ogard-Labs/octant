import {
  type BenchmarkCellMetrics,
  type BenchmarkHistoryRequest,
  type BenchmarkHistoryResponse,
  type BenchmarkRun,
  type BenchmarkRunExportRequest,
  type BenchmarkRunExportResponse,
  type BenchmarkRunReadRequest,
  type BenchmarkRunReadResponse,
  type TurnMetricsRecord,
} from "@octant/contracts";
import { benchmarkCellMetrics, benchmarkHistory } from "@octant/domain";
import type { BenchmarkProjection } from "./benchmarkProjection";
import type { BenchmarkOutcome } from "./benchmarkService";

export const BENCHMARK_EXPORT_ANSWERS_NOTE =
  "Answers are not included; read them in each cell's thread. Judge reasons, check details and star notes are included and may quote an answer.";

export interface BenchmarkReportsOptions {
  readonly projection: Pick<BenchmarkProjection, "runs" | "run">;
  readonly turnMetrics: {
    readonly forThread: (threadId: string) => ReadonlyArray<TurnMetricsRecord>;
  };
  /** The run read, so an export carries the same leaderboard and overhead the page shows. */
  readonly readRun: (
    request: BenchmarkRunReadRequest,
  ) => BenchmarkOutcome<BenchmarkRunReadResponse>;
  /** A provider instance's display name, or its id when the instance is gone. */
  readonly providerLabel: (providerInstanceId: string) => string;
}

/**
 * Reads that span runs or leave the host as a file: a suite's history and a
 * run's export. They only read, and an export never carries answer text,
 * because answers stay in the cell threads.
 */
export class BenchmarkReports {
  readonly #options: BenchmarkReportsOptions;

  constructor(options: BenchmarkReportsOptions) {
    this.#options = options;
  }

  history(request: BenchmarkHistoryRequest): BenchmarkHistoryResponse {
    const runs = this.#options.projection.runs().filter((run) => run.suiteId === request.suiteId);
    return {
      suiteId: request.suiteId,
      runs: benchmarkHistory(runs, (run) => this.#metricsByThread(run)),
    };
  }

  exportRun(request: BenchmarkRunExportRequest): BenchmarkOutcome<BenchmarkRunExportResponse> {
    const read = this.#options.readRun({ runId: request.runId });
    if (read.status === "refused") return read;
    const { run } = read.value;
    const fileName = exportFileName(run, request.format);
    const content =
      request.format === "json"
        ? this.#json(read.value)
        : this.#csv(run, new Map(read.value.cellMetrics.map((m) => [String(m.cellId), m.metrics])));
    return {
      status: "ok",
      value: {
        fileName,
        contentType: request.format === "json" ? "application/json" : "text/csv; charset=utf-8",
        content,
      },
    };
  }

  #metricsByThread(run: BenchmarkRun): ReadonlyMap<string, BenchmarkCellMetrics> {
    const byThread = new Map<string, BenchmarkCellMetrics>();
    for (const cell of run.cells) {
      if (cell.threadId === undefined) continue;
      const record = this.#options.turnMetrics.forThread(cell.threadId).at(-1);
      if (record !== undefined) byThread.set(cell.threadId, benchmarkCellMetrics(record));
    }
    return byThread;
  }

  #contenderLabel(run: BenchmarkRun, index: number): string {
    const contender = run.contenders[index];
    if (contender === undefined) return "";
    const effort = contender.effort === undefined ? "" : ` (${contender.effort})`;
    return `${this.#options.providerLabel(String(contender.providerInstanceId))} ${String(contender.modelId)}${effort}`;
  }

  #json(read: BenchmarkRunReadResponse): string {
    const { run } = read;
    const metrics = new Map(read.cellMetrics.map((entry) => [String(entry.cellId), entry.metrics]));
    const titles = new Map(run.cases.map((c) => [String(c.caseId), c.title]));
    return JSON.stringify(
      {
        answers: BENCHMARK_EXPORT_ANSWERS_NOTE,
        run: {
          runId: run.runId,
          suiteId: run.suiteId,
          suiteRevision: run.suiteRevision,
          suiteName: run.suiteName,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
          ...(run.endReason === undefined ? {} : { endReason: run.endReason }),
          repetitions: run.repetitions,
          budget: run.budget,
          ...(run.executionLevel === undefined ? {} : { executionLevel: run.executionLevel }),
          cases: run.cases,
          ...(run.judge === undefined ? {} : { judge: run.judge }),
          contenders: run.contenders.map((contender, index) => ({
            ...contender,
            label: this.#contenderLabel(run, index),
          })),
        },
        cells: run.cells.map((cell) => ({
          cellId: cell.cellId,
          caseId: cell.caseId,
          caseTitle: titles.get(String(cell.caseId)) ?? "",
          contenderIndex: cell.contenderIndex,
          repetition: cell.repetition,
          state: cell.state,
          ...(cell.threadId === undefined ? {} : { threadId: cell.threadId }),
          ...(cell.startedAt === undefined ? {} : { startedAt: cell.startedAt }),
          ...(cell.settledAt === undefined ? {} : { settledAt: cell.settledAt }),
          ...(cell.failureReason === undefined ? {} : { failureReason: cell.failureReason }),
          checks: cell.checks,
          ...(cell.judge === undefined ? {} : { judge: cell.judge }),
          ...(cell.rating === undefined ? {} : { rating: cell.rating }),
          ...(metrics.get(String(cell.cellId)) === undefined
            ? {}
            : { metrics: metrics.get(String(cell.cellId)) }),
        })),
        leaderboard: read.leaderboard,
        ...(read.overhead === undefined ? {} : { overhead: read.overhead }),
      },
      null,
      2,
    );
  }

  #csv(run: BenchmarkRun, metrics: ReadonlyMap<string, BenchmarkCellMetrics>): string {
    const titles = new Map(run.cases.map((c) => [String(c.caseId), c.title]));
    const rows: Array<ReadonlyArray<string | number | undefined>> = [CSV_COLUMNS];
    for (const cell of run.cells) {
      const figures = metrics.get(String(cell.cellId));
      const passed = cell.checks.filter((check) => check.passed).length;
      rows.push([
        titles.get(String(cell.caseId)) ?? "",
        this.#contenderLabel(run, cell.contenderIndex),
        cell.repetition,
        cell.state,
        cell.checks.length === 0 ? undefined : `${passed}/${cell.checks.length}`,
        cell.judge?.status === "scored" ? cell.judge.score : undefined,
        cell.rating?.stars,
        figures?.timeToFirstTokenMs,
        figures?.wallMs,
        figures?.inputTokens,
        figures?.outputTokens,
        figures?.costUsd,
        figures?.toolFailures,
      ]);
    }
    return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
  }
}

const CSV_COLUMNS = [
  "Case",
  "Contender",
  "Repetition",
  "State",
  "Checks passed",
  "Judge score",
  "Stars",
  "First token ms",
  "Duration ms",
  "Input tokens",
  "Output tokens",
  "Cost USD",
  "Tool failures",
] as const;

/**
 * RFC 4180 quoting, after neutralising a spreadsheet formula: a field that
 * would open as one gets a leading apostrophe, which a spreadsheet shows as
 * plain text. Titles and model names are person- or provider-supplied.
 */
export function csvField(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function exportFileName(run: BenchmarkRun, format: "json" | "csv"): string {
  const slug =
    run.suiteName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "suite";
  return `benchmark-${slug}-${String(run.runId).slice(0, 8)}.${format}`;
}
