import {
  decodeBenchmarkRun,
  type BenchmarkCell,
  type BenchmarkCellMetrics,
} from "@octant/contracts";
import { expect, it } from "vitest";
import { rankModelsForSuite } from "./benchmarkModelAdvice";

const uuid = (n: number) => `66000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const old = "2026-07-01T00:00:00.000Z";
const recent = "2026-11-18T00:00:00.000Z";
const now = Date.parse("2026-11-20T00:00:00.000Z");
const providerInstanceId = uuid(1);

function run(id: number, modelIds: string[], date: string, caseCount = 5, repetitions = 1) {
  return decodeBenchmarkRun({
    runId: uuid(id),
    suiteId: uuid(2),
    suiteRevision: 1,
    suiteName: "Refactor",
    startedAt: date,
    endedAt: date,
    status: "finished",
    contenders: modelIds.map((modelId) => ({ providerInstanceId, modelId })),
    budget: { maxTokens: 1000 },
    repetitions,
    cases: Array.from({ length: caseCount }, (_, index) => ({
      caseId: uuid(100 + index),
      kind: "prompt",
      title: `Case ${index + 1}`,
      prompt: "Reply OK",
      checks: [{ kind: "equals", text: "OK", trim: true }],
    })),
    cells: modelIds.flatMap((_, contenderIndex) =>
      Array.from({ length: caseCount * repetitions }, (_, index) => ({
        cellId: uuid(id * 1000 + contenderIndex * 100 + index),
        contenderIndex,
        caseId: uuid(100 + (index % caseCount)),
        repetition: 1 + Math.floor(index / caseCount),
        state: "answered",
        checks: [{ index: 0, passed: true }],
      })),
    ),
  });
}

it("ranks the newest finished result per model by cost per pass, median time and stable ties", () => {
  const first = run(4, ["slow", "tie-b", "tie-a", "unknown", "older", "fails"], old);
  const last = run(5, ["fails"], recent);
  const insufficient = run(6, ["few"], recent, 4, 2);
  const unfinished = { ...run(7, ["tie-a"], recent), status: "budget-reached" as const };
  const fixtures = [
    { costUsd: 0.2, wallMs: 500 },
    { costUsd: 0.2, wallMs: 300 },
    { costUsd: 0.2, wallMs: 300 },
    { wallMs: 10 },
    { costUsd: 0.3, wallMs: 100 },
    { costUsd: 0.1, wallMs: 100 },
  ];
  function read(cell: BenchmarkCell): BenchmarkCellMetrics | undefined {
    const measure = fixtures[cell.contenderIndex];
    return measure === undefined ? undefined : { stopReason: "end-of-turn", ...measure };
  }
  const runs = [
    insufficient,
    {
      ...last,
      cells: last.cells.map((cell, index) => ({
        ...cell,
        checks: [{ index: 0, passed: index < 3 }],
      })),
    },
    unfinished,
    first,
  ];
  const ranked = rankModelsForSuite(runs, 0.8, read, now);
  expect(ranked.map((model) => model.modelId)).toEqual([
    "tie-a",
    "tie-b",
    "slow",
    "older",
    "unknown",
  ]);
  expect(ranked[0]).toMatchObject({ costPerPass: 0.2, medianMs: 300, runAt: old, stale: true });
  expect(ranked.at(-1)).not.toHaveProperty("costPerPass");
  expect(rankModelsForSuite(runs.toReversed(), 0.8, read, now)).toEqual(ranked);
});

it("counts failures in the denominator and requires complete cost reporting", () => {
  const sample = run(9, ["sometimes"], recent);
  const ranked = rankModelsForSuite(
    [
      {
        ...sample,
        cells: sample.cells.map((cell, index) =>
          index === 0 ? { ...cell, state: "failed", checks: [] } : cell,
        ),
      },
    ],
    0.8,
    (cell) => ({
      stopReason: "end-of-turn",
      wallMs: 123,
      ...(cell.state === "failed" ? {} : { costUsd: 0 }),
    }),
    now,
  );
  expect(ranked).toEqual([
    {
      modelId: "sometimes",
      providerInstanceId,
      passRate: 0.8,
      medianMs: 123,
      runAt: recent,
      stale: false,
    },
  ]);
});
