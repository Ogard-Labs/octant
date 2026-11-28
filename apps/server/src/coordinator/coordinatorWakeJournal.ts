import { randomUUID } from "node:crypto";
import { CoordinatorWorkerNotice, MAX_COORDINATOR_DONE_WHEN_ITEMS } from "@octant/contracts";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

/**
 * The journal record of each coordinator wake: one frame when the host
 * decides to wake a thread, and one when the wake's turn starts or the wake
 * is dropped. A wake with no second frame never started a turn, which is what
 * restart continuation reads (docs/design/coordinator-threads.md#bounds).
 * One aggregate per woken thread, so purging the thread takes its wakes.
 */
export const COORDINATOR_WAKE_AGGREGATE_TYPE = "coordinator-wake";

export const COORDINATOR_WAKE_EVENT_NAMES = {
  decided: "coordinator.wake-decided@1",
  settled: "coordinator.wake-settled@1",
  doneWhenSatisfied: "coordinator.done-when-satisfied@1",
  doneWhenReset: "coordinator.done-when-reset@1",
} as const;

const Id = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);

export const CoordinatorWakeDecided = Schema.Struct({
  wakeId: Schema.String.check(Schema.isGUID()),
  cause: Schema.Literals(["message", "notice", "done-when"]),
  senderThreadId: Id,
  hop: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * The worker change a notice wake is for. The rest of a coordinator's
   * pending notices stay in memory: the turn reads every worker's state again
   * in its roster, and only this change is what the wake was decided on.
   */
  notice: Schema.optional(
    Schema.Struct({
      workerThreadId: Id,
      state: CoordinatorWorkerNotice,
      at: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
    }),
  ),
  /** Unmet host-checked done-when items a done-when wake is reporting. */
  unmet: Schema.optional(
    Schema.Array(
      Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(240)),
      ),
    ).pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(MAX_COORDINATOR_DONE_WHEN_ITEMS)),
    ),
  ),
});
export type CoordinatorWakeDecided = typeof CoordinatorWakeDecided.Type;

export const CoordinatorWakeSettled = Schema.Struct({
  wakeId: Schema.String.check(Schema.isGUID()),
  /** `held`: restart continuation left it for a person; it never starts by itself. */
  outcome: Schema.Literals(["started", "dropped", "held"]),
});
export type CoordinatorWakeSettled = typeof CoordinatorWakeSettled.Type;

/** Persisted marker that a coordinator's exact done-when condition held, so a restart does not re-arm it. */
export const CoordinatorDoneWhenSatisfied = Schema.Struct({
  conditionKey: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4_096)),
  ),
});
export type CoordinatorDoneWhenSatisfied = typeof CoordinatorDoneWhenSatisfied.Type;

/** Clears any prior done-when satisfied marker after the condition was edited, cleared, or stopped. */
export const CoordinatorDoneWhenReset = Schema.Struct({});
export type CoordinatorDoneWhenReset = typeof CoordinatorDoneWhenReset.Type;

export function registerCoordinatorWakeEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(COORDINATOR_WAKE_EVENT_NAMES.decided, 1, CoordinatorWakeDecided)
    .register(COORDINATOR_WAKE_EVENT_NAMES.settled, 1, CoordinatorWakeSettled)
    .register(COORDINATOR_WAKE_EVENT_NAMES.doneWhenSatisfied, 1, CoordinatorDoneWhenSatisfied)
    .register(COORDINATOR_WAKE_EVENT_NAMES.doneWhenReset, 1, CoordinatorDoneWhenReset);
}

/** A decided wake whose turn never started and that was never dropped. */
export interface OpenCoordinatorWake extends CoordinatorWakeDecided {
  readonly threadId: string;
}

/** Writes and reads the wake frames and done-when satisfaction markers. */
export interface CoordinatorWakes {
  readonly decided: (threadId: string, wake: CoordinatorWakeDecided) => void;
  readonly settled: (threadId: string, settled: CoordinatorWakeSettled) => void;
  /** Each thread's newest decided wake that is still open, oldest thread first. */
  readonly open: () => ReadonlyArray<OpenCoordinatorWake>;
  readonly markDoneWhenSatisfied?: (threadId: string, conditionKey: string) => void;
  readonly resetDoneWhen?: (threadId: string) => void;
  /** Satisfied done-when condition fingerprint per coordinator thread from journal replay. */
  readonly satisfiedDoneWhen?: () => ReadonlyMap<string, string>;
}

