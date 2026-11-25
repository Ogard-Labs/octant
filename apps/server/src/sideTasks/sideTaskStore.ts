import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_OPEN_SIDE_TASKS,
  MAX_SIDE_TASK_VIEW_ENTRIES,
  MAX_STARTED_SIDE_TASK_RECEIPTS,
  SideTaskContinuedHere,
  SideTaskContinuationRefused,
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
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export function registerSideTaskEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(THREAD_SIDE_TASK_EVENT_NAMES.offered, 1, SideTaskOffer)
    .register(THREAD_SIDE_TASK_EVENT_NAMES.started, 1, SideTaskStarted)
    .register(THREAD_SIDE_TASK_EVENT_NAMES.dismissed, 1, SideTaskDismissed)
    .register(THREAD_SIDE_TASK_EVENT_NAMES.continuationRefused, 1, SideTaskContinuationRefused)
    .register(THREAD_SIDE_TASK_EVENT_NAMES.continuedHere, 1, SideTaskContinuedHere);
}

export type SideTaskSettlement =
  | { readonly kind: "started"; readonly payload: SideTaskStarted }
  | { readonly kind: "continued-here"; readonly payload: SideTaskContinuedHere }
  | { readonly kind: "continuation-refused"; readonly payload: SideTaskContinuationRefused }
  | { readonly kind: "dismissed"; readonly payload: SideTaskDismissed };

const SETTLEMENT_EVENT_NAMES = {
  started: THREAD_SIDE_TASK_EVENT_NAMES.started,
  "continued-here": THREAD_SIDE_TASK_EVENT_NAMES.continuedHere,
  "continuation-refused": THREAD_SIDE_TASK_EVENT_NAMES.continuationRefused,
  dismissed: THREAD_SIDE_TASK_EVENT_NAMES.dismissed,
} as const;

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
  /**
   * The offer behind every started child, keyed by the child's thread id.
   * The view is bounded, so a long-lived child's offer can fall off it while
   * the child still owes its parent reports; report detection and the
   * reporting switch read this index instead of the capped list.
   */
  readonly #startedOffers = new Map<
    string,
    { readonly parentThreadId: string; readonly offer: SideTaskOffer }
  >();

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
   * The offer a started child came from, even after newer offers pushed it
   * out of the parent's view. Answers only for the child this parent
   * started, so a stray child id cannot borrow another thread's offer.
   */
  startedOfferFor(parentThreadId: string, childThreadId: string): SideTaskOffer | undefined {
    const entry = this.#startedOffers.get(childThreadId);
    return entry !== undefined && String(entry.parentThreadId) === parentThreadId
      ? entry.offer
      : undefined;
  }

  /** The child an offer of this thread started, even after its receipt aged out. */
  startedChildOf(parentThreadId: string, sideTaskId: string): string | undefined {
    for (const [childThreadId, entry] of this.#startedOffers) {
      if (String(entry.parentThreadId) === parentThreadId && String(entry.offer.id) === sideTaskId)
        return childThreadId;
    }
    return undefined;
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
    settlement: SideTaskSettlement,
  ): "settled" | "not-found" | "already-settled" {
    const record = this.#records.get(threadId);
    const task = this.find(threadId, String(settlement.payload.sideTaskId));
    if (record === undefined || task === undefined) return "not-found";
    const completesClaim =
      task.status === "continued-here" &&
      task.continuedDelivery === "unconfirmed" &&
      (settlement.kind === "continuation-refused" ||
        (settlement.kind === "continued-here" && settlement.payload.delivery !== "unconfirmed"));
    if (
      (task.status !== "offered" && !completesClaim) ||
      (settlement.kind === "continuation-refused" && !completesClaim)
    )
      return "already-settled";
    this.#append(threadId, record, SETTLEMENT_EVENT_NAMES[settlement.kind], settlement.payload);
    this.#applySettlement(record, settlement);
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
    this.#boundView(record);
  }

  /**
   * Drops the oldest receipts past the view's bounds, started ones against
   * their own. Those age from their start, not their offer, so starting an old
   * offer never drops the receipt it just made.
   */
  #boundView(record: ThreadRecord): void {
    if (record.tasks.length <= MAX_SIDE_TASK_VIEW_ENTRIES) return;
    const startOrder = [...this.#startedOffers.keys()];
    const started = record.tasks
      .filter((task) => task.status === "started")
      .toSorted(
        (left, right) =>
          startOrder.indexOf(String(left.startedThreadId)) -
          startOrder.indexOf(String(right.startedThreadId)),
      );
    const others = record.tasks.filter((task) => task.status !== "started");
    const kept = new Set([
      ...started.slice(-MAX_STARTED_SIDE_TASK_RECEIPTS),
      ...others.slice(-MAX_SIDE_TASK_VIEW_ENTRIES),
    ]);
    if (kept.size === record.tasks.length) return;
    record.tasks.splice(0, record.tasks.length, ...record.tasks.filter((task) => kept.has(task)));
  }

  #applySettlement(record: ThreadRecord, settlement: SideTaskSettlement): void {
    const index = record.tasks.findIndex(
      (task) => String(task.offer.id) === String(settlement.payload.sideTaskId),
    );
    const task = record.tasks[index];
    if (task === undefined) return;
    if (settlement.kind === "started") {
      this.#startedOffers.set(String(settlement.payload.startedThreadId), {
        parentThreadId: String(task.offer.threadId),
        offer: task.offer,
      });
    }
    record.tasks[index] = settledTask(task, settlement);
    this.#boundView(record);
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      THREAD_SIDE_TASKS_AGGREGATE_TYPE,
    ])) {
      const threadId = String(envelope.aggregateId);
      const record = this.#records.get(threadId) ?? { tasks: [], version: 0 };
      this.#records.set(threadId, record);
      record.version += 1;
      if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.offered) {
        this.#applyOffer(record, envelope.payload as SideTaskOffer);
      } else if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.started) {
        this.#applySettlement(record, {
          kind: "started",
          payload: envelope.payload as SideTaskStarted,
        });
      } else if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.continuedHere) {
        this.#applySettlement(record, {
          kind: "continued-here",
          payload: envelope.payload as SideTaskContinuedHere,
        });
      } else if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.dismissed) {
        this.#applySettlement(record, {
          kind: "dismissed",
          payload: envelope.payload as SideTaskDismissed,
        });
      } else if (envelope.eventName === THREAD_SIDE_TASK_EVENT_NAMES.continuationRefused) {
        this.#applySettlement(record, {
          kind: "continuation-refused",
          payload: envelope.payload as SideTaskContinuationRefused,
        });
      }
    }
  }
}

/**
 * A start journaled before forks existed carries no context; every such start
 * was fresh, so it reads as one.
 */
function settledTask(task: SideTask, settlement: SideTaskSettlement): SideTask {
  if (settlement.kind === "continuation-refused") return { offer: task.offer, status: "offered" };
  if (settlement.kind === "started") {
    return {
      ...task,
      status: "started",
      startedThreadId: settlement.payload.startedThreadId,
      startedWith: settlement.payload.startedWith ?? "fresh",
      settledAt: settlement.payload.startedAt,
    };
  }
  if (settlement.kind === "continued-here") {
    return {
      ...task,
      status: "continued-here",
      continuedDelivery: settlement.payload.delivery,
      settledAt: settlement.payload.continuedAt,
    };
  }
  return { ...task, status: "dismissed", settledAt: settlement.payload.dismissedAt };
}
