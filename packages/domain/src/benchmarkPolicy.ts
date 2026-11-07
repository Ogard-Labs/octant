import {
  BENCHMARK_CODE_ONLY_CHECK_KINDS,
  BENCHMARK_FAILURE_REASON_CHARS,
  type BenchmarkBudget,
  type BenchmarkCase,
  type BenchmarkCell,
  type BenchmarkCellId,
  type BenchmarkCellMetrics,
  type BenchmarkCheck,
  type BenchmarkCheckResult,
  type BenchmarkLeaderboardRow,
  type BenchmarkRun,
  type BenchmarkRunSummary,
  type TurnMetricsRecord,
} from "@octant/contracts";
import { percentile } from "./turnDiagnosticsReport";

/** At most two cells at once per provider instance and four per host. */
export const BENCHMARK_CONCURRENCY_LIMITS = { perProvider: 2, perHost: 4 } as const;

/** An answer longer than this is cut before any check reads it. */
export const BENCHMARK_ANSWER_CHECK_CHARS = 200_000;

export function benchmarkCellCount(
  caseCount: number,
  contenderCount: number,
  repetitions: number,
): number {
  return caseCount * contenderCount * repetitions;
}

/**
 * Every cell of a run, queued. Repetition-major, then case, then contender, so
 * a run that stops early has still compared every contender on the cases it
 * reached.
 */
export function planBenchmarkCells(
  cases: ReadonlyArray<Pick<BenchmarkCase, "caseId">>,
  contenders: ReadonlyArray<unknown>,
  repetitions: number,
  newId: () => BenchmarkCellId,
): ReadonlyArray<BenchmarkCell> {
  const cells: BenchmarkCell[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const benchmarkCase of cases) {
      for (let contenderIndex = 0; contenderIndex < contenders.length; contenderIndex += 1) {
        cells.push({
          cellId: newId(),
          caseId: benchmarkCase.caseId,
          contenderIndex,
          repetition,
          state: "queued",
          checks: [],
        });
      }
    }
  }
  return cells;
}

export function isBenchmarkCodeOnlyCheck(check: BenchmarkCheck): boolean {
  return BENCHMARK_CODE_ONLY_CHECK_KINDS.includes(check.kind);
}

/**
 * Scores the answer-text checks. A check that runs in a worktree is skipped
 * here and scored by the runner; the result keeps the check's own position, so
 * the two sets of results interleave back into the case's order.
 */
export function scoreBenchmarkChecks(
  checks: ReadonlyArray<BenchmarkCheck>,
  answer: string,
): ReadonlyArray<BenchmarkCheckResult> {
  const text =
    answer.length > BENCHMARK_ANSWER_CHECK_CHARS
      ? answer.slice(0, BENCHMARK_ANSWER_CHECK_CHARS)
      : answer;
  const results: BenchmarkCheckResult[] = [];
  checks.forEach((check, index) => {
    if (isBenchmarkCodeOnlyCheck(check)) return;
    results.push(scoreOne(check, text, index));
  });
  return results;
}

function scoreOne(check: BenchmarkCheck, answer: string, index: number): BenchmarkCheckResult {
  switch (check.kind) {
    case "contains": {
      const found = check.caseSensitive
        ? answer.includes(check.text)
        : answer.toLowerCase().includes(check.text.toLowerCase());
      return found ? { index, passed: true } : { index, passed: false, detail: "text not found" };
    }
    case "not-contains": {
      const found = check.caseSensitive
        ? answer.includes(check.text)
        : answer.toLowerCase().includes(check.text.toLowerCase());
      return found ? { index, passed: false, detail: "text found" } : { index, passed: true };
    }
    case "matches": {
      let pattern: RegExp;
      try {
        pattern = new RegExp(check.pattern, check.flags);
      } catch {
        return { index, passed: false, detail: "invalid pattern" };
      }
      return pattern.test(answer)
        ? { index, passed: true }
        : { index, passed: false, detail: "no match" };
    }
    case "equals": {
      const same = check.trim ? answer.trim() === check.text.trim() : answer === check.text;
      return same ? { index, passed: true } : { index, passed: false, detail: "answer differs" };
    }
    case "valid-json": {
      try {
        JSON.parse(answer.trim());
        return { index, passed: true };
      } catch {
        return { index, passed: false, detail: "not valid JSON" };
      }
    }
    default:
      // Worktree checks never reach here: scoreBenchmarkChecks skips them.
      return { index, passed: false, detail: "check runs in a worktree" };
  }
}