const REPLAY_BATCH_SIZE = 1_000;
const decodeDecided = Schema.decodeUnknownSync(CoordinatorWakeDecided, {
  onExcessProperty: "error",
});
const decodeSettled = Schema.decodeUnknownSync(CoordinatorWakeSettled, {
  onExcessProperty: "error",
});
const decodeDoneWhenSatisfied = Schema.decodeUnknownSync(CoordinatorDoneWhenSatisfied, {
  onExcessProperty: "error",
});

export function createCoordinatorWakeJournal(options: {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly connection: SqliteConnection;
  readonly clock: () => string;
  readonly uuid?: () => string;
}): CoordinatorWakes {
  const uuid = options.uuid ?? randomUUID;
  const append = (threadId: string, eventName: string, payload: unknown) => {
    options.journal.append({
      aggregate: { aggregateType: COORDINATOR_WAKE_AGGREGATE_TYPE, aggregateId: threadId },
      expectedVersion: readAggregateVersion(
        options.connection,
        COORDINATOR_WAKE_AGGREGATE_TYPE,
        threadId,
      ),
      events: [
        {
          eventId: uuid(),
          eventName,
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: options.clock() as never,
          payload,
        },
      ],
    });
  };
  return {
    decided: (threadId, wake) => append(threadId, COORDINATOR_WAKE_EVENT_NAMES.decided, wake),
    settled: (threadId, settled) => append(threadId, COORDINATOR_WAKE_EVENT_NAMES.settled, settled),
    markDoneWhenSatisfied: (threadId, conditionKey) =>
      append(threadId, COORDINATOR_WAKE_EVENT_NAMES.doneWhenSatisfied, { conditionKey }),
    resetDoneWhen: (threadId) => append(threadId, COORDINATOR_WAKE_EVENT_NAMES.doneWhenReset, {}),
    open: () => {
      const latest = new Map<string, OpenCoordinatorWake | undefined>();
      let afterSequence = 0;
      for (;;) {
        const batch = options.journal.replayAggregateType({
          aggregateType: COORDINATOR_WAKE_AGGREGATE_TYPE,
          afterSequence,
          limit: REPLAY_BATCH_SIZE,
        });
        for (const envelope of batch) {
          afterSequence = envelope.globalSequence;
          const threadId = String(envelope.aggregateId);
          try {
            if (envelope.eventName === COORDINATOR_WAKE_EVENT_NAMES.decided) {
              latest.delete(threadId);
              latest.set(threadId, { ...decodeDecided(envelope.payload), threadId });
            } else if (envelope.eventName === COORDINATOR_WAKE_EVENT_NAMES.settled) {
              const settled = decodeSettled(envelope.payload);
              if (latest.get(threadId)?.wakeId === settled.wakeId) latest.set(threadId, undefined);
            }
          } catch {
            // A frame this host cannot read says nothing it can act on.
          }
        }
        if (batch.length < REPLAY_BATCH_SIZE) break;
      }
      return [...latest.values()].filter((wake) => wake !== undefined);
    },
    satisfiedDoneWhen: () => {
      const satisfied = new Map<string, string>();
      let afterSequence = 0;
      for (;;) {
        const batch = options.journal.replayAggregateType({
          aggregateType: COORDINATOR_WAKE_AGGREGATE_TYPE,
          afterSequence,
          limit: REPLAY_BATCH_SIZE,
        });
        for (const envelope of batch) {
          afterSequence = envelope.globalSequence;
          const threadId = String(envelope.aggregateId);
          try {
            if (envelope.eventName === COORDINATOR_WAKE_EVENT_NAMES.doneWhenSatisfied) {
              satisfied.set(threadId, decodeDoneWhenSatisfied(envelope.payload).conditionKey);
            } else if (envelope.eventName === COORDINATOR_WAKE_EVENT_NAMES.doneWhenReset) {
              satisfied.delete(threadId);
            }
          } catch {
            // A frame this host cannot read says nothing it can act on.
          }
        }
        if (batch.length < REPLAY_BATCH_SIZE) break;
      }
      return satisfied;
    },
  };
}
