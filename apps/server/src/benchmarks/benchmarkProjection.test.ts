import { BENCHMARK_EVENT_NAMES, type EventEnvelope } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildProjection } from "../persistence/projection";
import {
  BENCHMARK_TEST_NOW,
  benchmarkIds,
  openBenchmarkTestStore,
  removeBenchmarkTestStores,
  sampleRun,
  sampleSuite,
} from "./benchmarkTestSupport";

afterEach(removeBenchmarkTestStores);

function journalEnvelopes(journal: ReturnType<typeof openBenchmarkTestStore>["journal"]) {
  const events: EventEnvelope[] = [];
  for (const aggregateType of ["benchmark-suite", "benchmark-run"]) {
    for (const event of journal.replayAggregateType({
      aggregateType,
      afterSequence: 0,
      limit: 1_000,
    })) {
      events.push(event);
    }
  }
  return events.sort((left, right) => left.globalSequence - right.globalSequence);
}

describe("benchmark projection", () => {
  it("holds a run's cells as the journal settled them and survives a rebuild unchanged", () => {
    const { store, projection, journal, connection } = openBenchmarkTestStore();
    const suite = sampleSuite();
    store.suiteSaved({ suite });
    const run = sampleRun();
    store.runStarted({ run });
    const [first, second] = run.cells;
    store.cellStarted({
      runId: run.runId,
      cellId: first!.cellId,
      threadId: "66300000-0000-4000-8000-000000000001",
      turnId: "66300000-0000-4000-8000-000000000002",
      startedAt: BENCHMARK_TEST_NOW as never,
    });
    store.cellSettled({
      runId: run.runId,
      cellId: first!.cellId,
      state: "answered",
      checks: [{ index: 0, passed: true }],
      settledAt: BENCHMARK_TEST_NOW as never,
    });
    store.cellSettled({
      runId: run.runId,
      cellId: second!.cellId,
      state: "skipped-budget",
      failureReason: "over budget",
      checks: [],
      settledAt: BENCHMARK_TEST_NOW as never,
    });
    store.runEnded({
      runId: run.runId,
      status: "budget-reached",
      endReason: "over budget",
      endedAt: BENCHMARK_TEST_NOW as never,
    });

    const before = projection.run(benchmarkIds.run);
    expect(before?.status).toBe("budget-reached");
    expect(before?.cells.map((cell) => cell.state)).toEqual(["answered", "skipped-budget"]);
    expect(before?.cells[0]?.threadId).toBe("66300000-0000-4000-8000-000000000001");

    rebuildProjection({ connection, journal, projection, clock: () => BENCHMARK_TEST_NOW });
    expect(projection.run(benchmarkIds.run)).toEqual(before);
    expect(projection.suites()).toEqual([suite]);
  });

  it("applies the same events twice to the same rows", () => {
    const { store, projection, journal, connection } = openBenchmarkTestStore();
    store.suiteSaved({ suite: sampleSuite() });
    const run = sampleRun();
    store.runStarted({ run });
    store.cellSettled({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      state: "failed",
      failureReason: "refused",
      checks: [],
      settledAt: BENCHMARK_TEST_NOW as never,
    });
    const once = projection.run(benchmarkIds.run);
    for (const event of journalEnvelopes(journal)) projection.apply(connection, event);
    expect(projection.run(benchmarkIds.run)).toEqual(once);
    expect(projection.suites()).toHaveLength(1);
  });

  it("forgets a purged run and a deleted suite, and a stale replay does not bring them back", () => {
    const { store, projection, journal, connection } = openBenchmarkTestStore();
    store.suiteSaved({ suite: sampleSuite() });
    store.runStarted({ run: sampleRun() });
    store.suiteDeleted({ suiteId: sampleSuite().suiteId });
    store.runPurged({ runId: sampleRun().runId });
    expect(projection.suites()).toEqual([]);
    expect(projection.run(benchmarkIds.run)).toBeUndefined();
    for (const event of journalEnvelopes(journal)) projection.apply(connection, event);
    expect(projection.suites()).toEqual([]);
    expect(projection.run(benchmarkIds.run)).toBeUndefined();
  });

  it("registers every benchmark event so each can be appended and replayed", () => {
    const { store, journal } = openBenchmarkTestStore();
    const run = sampleRun();
    store.suiteSaved({ suite: sampleSuite() });
    store.runStarted({ run });
    store.cellJudged({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      judge: { status: "failed", reason: "no reply" },
    });
    store.cellRated({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      rating: { stars: 4, ratedAt: BENCHMARK_TEST_NOW as never },
    });
    const names = new Set(journalEnvelopes(journal).map((event) => event.eventName));
    expect(names).toContain(BENCHMARK_EVENT_NAMES.cellJudged);
    expect(names).toContain(BENCHMARK_EVENT_NAMES.cellRated);
  });
});
