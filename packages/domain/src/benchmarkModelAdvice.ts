import type {
  BenchmarkCell,
  BenchmarkCellMetrics,
  BenchmarkModelAdvice,
  BenchmarkRun,
} from "@octant/contracts";

const MIN_CASES = 5;
const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export function rankModelsForSuite(
  runs: ReadonlyArray<BenchmarkRun>,
  threshold: number,
  readMetrics: (cell: BenchmarkCell) => BenchmarkCellMetrics | undefined,
  now: number,
): ReadonlyArray<BenchmarkModelAdvice> {
  const newest = new Map<string, BenchmarkRun["runId"]>();
  const result = new Map<string, BenchmarkModelAdvice>();
  const finished = runs
    .filter((run) => run.status === "finished")
    .sort(
      (a, b) =>
        Date.parse(b.endedAt ?? b.startedAt) - Date.parse(a.endedAt ?? a.startedAt) ||
        b.runId.localeCompare(a.runId),
    );
  for (const run of finished) {
    for (const [index, contender] of run.contenders.entries()) {
      const key = JSON.stringify([contender.providerInstanceId, contender.modelId]);
      const latest = newest.get(key);
      if (latest !== undefined && latest !== run.runId) continue;
      newest.set(key, run.runId);
      const cells = run.cells.filter((cell) => cell.contenderIndex === index);
      if (new Set(cells.map((cell) => cell.caseId)).size < MIN_CASES) continue;
      const passed = cells.filter(
        (cell) =>
          cell.state === "answered" &&
          cell.checks.length > 0 &&
          cell.checks.every((check) => check.passed),
      ).length;
      const passRate = passed / cells.length;
      if (passed === 0 || passRate < threshold) continue;
      const measured = cells.map(readMetrics);
      const totalCost = measured.every((metrics) => metrics?.costUsd !== undefined)
        ? measured.reduce((total, metrics) => total + (metrics?.costUsd ?? 0), 0)
        : undefined;
      const times = measured
        .flatMap((metrics) => (metrics === undefined ? [] : [metrics.wallMs]))
        .sort((a, b) => a - b);
      const middle = Math.floor(times.length / 2);
      const upper = times[middle];
      const medianMs =
        upper === undefined
          ? undefined
          : times.length % 2 === 1
            ? upper
            : ((times[middle - 1] ?? upper) + upper) / 2;
      const runAt = run.endedAt ?? run.startedAt;
      const variant: BenchmarkModelAdvice = {
        providerInstanceId: contender.providerInstanceId,
        modelId: contender.modelId,
        ...(contender.effort === undefined ? {} : { effort: contender.effort }),
        passRate,
        ...(totalCost === undefined ? {} : { costPerPass: totalCost / passed }),
        ...(medianMs === undefined ? {} : { medianMs }),
        runAt,
        stale: now - Date.parse(runAt) > STALE_AFTER_MS,
      };
      const incumbent = result.get(key);
      if (incumbent === undefined || compareAdvice(variant, incumbent) < 0)
        result.set(key, variant);
    }
  }
  return [...result.values()].sort(compareAdvice);
}

function compareAdvice(a: BenchmarkModelAdvice, b: BenchmarkModelAdvice): number {
  return (
    compareReported(a.costPerPass, b.costPerPass) ||
    compareReported(a.medianMs, b.medianMs) ||
    a.providerInstanceId.localeCompare(b.providerInstanceId) ||
    a.modelId.localeCompare(b.modelId) ||
    (a.effort ?? "").localeCompare(b.effort ?? "")
  );
}

function compareReported(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  return b === undefined ? -1 : a - b;
}
