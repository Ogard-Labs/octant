import { randomUUID } from "node:crypto";
import {
  decodeThreadPlanUpdated,
  THREAD_PLAN_EVENT_NAMES,
  type EventEnvelope,
  type ThreadPlanUpdated,
} from "@octant/contracts";
import type { ThreadPlanAggregate } from "@octant/domain";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { PlanStoreError, type PlanStore } from "./planService";

export const THREAD_PLAN_AGGREGATE_TYPE = "thread-plan";

/**
 * Plans are commanded through the loopback Plan API, which authenticates the
 * window rather than a journal principal, so the durable write is attributed to
 * the Octant Plan service itself.
 */
const PLAN_SERVICE_ACTOR = {
  kind: "system",
  actorId: "00000000-0000-4000-8000-000000000877",
} as const;

const REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export interface JournalPlanStoreOptions {
  readonly journal: JournalPort;
  readonly uuid?: () => string;
}

/**
 * Durable {@link PlanStore} backed by the authoritative event journal. Every
 * accepted Plan transition appends one `thread.plan-updated@1` event whose
 * aggregate is the thread and whose aggregate version is the Plan `version`,
 * so the journal carries the same optimistic concurrency the Plan policy
 * enforces. Construction rebuilds every thread's aggregate by replaying that
 * aggregate type, which makes the store recoverable after a host restart
 * without a separate snapshot table.
 *
 * The rebuilt map is a projection in the ordinary sense: applying an event
 * whose version is not ahead of the retained aggregate is a no-op, so replaying
 * the same events any number of times produces identical state. The in-memory
 * view is only advanced after the journal has committed, so a failed write
 * leaves both the journal and the served aggregate on the last durable state
 * instead of silently accepting a Plan that was never persisted.
 */
export class JournalPlanStore implements PlanStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #byThread = new Map<string, ThreadPlanAggregate>();

  constructor(options: JournalPlanStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid ?? randomUUID;
    this.#rebuild();
  }

  read(threadId: string): ThreadPlanAggregate {
    const aggregate = this.#byThread.get(threadId);
    if (aggregate === undefined) return { plan: null, history: [] };
    return { plan: aggregate.plan, history: [...aggregate.history] };
  }

  write(threadId: string, aggregate: ThreadPlanAggregate): void {
    const plan = aggregate.plan;
    if (plan === null || plan.threadId !== threadId) {
      throw new PlanStoreError("failed", "Plan aggregate does not match its thread.");
    }

    let payload: ThreadPlanUpdated;
    try {
      payload = decodeThreadPlanUpdated({ plan, history: aggregate.history });
    } catch {
      throw new PlanStoreError("failed", "Plan aggregate is not a durable Plan update.");
    }

    // The Plan policy assigns `version = expectedVersion + 1`, so the journal
    // head the caller observed is exactly one behind the aggregate being
    // written. Appending against it keeps the durable head and the Plan
    // version the same optimistic-concurrency token.
    const expectedVersion = plan.version - 1;
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: THREAD_PLAN_AGGREGATE_TYPE, aggregateId: threadId },
        expectedVersion,
        events: [
          {
            eventId: this.#uuid(),
            eventName: THREAD_PLAN_EVENT_NAMES.updated,
            eventVersion: 1,
            correlationId: this.#uuid(),
            actor: PLAN_SERVICE_ACTOR,
            occurredAt: plan.updatedAt,
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new PlanStoreError("conflict", "Plan version conflict; reload and retry.");
      }
      throw new PlanStoreError("failed", "Plan could not be saved.");
    }

    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateVersion !== plan.version
    ) {
      throw new PlanStoreError("failed", "Committed Plan event does not match its append.");
    }
    this.#apply(payload);
  }

  #rebuild(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: THREAD_PLAN_AGGREGATE_TYPE,
        afterSequence,
        limit: REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) return;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        this.#apply(decodeEnvelope(envelope));
      }
      if (batch.length < REPLAY_BATCH_SIZE) return;
    }
  }

  #apply(payload: ThreadPlanUpdated): void {
    const threadId = payload.plan.threadId;
    const retained = this.#byThread.get(threadId)?.plan;
    if (retained !== undefined && retained !== null && payload.plan.version <= retained.version) {
      return;
    }
    this.#byThread.set(threadId, { plan: payload.plan, history: [...payload.history] });
  }
}

function decodeEnvelope(envelope: EventEnvelope): ThreadPlanUpdated {
  if (
    envelope.eventName !== THREAD_PLAN_EVENT_NAMES.updated ||
    envelope.eventVersion !== 1 ||
    envelope.aggregateType !== THREAD_PLAN_AGGREGATE_TYPE
  ) {
    throw new PlanStoreError("failed", "Journaled Plan event is not a Plan update.");
  }
  let payload: ThreadPlanUpdated;
  try {
    payload = decodeThreadPlanUpdated(envelope.payload);
  } catch {
    throw new PlanStoreError("failed", "Journaled Plan event payload is invalid.");
  }
  if (
    String(envelope.aggregateId) !== payload.plan.threadId ||
    envelope.aggregateVersion !== payload.plan.version
  ) {
    throw new PlanStoreError("failed", "Journaled Plan event does not match its aggregate.");
  }
  return payload;
}
