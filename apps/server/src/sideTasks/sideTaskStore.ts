import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_OPEN_SIDE_TASKS,
  MAX_SIDE_TASK_VIEW_ENTRIES,
  SideTaskDismissed,
  SideTaskOffer,
  SideTaskStarted,
  THREAD_SIDE_TASKS_AGGREGATE_TYPE,
  THREAD_SIDE_TASK_EVENT_NAMES,
  decodeThreadSideTasks,
  type SideTask,
  type ThreadSideTasks,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replay">;

export function registerSideTaskEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(THREAD_SIDE_TASK_EVENT_NAMES.offered, 1, SideTaskOffer)
    .register(THREAD_SIDE_TASK_EVENT_NAMES.started, 1, SideTaskStarted)
    .register(THREAD_SIDE_TASK_EVENT_NAMES.dismissed, 1, SideTaskDismissed);
}

interface ThreadRecord {
  tasks: SideTask[];
  version: number;
}

/**
 * The side tasks each thread's model offered and what the person did with
 * them, rebuilt from the journal. Only the recent tail is kept in view; an
 * offer that fell off it can no longer be started.
 */
export class SideTaskStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #records = new Map<string, ThreadRecord>();

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

  read(threadId: string): ThreadSideTasks {
    return decodeThreadSideTasks({
      threadId,
      tasks: this.#records.get(threadId)?.tasks ?? [],
    });
  }

  find(threadId: string, sideTaskId: string): SideTask | undefined {
    return this.#records
      .get(threadId)
      ?.tasks.find((task) => String(task.offer.id) === String(sideTaskId));
  }

  /**
   * Records an offer, unless the thread already has as many waiting on a
   * person as a card stack can reasonably hold.
   */
  offer(offer: SideTaskOffer): "offered" | "too-many-open" {
    const threadId = String(offer.threadId);
    const record = this.#records.get(threadId) ?? { tasks: [], version: 0 };
    if (record.tasks.filter((task) => task.status === "offered").length >= MAX_OPEN_SIDE_TASKS) {
      return "too-many-open";
    }
    this.#append(threadId, record, THREAD_SIDE_TASK_EVENT_NAMES.offered, offer);
    this.#records.set(threadId, record);
    this.#applyOffer(record, offer);
    return "offered";
  }

  settle(
    threadId: string,
    settlement:
      | { readonly kind: "started"; readonly payload: SideTaskStarted }
      | { readonly kind: "dismissed"; readonly payload: SideTaskDismissed },
  ): "settled" | "not-found" | "already-settled" {
    const record = this.#records.get(threadId);
    const task = this.find(threadId, String(settlement.payload.sideTaskId));
    if (record === undefined || task === undefined) return "not-found";
    if (task.status !== "offered") return "already-settled";
    this.#append(
      threadId,
      record,
      settlement.kind === "started"
        ? THREAD_SIDE_TASK_EVENT_NAMES.started
        : THREAD_SIDE_TASK_EVENT_NAMES.dismissed,
      settlement.payload,
    );
    this.#applySettlement(record, settlement.kind, settlement.payload);
    return "settled";
  }

  #append(threadId: string, record: ThreadRecord, eventName: string, payload: unknown): void {
    this.#journal.append({
      aggregate: {
        aggregateType: THREAD_SIDE_TASKS_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(threadId),
      },
      expectedVersion: decodeAggregateVersion(record.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
    record.version += 1;
  }

  #applyOffer(record: ThreadRecord, offer: SideTaskOffer): void {
    record.tasks.push({ offer, status: "offered" });
    if (record.tasks.length > MAX_SIDE_TASK_VIEW_ENTRIES) {
      record.tasks.splice(0, record.tasks.length - MAX_SIDE_TASK_VIEW_ENTRIES);
    }
  }

  #applySettlement(
    record: ThreadRecord,
    kind: "started" | "dismissed",
    payload: SideTaskStarted | SideTaskDismissed,
  ): void {
    const index = record.tasks.findIndex(
      (task) => String(task.offer.id) === String(payload.sideTaskId),
    );
    const task = record.tasks[index];
    if (task === undefined) return;
    record.tasks[index] =
      kind === "started"
        ? {
            ...task,
            status: "started",
            startedThreadId: (payload as SideTaskStarted).startedThreadId,
            settledAt: (payload as SideTaskStarted).startedAt,
          }
        : { ...task, status: "dismissed", settledAt: (payload as SideTaskDismissed).dismissedAt };
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
        if (envelope.aggregateType !== THREAD_SIDE_TASKS_AGGREGATE_TYPE) continue;
        const threadId = String(envelope.aggregateId);
        const record = this.#records.get(threadId) ?? { tasks: [], version: 0 };
        this.#records.set(threadId, record);
        record.version += 1;
        if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.offered) {
          this.#applyOffer(record, envelope.payload as SideTaskOffer);
        } else if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.started) {
          this.#applySettlement(record, "started", envelope.payload as SideTaskStarted);
        } else if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.dismissed) {
          this.#applySettlement(record, "dismissed", envelope.payload as SideTaskDismissed);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
  }
}