export interface BenchmarkRunningCounts {
  /** Cells running now on this host, by provider instance id. */
  readonly byProvider: ReadonlyMap<string, number>;
  /** Cells running now on this host across every run. */
  readonly total: number;
}

/**
 * The queued cells that may start now, in plan order. A cell whose provider is
 * at its limit is passed over, not waited for, so one busy provider does not
 * hold back the others.
 */
export function nextBenchmarkCells(
  run: Pick<BenchmarkRun, "cells" | "contenders">,
  running: BenchmarkRunningCounts,
  limits: { readonly perProvider: number; readonly perHost: number } = BENCHMARK_CONCURRENCY_LIMITS,
): ReadonlyArray<BenchmarkCell> {
  const started = new Map(running.byProvider);
  let total = running.total;
  const next: BenchmarkCell[] = [];
  for (const cell of run.cells) {
    if (total >= limits.perHost) break;
    if (cell.state !== "queued") continue;
    const provider = run.contenders[cell.contenderIndex]?.providerInstanceId;
    if (provider === undefined) continue;
    const key = String(provider);
    const active = started.get(key) ?? 0;
    if (active >= limits.perProvider) continue;
    started.set(key, active + 1);
    total += 1;
    next.push(cell);
  }
  return next;
}

export type BenchmarkBudgetDecision =
  | { readonly decision: "start" }
  | { readonly decision: "stop"; readonly reason: string };

/**
 * Whether another cell may start. A cell is estimated at the mean of the cells
 * that settled with usage; with none settled yet the first cells are allowed,
 * because nothing is known. The run stops when what was spent, plus that
 * estimate for every cell running and the one about to start, would pass a limit.
 */
export function benchmarkBudgetDecision(
  budget: BenchmarkBudget,
  spent: { readonly tokens: number; readonly costUsd: number },
  settledCount: number,
  runningCount: number,
): BenchmarkBudgetDecision {
  if (settledCount <= 0) return { decision: "start" };
  const inFlight = runningCount + 1;
  if (budget.maxTokens !== undefined) {
    const projected = spent.tokens + (spent.tokens / settledCount) * inFlight;
    if (projected > budget.maxTokens) {
      return { decision: "stop", reason: "The next cell would pass the token budget." };
    }
  }
  if (budget.maxCostUsd !== undefined) {
    const projected = spent.costUsd + (spent.costUsd / settledCount) * inFlight;
    if (projected > budget.maxCostUsd) {
      return { decision: "stop", reason: "The next cell would pass the cost budget." };
    }
  }
  return { decision: "start" };
}

/** A run is finished once no cell is waiting or running. */
export function benchmarkRunStatusAfter(run: Pick<BenchmarkRun, "cells">): "running" | "finished" {
  return run.cells.some((cell) => cell.state === "queued" || cell.state === "running")
    ? "running"
    : "finished";
}

/** Keeps a reason inside the stored bound, on one line. */
export function boundedBenchmarkReason(
  reason: string,
  maximum: number = BENCHMARK_FAILURE_REASON_CHARS,
): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maximum) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

/** One cell's figures, read from the turn the host recorded for its thread. */
export function benchmarkCellMetrics(record: TurnMetricsRecord): BenchmarkCellMetrics {
  const { metrics, usage, diagnostics } = record;
  const tokensPerSecond =
    metrics.decodeOutputTokens !== undefined && metrics.decodeMs !== undefined
      ? Math.round((metrics.decodeOutputTokens / metrics.decodeMs) * 10_000) / 10
      : undefined;
  const cost = usage?.costUsd ?? usage?.estimatedCostUsd ?? undefined;
  return {
    stopReason: record.stopReason,
    wallMs: metrics.wallMs,
    ...(metrics.timeToFirstTokenMs === undefined
      ? {}
      : { timeToFirstTokenMs: metrics.timeToFirstTokenMs }),
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    ...(usage === undefined
      ? {}
      : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
        }),
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(diagnostics === undefined
      ? {}
      : { toolCalls: diagnostics.toolCalls, toolFailures: diagnostics.toolFailures }),
  };
}

function mean(values: ReadonlyArray<number>): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One row per contender. Figures that were not measured are absent, never
 * zero: a contender with no tool calls has no failure rate, and one whose
 * provider reported no cost has no cost.
 */
