import { randomUUID } from "node:crypto";
import {
  decodeThreadGoalUpdated,
  THREAD_GOAL_EVENT_NAMES,
  type EventEnvelope,
  type ThreadGoalUpdated,
} from "@octant/contracts";
import type { GoalAggregate } from "@octant/domain";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { GoalStoreError, type GoalStore } from "./goalService";

export const THREAD_GOAL_AGGREGATE_TYPE = "thread-goal";

/**
 * Goals are commanded through the loopback Goal API, which authenticates the
 * window rather than a journal principal, so the durable write is attributed to
 * the Octant Goal service itself.
 */
const GOAL_SERVICE_ACTOR = {
  kind: "system",
  actorId: "00000000-0000-4000-8000-000000000876",
} as const;

const REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export interface JournalGoalStoreOptions {
  readonly journal: JournalPort;
  readonly uuid?: () => string;
}

/**
 * Durable {@link GoalStore} backed by the authoritative event journal. Every
 * accepted Goal transition appends one `thread.goal-updated@1` event whose
 * aggregate is the thread and whose aggregate version is the Goal `version`,
 * so the journal carries the same optimistic concurrency the Goal policy
 * enforces. Construction rebuilds every thread's aggregate by replaying that
 * aggregate type, which makes the store recoverable after a host restart
 * without a separate snapshot table.
 *
 * The rebuilt map is a projection in the ordinary sense: applying an event
 * whose version is not ahead of the retained aggregate is a no-op, so replaying
 * the same events any number of times produces identical state. The in-memory
 * view is only advanced after the journal has committed, so a failed write
 * leaves both the journal and the served aggregate on the last durable state
 * instead of silently accepting a Goal that was never persisted.
 */
export class JournalGoalStore implements GoalStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #byThread = new Map<string, GoalAggregate>();

  constructor(options: JournalGoalStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid ?? randomUUID;
    this.#rebuild();
  }

  read(threadId: string): GoalAggregate {
    const aggregate = this.#byThread.get(threadId);
    if (aggregate === undefined) return { goal: null, history: [] };
    return { goal: aggregate.goal, history: [...aggregate.history] };
  }

  write(threadId: string, aggregate: GoalAggregate): void {
    const goal = aggregate.goal;
    if (goal === null || goal.threadId !== threadId) {
      throw new GoalStoreError("failed", "Goal aggregate does not match its thread.");
    }

    let payload: ThreadGoalUpdated;
    try {
      payload = decodeThreadGoalUpdated({ goal, history: aggregate.history });
    } catch {
      throw new GoalStoreError("failed", "Goal aggregate is not a durable Goal update.");
    }

    // The Goal policy assigns `version = expectedVersion + 1`, so the journal
    // head the caller observed is exactly one behind the aggregate being
    // written. Appending against it keeps the durable head and the Goal
    // version the same optimistic-concurrency token.
    const expectedVersion = goal.version - 1;
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: THREAD_GOAL_AGGREGATE_TYPE, aggregateId: threadId },
        expectedVersion,
        events: [
          {
            eventId: this.#uuid(),
            eventName: THREAD_GOAL_EVENT_NAMES.updated,
            eventVersion: 1,
            correlationId: this.#uuid(),
            actor: GOAL_SERVICE_ACTOR,
            occurredAt: goal.updatedAt,
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new GoalStoreError("conflict", "Goal version conflict; reload and retry.");
      }
      throw new GoalStoreError("failed", "Goal could not be saved.");
    }

    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateVersion !== goal.version
    ) {
      throw new GoalStoreError("failed", "Committed Goal event does not match its append.");
    }
    this.#apply(payload);
  }

  #rebuild(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: THREAD_GOAL_AGGREGATE_TYPE,
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

  #apply(payload: ThreadGoalUpdated): void {
    const threadId = payload.goal.threadId;
    const retained = this.#byThread.get(threadId)?.goal;
    if (retained !== undefined && retained !== null && payload.goal.version <= retained.version) {
      return;
    }
    this.#byThread.set(threadId, { goal: payload.goal, history: [...payload.history] });
  }
}

function decodeEnvelope(envelope: EventEnvelope): ThreadGoalUpdated {
  if (
    envelope.eventName !== THREAD_GOAL_EVENT_NAMES.updated ||
    envelope.eventVersion !== 1 ||
    envelope.aggregateType !== THREAD_GOAL_AGGREGATE_TYPE
  ) {
    throw new GoalStoreError("failed", "Journaled Goal event is not a Goal update.");
  }
  let payload: ThreadGoalUpdated;
  try {
    payload = decodeThreadGoalUpdated(envelope.payload);
  } catch {
    throw new GoalStoreError("failed", "Journaled Goal event payload is invalid.");
  }
  if (
    String(envelope.aggregateId) !== payload.goal.threadId ||
    envelope.aggregateVersion !== payload.goal.version
  ) {
    throw new GoalStoreError("failed", "Journaled Goal event does not match its aggregate.");
  }
  return payload;
}
