import {
  BENCHMARK_EVENT_NAMES,
  BENCHMARK_RUN_AGGREGATE_TYPE,
  BENCHMARK_SUITE_AGGREGATE_TYPE,
  BenchmarkCellJudged,
  BenchmarkCellRated,
  BenchmarkCellRequeued,
  BenchmarkCellSettled,
  BenchmarkCellStarted,
  BenchmarkRunEnded,
  BenchmarkRunPurged,
  BenchmarkRunStarted,
  BenchmarkSuiteDeleted,
  BenchmarkSuiteSaved,
  type BenchmarkCell,
  type BenchmarkRun,
  type BenchmarkSuite,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeSuiteSaved = Schema.decodeUnknownSync(BenchmarkSuiteSaved);
const decodeSuiteDeleted = Schema.decodeUnknownSync(BenchmarkSuiteDeleted);
const decodeRunStarted = Schema.decodeUnknownSync(BenchmarkRunStarted);
const decodeCellStarted = Schema.decodeUnknownSync(BenchmarkCellStarted);
const decodeCellRequeued = Schema.decodeUnknownSync(BenchmarkCellRequeued);
const decodeCellSettled = Schema.decodeUnknownSync(BenchmarkCellSettled);
const decodeCellJudged = Schema.decodeUnknownSync(BenchmarkCellJudged);
const decodeCellRated = Schema.decodeUnknownSync(BenchmarkCellRated);
const decodeRunEnded = Schema.decodeUnknownSync(BenchmarkRunEnded);
const decodeRunPurged = Schema.decodeUnknownSync(BenchmarkRunPurged);

interface Versioned<T> {
  readonly value: T | undefined;
  readonly version: number;
}

/**
 * Suites and runs as the journal tells them, held in memory and rebuilt at
 * start from the two benchmark aggregates alone. An event applies only past
 * the version its aggregate already reached, so replaying a stream twice, or
 * catching up over events already applied, leaves the same state. A purged run
 * and a deleted suite keep their version so a stale replay cannot bring them
 * back.
 */
export class BenchmarkProjection implements Projection {
  readonly name = "benchmarks";
  readonly dependencies: ReadonlyArray<string> = [];
  // The state lives only in these maps, so every host start replays them all.
  readonly holdsStateInMemory = true as const;
  readonly aggregateTypes: ReadonlyArray<string> = [
    BENCHMARK_SUITE_AGGREGATE_TYPE,
    BENCHMARK_RUN_AGGREGATE_TYPE,
  ];
  readonly #suites = new Map<string, Versioned<BenchmarkSuite>>();
  readonly #runs = new Map<string, Versioned<BenchmarkRun>>();

  reset(_connection: SqliteConnection): void {
    this.#suites.clear();
    this.#runs.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.aggregateType === BENCHMARK_SUITE_AGGREGATE_TYPE) {
      this.#applySuite(event);
      return;
    }
    if (event.aggregateType === BENCHMARK_RUN_AGGREGATE_TYPE) this.#applyRun(event);
  }

  suites(): ReadonlyArray<BenchmarkSuite> {
    return [...this.#suites.values()]
      .flatMap((entry) => (entry.value === undefined ? [] : [entry.value]))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  suite(suiteId: string): BenchmarkSuite | undefined {
    return this.#suites.get(suiteId)?.value;
  }

  /** Every run, newest first. */
  runs(): ReadonlyArray<BenchmarkRun> {
    return [...this.#runs.values()]
      .flatMap((entry) => (entry.value === undefined ? [] : [entry.value]))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  /** A run id is a UUID in either case; runs are held and found by the lower-case form. */
  run(runId: string): BenchmarkRun | undefined {
    return this.#runs.get(runId.toLowerCase())?.value;
  }

  /** Runs still working, oldest first, so an earlier run is served first. */
  runningRuns(): ReadonlyArray<BenchmarkRun> {
    return this.runs()
      .filter((run) => run.status === "running")
      .reverse();
  }

  #applySuite(event: EventEnvelope): void {
    const suiteId = String(event.aggregateId);
    const current = this.#suites.get(suiteId);
    if (current !== undefined && current.version >= event.aggregateVersion) return;
    if (event.eventName === BENCHMARK_EVENT_NAMES.suiteSaved) {
      const { suite } = decodeSuiteSaved(event.payload);
      this.#suites.set(suiteId, { value: suite, version: event.aggregateVersion });
      return;
    }
    if (event.eventName === BENCHMARK_EVENT_NAMES.suiteDeleted) {
      decodeSuiteDeleted(event.payload);
      this.#suites.set(suiteId, { value: undefined, version: event.aggregateVersion });
    }
  }

  #applyRun(event: EventEnvelope): void {
    // A run journaled with an upper-case id is the same run as its lower-case
    // form, so replay keys on one canonical case; the journal keeps its own.
    const runId = String(event.aggregateId).toLowerCase();
    const current = this.#runs.get(runId);
    if (current !== undefined && current.version >= event.aggregateVersion) return;
    const version = event.aggregateVersion;
    switch (event.eventName) {
      case BENCHMARK_EVENT_NAMES.runStarted: {
        this.#runs.set(runId, { value: decodeRunStarted(event.payload).run, version });
        return;
      }
      case BENCHMARK_EVENT_NAMES.runPurged: {
        decodeRunPurged(event.payload);
        this.#runs.set(runId, { value: undefined, version });
        return;
      }
      default:
        break;
    }
    const run = current?.value;
    if (run === undefined) return;
    switch (event.eventName) {
      case BENCHMARK_EVENT_NAMES.cellStarted: {
        const payload = decodeCellStarted(event.payload);
        this.#set(
          runId,
          version,
          withCell(run, String(payload.cellId), (cell) => {
            const { settledAt: _settledAt, failureReason: _failureReason, ...started } = cell;
            return {
              ...started,
              state: "running",
              threadId: payload.threadId,
              ...(payload.turnId === undefined ? {} : { turnId: payload.turnId }),
              startedAt: payload.startedAt,
            };
          }),
        );
        return;
      }
      case BENCHMARK_EVENT_NAMES.cellRequeued: {
        const payload = decodeCellRequeued(event.payload);
        this.#set(
          runId,
          version,
          withCell(run, String(payload.cellId), (cell) => {
            const { startedAt: _startedAt, turnId: _turnId, ...queued } = cell;
            return { ...queued, state: "queued" };
          }),
        );
        return;
      }
      case BENCHMARK_EVENT_NAMES.cellSettled: {
        const payload = decodeCellSettled(event.payload);
        this.#set(
          runId,
          version,
          withCell(run, String(payload.cellId), (cell) => {
            const { failureReason: _failureReason, ...settled } = cell;
            return {
              ...settled,
              state: payload.state,
              checks: payload.checks,
              settledAt: payload.settledAt,
              ...(payload.failureReason === undefined
                ? {}
                : { failureReason: payload.failureReason }),
            };
          }),
        );
        return;
      }
      case BENCHMARK_EVENT_NAMES.cellJudged: {
        const payload = decodeCellJudged(event.payload);
        this.#set(
          runId,
          version,
          withCell(run, String(payload.cellId), (cell) => ({
            ...cell,
            judge: payload.judge,
          })),
        );
        return;
      }
      case BENCHMARK_EVENT_NAMES.cellRated: {
        const payload = decodeCellRated(event.payload);
        this.#set(
          runId,
          version,
          withCell(run, String(payload.cellId), (cell) => ({
            ...cell,
            rating: payload.rating,
          })),
        );
        return;
      }
      case BENCHMARK_EVENT_NAMES.runEnded: {
        const payload = decodeRunEnded(event.payload);
        const { endReason: _endReason, ...open } = run;
        this.#set(runId, version, {
          ...open,
          status: payload.status,
          endedAt: payload.endedAt,
          ...(payload.endReason === undefined ? {} : { endReason: payload.endReason }),
        });
        return;
      }
      default:
        return;
    }
  }

  #set(runId: string, version: number, run: BenchmarkRun): void {
    this.#runs.set(runId, { value: run, version });
  }
}

function withCell(
  run: BenchmarkRun,
  cellId: string,
  update: (cell: BenchmarkCell) => BenchmarkCell,
): BenchmarkRun {
  return {
    ...run,
    cells: run.cells.map((cell) => (String(cell.cellId) === cellId ? update(cell) : cell)),
  };
}
