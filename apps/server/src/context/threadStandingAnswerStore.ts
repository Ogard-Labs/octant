import {
  AggregateId,
  EventActor,
  EventId,
  EventName,
  THREAD_STANDING_ANSWER_AGGREGATE,
  THREAD_STANDING_ANSWER_RECORDED,
  UtcTimestamp,
  decodeThreadStandingAnswerRecorded,
  type EventActor as EventActorValue,
  type ThreadStandingAnswerRecorded,
  type ThreadStandingAnswerSubject,
} from "@octant/contracts";
import { threadStandingAnswerCovers } from "@octant/domain/untrusted-content-policy";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * A thread holds at most one answer per subject and mark state, so its whole
 * history is a handful of events; the bound only stops a damaged journal from
 * being read without end.
 */
const MAX_ANSWER_EVENTS = 64;

/**
 * The asks a person answers once for a thread: "this thread may start
 * helpers", "this thread may send files into its desktop". Each answer is
 * journaled as `thread.standing-answer-recorded@1` on an aggregate named by
 * the thread, so it survives a host restart and is erased with the thread.
 *
 * Answers are read from the journal each time rather than cached: a thread
 * purge removes them underneath this store, and a cached answer would then
 * outlive the thread it was given for.
 */
export class ThreadStandingAnswerStore {
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;

  constructor(options: {
    readonly journal: Pick<Journal, "append" | "replayAggregate">;
    readonly connection: SqliteConnection;
    readonly uuid: () => string;
    readonly clock: () => string;
    readonly actor: EventActorValue;
  }) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  /** Whether the person's answer for this thread covers `subject` as the thread stands now. */
  covers(threadId: string, subject: ThreadStandingAnswerSubject, markedNow: boolean): boolean {
    return threadStandingAnswerCovers(this.#answers(threadId), subject, markedNow);
  }

  /**
   * Keeps an approval the person just gave. `threadMarked` is whether the
   * thread had read outside content when they answered. An answer the thread
   * already holds journals nothing.
   */
  record(threadId: string, subject: ThreadStandingAnswerSubject, threadMarked: boolean): void {
    const aggregateId = decodeAggregateId(threadId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.covers(threadId, subject, threadMarked)) return;
      try {
        this.#journal.append({
          aggregate: { aggregateType: THREAD_STANDING_ANSWER_AGGREGATE, aggregateId },
          expectedVersion: readAggregateVersion(
            this.#connection,
            THREAD_STANDING_ANSWER_AGGREGATE,
            aggregateId,
          ),
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: decodeEventName(THREAD_STANDING_ANSWER_RECORDED),
              eventVersion: 1,
              correlationId: this.#uuid(),
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload: { threadId: aggregateId, subject, threadMarked },
            },
          ],
        });
        return;
      } catch (error) {
        // Another turn of the thread wrote an answer first; read it and decide again.
        if (!(error instanceof ConcurrencyConflict)) throw error;
      }
    }
  }

  #answers(threadId: string): ReadonlyArray<ThreadStandingAnswerRecorded> {
    let aggregateId: string;
    try {
      aggregateId = decodeAggregateId(threadId);
    } catch {
      return [];
    }
    return this.#journal
      .replayAggregate({
        aggregateType: THREAD_STANDING_ANSWER_AGGREGATE,
        aggregateId,
        afterVersion: 0,
        limit: MAX_ANSWER_EVENTS,
      })
      .filter((event) => event.eventName === THREAD_STANDING_ANSWER_RECORDED)
      .map((event) => decodeThreadStandingAnswerRecorded(event.payload));
  }
}
