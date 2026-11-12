import {
  AggregateId,
  AggregateVersion,
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
    .register(BENCHMARK_EVENT_NAMES.cellRequeued, 1, BenchmarkCellRequeued)
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

  // What a person asks for (a suite saved or deleted, a run started or
  // purged, a cell rated) takes who asked, resolved from the authenticated
  // principal. What the runner records about a run it is carrying out names
  // nobody and keeps the store's actor.
  suiteSaved(payload: BenchmarkSuiteSaved, actor?: typeof EventActor.Type): void {
    this.#append(
      BENCHMARK_SUITE_AGGREGATE_TYPE,
      String(payload.suite.suiteId),
      BENCHMARK_EVENT_NAMES.suiteSaved,
      payload,
      actor,
    );
  }

  suiteDeleted(payload: BenchmarkSuiteDeleted, actor?: typeof EventActor.Type): void {
    this.#append(
      BENCHMARK_SUITE_AGGREGATE_TYPE,
      String(payload.suiteId),
      BENCHMARK_EVENT_NAMES.suiteDeleted,
      payload,
      actor,
    );
  }

  runStarted(payload: BenchmarkRunStarted, actor?: typeof EventActor.Type): void {
    this.#appendRun(String(payload.run.runId), BENCHMARK_EVENT_NAMES.runStarted, payload, actor);
  }

  cellStarted(payload: BenchmarkCellStarted): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellStarted, payload);
  }

  cellRequeued(payload: BenchmarkCellRequeued): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellRequeued, payload);
  }

  cellSettled(payload: BenchmarkCellSettled, actor?: typeof EventActor.Type): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellSettled, payload, actor);
  }

  cellJudged(payload: BenchmarkCellJudged): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellJudged, payload);
  }

  cellRated(payload: BenchmarkCellRated, actor?: typeof EventActor.Type): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.cellRated, payload, actor);
  }

  runEnded(payload: BenchmarkRunEnded, actor?: typeof EventActor.Type): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.runEnded, payload, actor);
  }

  runPurged(payload: BenchmarkRunPurged, actor?: typeof EventActor.Type): void {
    this.#appendRun(String(payload.runId), BENCHMARK_EVENT_NAMES.runPurged, payload, actor);
  }

  #appendRun(
    runId: string,
    eventName: string,
    payload: unknown,
    actor?: typeof EventActor.Type,
  ): void {
    this.#append(BENCHMARK_RUN_AGGREGATE_TYPE, runId, eventName, payload, actor);
  }

  #append(
    aggregateType: string,
    aggregateId: string,
    eventName: string,
    payload: unknown,
    actor: typeof EventActor.Type = this.#actor,
  ): void {
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
          actor,
          occurredAt: clock(),
          payload,
        },
      ],
    });
  }
}
