import {
  AggregateId,
  AggregateVersion,
  EventActor,
  EventId,
  EventName,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  UtcTimestamp,
  decodeWindowId,
  type EventActor as EventActorValue,
  type ThreadExternalContentClearOutcome,
  type ThreadExternalContentState,
} from "@octant/contracts";
import { decideExternalContentClear } from "@octant/domain/untrusted-content-policy";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { readThreadIdModes } from "../persistence/threadIdentity";
import { readThreadExternalContentState } from "./externalContentTaintProjection";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface ClearExternalContentInput {
  readonly threadId: unknown;
  /** The authenticated window, never a value the request carried. */
  readonly windowId: unknown;
  /** The aggregate version the person was shown. */
  readonly expectedVersion: unknown;
  readonly principal: "local-window" | "remote-device" | "host";
  /** The thread's turn as its own mode reports it; see `decideExternalContentClear`. */
  readonly turn: "idle" | "active" | "unconfirmed" | "unknown";
}

export interface ExternalContentClearStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * Appends `thread.external-content-cleared@1`: a person's record that they
 * reviewed what a thread read. It takes the mark away and nothing else, so the
 * model keeps what it read and the next ingestion marks the thread again.
 *
 * This is the only writer of that event, and only the local-only route holds
 * it. Expected failures are values, and a refusal journals nothing.
 */
export class ExternalContentClearStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;
  readonly #eventName = decodeEventName(THREAD_EXTERNAL_CONTENT_EVENT_NAMES.cleared);

  constructor(options: ExternalContentClearStoreOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  read(threadId: string): ThreadExternalContentState {
    return readThreadExternalContentState(this.#connection, threadId);
  }

  clear(input: ClearExternalContentInput): ThreadExternalContentClearOutcome {
    const windowId = decoded(decodeWindowId, input.windowId);
    const aggregateId = decoded(decodeAggregateId, input.threadId);
    const state = aggregateId === undefined ? undefined : this.read(String(aggregateId));
    const decision = decideExternalContentClear({
      // A local window always has an identity; one that cannot be read is not one.
      principal: windowId === undefined ? "remote-device" : input.principal,
      turn: state === undefined ? "unknown" : input.turn,
      tainted: state?.externalContentIngested ?? false,
      shownVersion:
        typeof input.expectedVersion === "number" && Number.isSafeInteger(input.expectedVersion)
          ? input.expectedVersion
          : -1,
      currentVersion: state?.version ?? 0,
      threadIdShared:
        aggregateId !== undefined &&
        readThreadIdModes(this.#connection, String(aggregateId)).length > 1,
    });
    if (decision.kind === "refuse") {
      // A caller with no authority here, or a window that cannot reach the
      // thread, learns nothing about what it read.
      return state === undefined ||
        decision.reason === "unauthorized" ||
        decision.reason === "thread-unavailable"
        ? { kind: "refused", reason: decision.reason }
        : { kind: "refused", reason: decision.reason, state };
    }
    if (windowId === undefined || aggregateId === undefined || state === undefined) {
      return { kind: "refused", reason: "thread-unavailable" };
    }
    if (decision.kind === "already-clear") return { kind: "already-clear", state };

    try {
      this.#journal.append({
        aggregate: { aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE, aggregateId },
        expectedVersion: decodeAggregateVersion(state.version),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: this.#eventName,
            eventVersion: 1,
            correlationId: this.#uuid(),
            actor: this.#actor,
            occurredAt: decodeTimestamp(this.#clock()),
            payload: {
              threadId: aggregateId,
              windowId,
              clearedSources: state.sources.map((source) => source.sourceLabel),
              ingestionCount: state.ingestionCount,
            },
          },
        ],
      });
    } catch (error) {
      // An ingestion landed between the read and the append: the person has
      // not seen it, so the version they named no longer covers the thread.
      if (error instanceof ConcurrencyConflict) {
        return { kind: "refused", reason: "stale", state: this.read(String(aggregateId)) };
      }
      throw error;
    }
    return { kind: "cleared", state: this.read(String(aggregateId)) };
  }
}

function decoded<T>(decode: (value: unknown) => T, value: unknown): T | undefined {
  try {
    return decode(value);
  } catch {
    return undefined;
  }
}
