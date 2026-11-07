import {
  AggregateId,
  AggregateVersion,
  BENCHMARK_EVENT_NAMES,
  BENCHMARK_RUN_AGGREGATE_TYPE,
  BENCHMARK_SUITE_AGGREGATE_TYPE,
  BenchmarkCellJudged,
  BenchmarkCellRated,
  BenchmarkCellSettled,
  BenchmarkCellStarted,
  BenchmarkRunEnded,
  BenchmarkRunPurged,
  BenchmarkRunStarted,
  BenchmarkSuiteDeleted,
  BenchmarkSuiteSaved,
  CorrelationId,
  EventActor,
  EventId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

export function registerBenchmarkEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(BENCHMARK_EVENT_NAMES.suiteSaved, 1, BenchmarkSuiteSaved)
    .register(BENCHMARK_EVENT_NAMES.suiteDeleted, 1, BenchmarkSuiteDeleted)
    .register(BENCHMARK_EVENT_NAMES.runStarted, 1, BenchmarkRunStarted)
    .register(BENCHMARK_EVENT_NAMES.cellStarted, 1, BenchmarkCellStarted)
    .register(BENCHMARK_EVENT_NAMES.cellSettled, 1, BenchmarkCellSettled)
    .register(BENCHMARK_EVENT_NAMES.cellJudged, 1, BenchmarkCellJudged)
    .register(BENCHMARK_EVENT_NAMES.cellRated, 1, BenchmarkCellRated)
    .register(BENCHMARK_EVENT_NAMES.runEnded, 1, BenchmarkRunEnded)
    .register(BENCHMARK_EVENT_NAMES.runPurged, 1, BenchmarkRunPurged);
}

export interface BenchmarkEventStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

/**
 * Appends benchmark events. Suite events journal on the suite's own aggregate
 * and run events on the run's, each against the aggregate's current head, so a
 * second writer cannot interleave an event the projection would apply out of
 * order. The host is single-process, so the head read and the append happen in
 * one synchronous step.
 */
export class BenchmarkEventStore {
  readonly #options: BenchmarkEventStoreOptions;
  readonly #actor: typeof EventActor.Type;

  constructor(options: BenchmarkEventStoreOptions) {
    this.#options = options;
    this.#actor = decodeActor(options.actor);
  }

  suiteSaved(payload: BenchmarkSuiteSaved): void {
    this.#append(
      BENCHMARK_SUITE_AGGREGATE_TYPE,
      String(payload.suite.suiteId),
      BENCHMARK_EVENT_NAMES.suiteSaved,
      payload,
    );
  }

  suiteDeleted(payload: BenchmarkSuiteDeleted): void {
    this.#append(
      BENCHMARK_SUITE_AGGREGATE_TYPE,
      String(payload.suiteId),
      BENCHMARK_EVENT_NAMES.suiteDeleted,
      payload,
    );
  }

  runStarted(payload: BenchmarkRunStarted): void {
    this.#appendRun(String(payload.run.runId), BENCHMARK_EVENT_NAMES.runStarted, payload);
  }

  cellStarted(payload: BenchmarkCellStarted): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellStarted, payload);
  }

  cellSettled(payload: BenchmarkCellSettled): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellSettled, payload);
  }

  cellJudged(payload: BenchmarkCellJudged): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellJudged, payload);
  }

  cellRated(payload: BenchmarkCellRated): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellRated, payload);
  }

  runEnded(payload: BenchmarkRunEnded): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.runEnded, payload);
  }

  runPurged(payload: BenchmarkRunPurged): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.runPurged, payload);
  }

  #appendRun(runId: string, eventName: string, payload: unknown): void {
    this.#append(BENCHMARK_RUN_AGGREGATE_TYPE, runId, eventName, payload);
  }

  #append(aggregateType: string, aggregateId: string, eventName: string, payload: unknown): void {
    const { journal, connection, uuid, clock } = this.#options;
    journal.append({
      aggregate: { aggregateType, aggregateId: decodeAggregateId(aggregateId) },
      expectedVersion: decodeAggregateVersion(
        readAggregateVersion(connection, aggregateType, aggregateId),
      ),
      events: [
        {
          eventId: decodeEventId(uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(uuid()),
          actor: this.#actor,
          occurredAt: clock(),
          payload,
        },
      ],
    });
  }
}
