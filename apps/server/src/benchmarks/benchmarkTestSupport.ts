import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeBenchmarkCellId,
  decodeBenchmarkRun,
  decodeBenchmarkSuite,
  type BenchmarkRun,
  type BenchmarkSuite,
} from "@octant/contracts";
import { planBenchmarkCells } from "@octant/domain";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { BenchmarkEventStore } from "./benchmarkEventStore";

export const BENCHMARK_TEST_NOW = "2026-11-07T10:00:00.000Z";

const directories: string[] = [];

export function removeBenchmarkTestStores(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A real journal with the runtime registries, so events decode as they do in the host. */
export function openBenchmarkTestStore(clock: () => string = () => BENCHMARK_TEST_NOW) {
  const directory = mkdtempSync(join(tmpdir(), "octant-benchmarks-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => BENCHMARK_TEST_NOW);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => BENCHMARK_TEST_NOW,
  });
  let next = 0;
  const uuid = () => `66000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
  const store = new BenchmarkEventStore({
    journal,
    connection,
    uuid,
    actor: { kind: "system", actorId: "66000000-0000-4000-8000-0000000000aa" } as never,
    clock,
  });
  return { connection, journal, projection: runtime.benchmarkProjection, store, uuid };
}

export const benchmarkIds = {
  suite: "66100000-0000-4000-8000-000000000001",
  caseA: "66100000-0000-4000-8000-0000000000a1",
  caseB: "66100000-0000-4000-8000-0000000000a2",
  run: "66100000-0000-4000-8000-000000000002",
  providerA: "66100000-0000-4000-8000-0000000000b1",
  providerB: "66100000-0000-4000-8000-0000000000b2",
  judgeProvider: "66100000-0000-4000-8000-0000000000b3",
} as const;

export function sampleSuite(overrides: Partial<Record<string, unknown>> = {}): BenchmarkSuite {
  return decodeBenchmarkSuite({
    suiteId: benchmarkIds.suite,
    revision: 1,
    name: "Smoke",
    cases: [
      {
        caseId: benchmarkIds.caseA,
        kind: "prompt",
        title: "Greeting",
        prompt: "Say hello.",
        checks: [{ kind: "contains", text: "hello", caseSensitive: false }],
      },
      {
        caseId: benchmarkIds.caseB,
        kind: "prompt",
        title: "Number",
        prompt: "Say 42.",
        checks: [],
      },
    ],
    createdAt: BENCHMARK_TEST_NOW,
    updatedAt: BENCHMARK_TEST_NOW,
    ...overrides,
  });
}

export function sampleRun(
  options: {
    readonly repetitions?: number;
    readonly budget?: BenchmarkRun["budget"];
    readonly providers?: ReadonlyArray<string>;
    readonly suite?: BenchmarkSuite;
    readonly judge?: { readonly providerInstanceId: string; readonly modelId: string };
  } = {},
): BenchmarkRun {
  const suite = options.suite ?? sampleSuite();
  const contenders = (options.providers ?? [benchmarkIds.providerA]).map((providerInstanceId) => ({
    providerInstanceId,
    modelId: "model-a",
  }));
  const repetitions = options.repetitions ?? 1;
  let next = 0;
  return decodeBenchmarkRun({
    runId: benchmarkIds.run,
    suiteId: suite.suiteId,
    suiteRevision: suite.revision,
    suiteName: suite.name,
    cases: suite.cases,
    ...(options.judge === undefined
      ? {}
      : { judge: { ...options.judge, rubric: "Prefer correct, short answers." } }),
    contenders,
    repetitions,
    budget: options.budget ?? { maxTokens: 1_000_000 },
    status: "running",
    startedAt: BENCHMARK_TEST_NOW,
    cells: planBenchmarkCells(suite.cases, contenders, repetitions, () =>
      decodeBenchmarkCellId(`66200000-0000-4000-8000-${String(++next).padStart(12, "0")}`),
    ),
  });
}
