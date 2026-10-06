import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_TURN_METRICS_SUMMARY_TURNS,
  TURN_METRICS_AGGREGATE_TYPE,
  TURN_METRICS_EVENT_NAMES,
  TurnMetricsRecord,
  decodeTurnMetricsRecord,
  decodeTurnMetricsSummary,
  type OctantMode,
  type TurnMetricsSummary,
  type TurnUsage,
} from "@octant/contracts";
import { addTurnToSessionMetrics, addTurnUsage } from "@octant/domain";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import type { UsageProjectScope } from "../usageProjectScope";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replay">;

export function registerTurnMetricsEvents(registry: EventRegistry): EventRegistry {
  return registry.register(TURN_METRICS_EVENT_NAMES.recorded, 1, TurnMetricsRecord);
}

/** The turn kinds a usage subject names, so a read can be narrowed the way a usage read is. */
const MODE_BY_SUBJECT_TYPE: Readonly<Record<string, OctantMode>> = {
  "chat-thread": "chat",
  "work-thread": "work",
  "code-thread": "code",
};

export interface TurnMetricsFilter {
  readonly providerInstanceId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly mode?: string | undefined;
  readonly projectId?: string | undefined;
  /** The thread, when the read is for one. */
  readonly subjectAggregateId?: string | undefined;
  readonly subjectAggregateType?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

interface ThreadTurns {
  readonly records: TurnMetricsRecord[];
  version: number;
}

/**
 * Every turn of every thread, rebuilt from the journal: its full usage, its
 * real start and stop, and how fast it ran. One frame is written when a turn
 * ends however it ends, on the thread's own aggregate, so a purge of the
 * thread takes its timing with it and a restart reads back the same totals.
 */
export class TurnMetricsStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #threads = new Map<string, ThreadTurns>();

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly actor: typeof EventActor.Type;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
    this.#hydrate();
  }

  record(input: TurnMetricsRecord): void {
    const record = decodeTurnMetricsRecord(input);
    const thread = this.#threads.get(record.threadId) ?? { records: [], version: 0 };
    this.#journal.append({
      aggregate: {
        aggregateType: TURN_METRICS_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(record.threadId),
      },
      expectedVersion: decodeAggregateVersion(thread.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: TURN_METRICS_EVENT_NAMES.recorded,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload: record,
        },
      ],
    });
    thread.version += 1;
    thread.records.push(record);
    this.#threads.set(record.threadId, thread);
  }

  /**
   * Totals over every turn the filter matches within the reader's scope, and
   * the most recent turns. Absent when nothing matches, so a surface hides the
   * figures instead of showing zeros.
   */
  summarize(filter: TurnMetricsFilter, scope: UsageProjectScope): TurnMetricsSummary | undefined {
    const matching: TurnMetricsRecord[] = [];
    for (const thread of this.#threads.values()) {
      for (const record of thread.records) {
        if (within(scope, record) && matches(filter, record)) matching.push(record);
      }
    }
    if (matching.length === 0) return undefined;
    matching.sort((left, right) => left.endedAt.localeCompare(right.endedAt));
    let usage: TurnUsage | undefined;
    let metrics: ReturnType<typeof addTurnToSessionMetrics> | undefined;
    for (const record of matching) {
      if (record.usage !== undefined) usage = addTurnUsage(usage, record.usage);
      metrics = addTurnToSessionMetrics(metrics, record.metrics);
    }
    return decodeTurnMetricsSummary({
      turns: matching.slice(-MAX_TURN_METRICS_SUMMARY_TURNS),
      turnCount: matching.length,
      ...(usage === undefined ? {} : { usage }),
      metrics: metrics!,
    });
  }

  #hydrate(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replay({
        afterSequence: afterSequence as never,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (
          envelope.aggregateType !== TURN_METRICS_AGGREGATE_TYPE ||
          envelope.eventName !== TURN_METRICS_EVENT_NAMES.recorded
        ) {
          continue;
        }
        const record = envelope.payload as TurnMetricsRecord;
        const thread = this.#threads.get(record.threadId) ?? { records: [], version: 0 };
        thread.version += 1;
        thread.records.push(record);
        this.#threads.set(record.threadId, thread);
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
  }
}

/** The same boundary a usage read draws: Projects it is in, or the turns no Project owns. */
function within(scope: UsageProjectScope, record: TurnMetricsRecord): boolean {
  if (scope.kind === "unfiled") return record.projectId === undefined;
  return record.projectId !== undefined && scope.projectIds.includes(String(record.projectId));
}

function matches(filter: TurnMetricsFilter, record: TurnMetricsRecord): boolean {
  if (
    filter.providerInstanceId !== undefined &&
    String(record.providerInstanceId) !== filter.providerInstanceId
  ) {
    return false;
  }
  if (filter.modelId !== undefined && String(record.modelId) !== filter.modelId) return false;
  if (filter.mode !== undefined && record.mode !== filter.mode) return false;
  if (filter.projectId !== undefined && String(record.projectId) !== filter.projectId) {
    return false;
  }
  if (filter.subjectAggregateId !== undefined && record.threadId !== filter.subjectAggregateId) {
    return false;
  }
  if (
    filter.subjectAggregateType !== undefined &&
    MODE_BY_SUBJECT_TYPE[filter.subjectAggregateType] !== record.mode
  ) {
    return false;
  }
  if (filter.from !== undefined && record.endedAt < filter.from) return false;
  if (filter.to !== undefined && record.endedAt > filter.to) return false;
  return true;
}
