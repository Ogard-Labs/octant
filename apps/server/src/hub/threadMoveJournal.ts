// Journals each step of a thread move on the host where it happens, one
// aggregate per move. The journal is the record of who moved what and when;
// threadMoveStateStore holds what a restart resumes from. A step that already
// took effect is reported, never undone, when the journal cannot take it.

import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  THREAD_MOVE_EVENT_NAMES,
  ThreadHandoverStarted,
  ThreadMoveCommittedEvent,
  ThreadMoveFailed,
  ThreadMoveStarted,
  ThreadMovedIn,
  ThreadMovedOut,
  UtcTimestamp,
  type HandoverId,
  type MovedThreadReference,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { ThreadMoveRecorder } from "./threadMoveService";

export const THREAD_MOVE_AGGREGATE = "thread-move";

export function registerThreadMoveEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(THREAD_MOVE_EVENT_NAMES.moveStarted, 1, ThreadMoveStarted)
    .register(THREAD_MOVE_EVENT_NAMES.movedIn, 1, ThreadMovedIn)
    .register(THREAD_MOVE_EVENT_NAMES.moveCommitted, 1, ThreadMoveCommittedEvent)
    .register(THREAD_MOVE_EVENT_NAMES.movedOut, 1, ThreadMovedOut)
    .register(THREAD_MOVE_EVENT_NAMES.moveFailed, 1, ThreadMoveFailed)
    .register(THREAD_MOVE_EVENT_NAMES.handoverStarted, 1, ThreadHandoverStarted);
}

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface ThreadMoveJournalOptions {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly localActorId: string;
  readonly uuid: () => string;
  readonly clock: () => string;
}

/**
 * The recorder the move service writes through. Every step is the person's
 * own act (an owner-signed move or a window action) carried out by this host,
 * so each is journaled as this host's system actor.
 */
export function createThreadMoveJournal(
  options: ThreadMoveJournalOptions,
): ThreadMoveRecorder & ThreadHandoverRecorder {
  const selectHead = options.connection.prepare(
    `SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?`,
  );
  const append = (moveId: string, eventName: string, payload: unknown) => {
    const head = selectHead.get(THREAD_MOVE_AGGREGATE, moveId) as
      | { readonly aggregate_version: number }
      | undefined;
    try {
      options.journal.append({
        aggregate: { aggregateType: THREAD_MOVE_AGGREGATE, aggregateId: decodeAggregateId(moveId) },
        expectedVersion: decodeAggregateVersion(head?.aggregate_version ?? 0),
        events: [
          {
            eventId: decodeEventId(options.uuid()),
            eventName: decodeEventName(eventName),
            eventVersion: 1,
            correlationId: decodeCorrelationId(options.uuid()),
            actor: { kind: "system", actorId: decodeActorId(options.localActorId) },
            occurredAt: decodeTimestamp(options.clock()),
            payload,
          },
        ],
      });
    } catch {
      console.warn("Octant could not record a step of a thread move.");
    }
  };
  const now = () => decodeTimestamp(options.clock());
  return {
    moveStarted: (input) =>
      append(String(input.moveId), THREAD_MOVE_EVENT_NAMES.moveStarted, {
        ...input,
        startedAt: now(),
      }),
    movedIn: (input) =>
      append(String(input.moveId), THREAD_MOVE_EVENT_NAMES.movedIn, { ...input, arrivedAt: now() }),
    moveCommitted: (input) =>
      append(String(input.moveId), THREAD_MOVE_EVENT_NAMES.moveCommitted, {
        ...input,
        committedAt: now(),
      }),
    movedOut: (input) =>
      append(String(input.moveId), THREAD_MOVE_EVENT_NAMES.movedOut, {
        ...input,
        movedOutAt: now(),
      }),
    moveFailed: (input) =>
      append(String(input.moveId), THREAD_MOVE_EVENT_NAMES.moveFailed, {
        ...input,
        failedAt: now(),
      }),
    handoverStarted: (input) =>
      append(String(input.handoverId), THREAD_MOVE_EVENT_NAMES.handoverStarted, {
        ...input,
        startedAt: now(),
      }),
  };
}

/** The handover's freeze, recorded before anything is committed. */
export interface ThreadHandoverRecorder {
  readonly handoverStarted: (input: {
    readonly handoverId: HandoverId;
    readonly thread: MovedThreadReference;
    readonly branch: string;
  }) => void;
}
