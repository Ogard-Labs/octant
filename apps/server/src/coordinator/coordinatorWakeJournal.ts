import { randomUUID } from "node:crypto";
import { CoordinatorWorkerState } from "@octant/contracts";
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
} as const;

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Id = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));

export const CoordinatorWakeDecided = Schema.Struct({
  wakeId: Schema.UUID,
  cause: Schema.Literal("message", "notice"),
  senderThreadId: Id,
  hop: Schema.Int.pipe(Schema.nonNegative()),
  /**
   * The worker change a notice wake is for. The rest of a coordinator's
   * pending notices stay in memory: the turn reads every worker's state again
   * in its roster, and only this change is what the wake was decided on.
   */
  notice: Schema.optional(
    Schema.Struct({
      workerThreadId: Id,
      state: CoordinatorWorkerState,
      at: Schema.String.pipe(Schema.maxLength(64)),
    }).annotations(strict),
  ),
}).annotations(strict);
export type CoordinatorWakeDecided = typeof CoordinatorWakeDecided.Type;

export const CoordinatorWakeSettled = Schema.Struct({
  wakeId: Schema.UUID,
  /** `held`: restart continuation left it for a person; it never starts by itself. */
  outcome: Schema.Literal("started", "dropped", "held"),
}).annotations(strict);
export type CoordinatorWakeSettled = typeof CoordinatorWakeSettled.Type;

export function registerCoordinatorWakeEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(COORDINATOR_WAKE_EVENT_NAMES.decided, 1, CoordinatorWakeDecided)
    .register(COORDINATOR_WAKE_EVENT_NAMES.settled, 1, CoordinatorWakeSettled);
}

/** A decided wake whose turn never started and that was never dropped. */
export interface OpenCoordinatorWake extends CoordinatorWakeDecided {
  readonly threadId: string;
}

/** Writes and reads the wake frames. */
export interface CoordinatorWakes {
  readonly decided: (threadId: string, wake: CoordinatorWakeDecided) => void;
  readonly settled: (threadId: string, settled: CoordinatorWakeSettled) => void;
  /** Each thread's newest decided wake that is still open, oldest thread first. */
  readonly open: () => ReadonlyArray<OpenCoordinatorWake>;
}

const REPLAY_BATCH_SIZE = 1_000;
const decodeDecided = Schema.decodeUnknownSync(CoordinatorWakeDecided);
const decodeSettled = Schema.decodeUnknownSync(CoordinatorWakeSettled);

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
  };
}