export function benchmarkLeaderboard(
  run: Pick<BenchmarkRun, "cells" | "contenders">,
  metricsByThread: ReadonlyMap<string, BenchmarkCellMetrics>,
): ReadonlyArray<BenchmarkLeaderboardRow> {
  return run.contenders.map((_, contenderIndex) => {
    const cells = run.cells.filter((cell) => cell.contenderIndex === contenderIndex);
    const answeredCells = cells.filter((cell) => cell.state === "answered");
    let passed = 0;
    let scored = 0;
    for (const cell of answeredCells) {
      for (const check of cell.checks) {
        scored += 1;
        if (check.passed) passed += 1;
      }
    }
    const judgeScores = cells.flatMap((cell) =>
      cell.judge?.status === "scored" ? [cell.judge.score] : [],
    );
    const stars = cells.flatMap((cell) => (cell.rating === undefined ? [] : [cell.rating.stars]));
    const measured = cells.flatMap((cell) => {
      const metrics = cell.threadId === undefined ? undefined : metricsByThread.get(cell.threadId);
      return metrics === undefined ? [] : [metrics];
    });
    const firstTokens = measured.flatMap((metrics) =>
      metrics.timeToFirstTokenMs === undefined ? [] : [metrics.timeToFirstTokenMs],
    );
    const speeds = measured.flatMap((metrics) =>
      metrics.tokensPerSecond === undefined ? [] : [metrics.tokensPerSecond],
    );
    const tokens = measured.flatMap((metrics) =>
      metrics.totalTokens === undefined ? [] : [metrics.totalTokens],
    );
    const costs = measured.flatMap((metrics) =>
      metrics.costUsd === undefined ? [] : [metrics.costUsd],
    );
    const toolCalls = measured.reduce((sum, metrics) => sum + (metrics.toolCalls ?? 0), 0);
    const toolFailures = measured.reduce((sum, metrics) => sum + (metrics.toolFailures ?? 0), 0);
    const meanJudgeScore = mean(judgeScores);
    const meanStars = mean(stars);
    const firstTokenP50Ms = percentile(firstTokens, 0.5);
    const firstTokenP95Ms = percentile(firstTokens, 0.95);
    const tokensPerSecondP50 = percentile(speeds, 0.5);
    const tokensPerSecondP95 = percentile(speeds, 0.95);
    const meanTokens = mean(tokens);
    const totalCostUsd = costs.length === 0 ? undefined : costs.reduce((a, b) => a + b, 0);
    return {
      contenderIndex,
      cells: cells.length,
      answered: answeredCells.length,
      ...(scored === 0 ? {} : { checkPassRate: passed / scored }),
      ...(meanJudgeScore === undefined ? {} : { meanJudgeScore }),
      ...(meanStars === undefined ? {} : { meanStars }),
      ...(firstTokenP50Ms === undefined ? {} : { firstTokenP50Ms }),
      ...(firstTokenP95Ms === undefined ? {} : { firstTokenP95Ms }),
      ...(tokensPerSecondP50 === undefined ? {} : { tokensPerSecondP50 }),
      ...(tokensPerSecondP95 === undefined ? {} : { tokensPerSecondP95 }),
      totalTokens: tokens.reduce((a, b) => a + b, 0),
      ...(meanTokens === undefined ? {} : { meanTokens }),
      ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
      ...(toolCalls === 0 ? {} : { toolFailureRate: toolFailures / toolCalls }),
      failedCount: cells.filter((cell) => cell.state === "failed").length,
      blockedCount: cells.filter((cell) => cell.state === "blocked-on-approval").length,
    };
  });
}

export function summarizeBenchmarkRun(run: BenchmarkRun): BenchmarkRunSummary {
  return {
    runId: run.runId,
    suiteId: run.suiteId,
    suiteName: run.suiteName,
    suiteRevision: run.suiteRevision,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.endReason === undefined ? {} : { endReason: run.endReason }),
    contenderCount: run.contenders.length,
    repetitions: run.repetitions,
    cellCount: run.cells.length,
    settledCount: run.cells.filter((cell) => cell.state !== "queued" && cell.state !== "running")
      .length,
    answeredCount: run.cells.filter((cell) => cell.state === "answered").length,
    failedCount: run.cells.filter((cell) => cell.state === "failed").length,
  };
}
