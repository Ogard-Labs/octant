import {
  AggregateId,
  AggregateVersion,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  THREAD_NATIVE_SETUP_AGGREGATE,
  THREAD_NATIVE_SETUP_EVENT_NAMES,
  decodeThreadNativeSetupChanged,
  type ThreadNativeSetupChoice,
} from "@octant/contracts/thread-native-setup";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import { readThreadNativeSetup } from "../persistence/threadNativeSetupProjection";
import type { Journal } from "../persistence/journal";
import {
  ConcurrencyConflict,
  EventPayloadInvalid,
  JournalInputInvalid,
} from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const MAX_APPEND_ATTEMPTS = 3;

export interface ThreadNativeSetupStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * A thread's own choice about its key provider's native setup. The journal is
 * the record; the projection answers. The host resolves it again for every
 * session it starts or resumes, so a change reaches the thread's next turn.
 */
export class ThreadNativeSetupStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;

  constructor(options: ThreadNativeSetupStoreOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  /** The thread's own choice; `inherit` when it has none. */
  get(threadId: string): ThreadNativeSetupChoice {
    return readThreadNativeSetup(this.#connection, threadId) ?? "inherit";
  }

  set(threadId: string, choice: ThreadNativeSetupChoice): "recorded" | "refused" {
    let payload: ReturnType<typeof decodeThreadNativeSetupChanged>;
    try {
      payload = decodeThreadNativeSetupChanged({ threadId, choice });
    } catch {
      return "refused";
    }
    if (this.get(threadId) === choice) return "recorded";
    return this.#append(threadId, payload) ? "recorded" : "refused";
  }

  #append(threadId: string, payload: unknown): boolean {
    const aggregateId = decodeAggregateId(threadId);
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, THREAD_NATIVE_SETUP_AGGREGATE, aggregateId),
      );
      try {
        const eventId = decodeEventId(this.#uuid());
        this.#journal.append({
          aggregate: { aggregateType: THREAD_NATIVE_SETUP_AGGREGATE, aggregateId },
          expectedVersion,
          events: [
            {
              eventId,
              eventName: decodeEventName(THREAD_NATIVE_SETUP_EVENT_NAMES.changed),
              eventVersion: 1,
              correlationId: eventId,
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload,
            },
          ],
        });
        return true;
      } catch (error) {
        if (error instanceof ConcurrencyConflict) continue;
        if (error instanceof JournalInputInvalid || error instanceof EventPayloadInvalid) {
          return false;
        }
        throw error;
      }
    }
    return false;
  }
}
