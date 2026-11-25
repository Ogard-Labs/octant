/**
 * The journaled record of a message the person sent while a Work or Code
 * turn ran, which the runtime took into that turn. A queued message becomes a
 * turn of its own and that turn carries its prompt; a steered one entered a
 * turn that was already running, so without this record the transcript would
 * never show what the person said.
 *
 * Each record is its own one-event aggregate, as a steered child result is:
 * it never advances the thread's or the running turn's version, which the
 * turn's own writers check while the turn runs.
 */
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  decodeThreadMessageSteered,
  EventId,
  MAX_THREAD_MESSAGES_STEERED_PER_TURN,
  type EventActor,
  type ThreadMessageSteered,
  type ThreadMessageSteeredIntoTurn,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

export const THREAD_MESSAGE_STEERED = "thread.message-steered@1";
export const THREAD_MESSAGE_STEERING_AGGREGATE_TYPE = "thread-message-steering";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);

/** Journal reads stop here; a thread steered into this often lists no more. */
const MAX_STEERED_RECORDS_PER_THREAD = 1_000;

/** Journals the person's message as steered into the turn named by `turnKey`. */
export function journalThreadMessageSteered(
  journal: Pick<Journal, "append">,
  input: {
    readonly mode: ThreadMessageSteered["mode"];
    readonly threadId: string;
    readonly turnKey: string;
    readonly messageId: string;
    readonly body: string;
    readonly steeredAt: string;
    readonly uuid: () => string;
    readonly actor: EventActor;
  },
): ThreadMessageSteered {
  const record = decodeThreadMessageSteered({
    kind: "thread-message-steered",
    mode: input.mode,
    threadId: input.threadId,
    turnKey: input.turnKey,
    messageId: input.messageId,
    body: input.body,
    steeredAt: input.steeredAt,
  });
  journal.append({
    aggregate: {
      aggregateType: THREAD_MESSAGE_STEERING_AGGREGATE_TYPE,
      aggregateId: decodeAggregateId(input.uuid()),
    },
    expectedVersion: decodeAggregateVersion(0),
    events: [
      {
        eventId: decodeEventId(input.uuid()),
        eventName: THREAD_MESSAGE_STEERED,
        eventVersion: 1,
        correlationId: decodeCorrelationId(input.uuid()),
        actor: input.actor,
        occurredAt: record.steeredAt,
        payload: record,
      },
    ],
  });
  return record;
}

/** The record a journal row holds, or undefined for any other row. */
export function threadMessageSteeredFrom(envelope: {
  readonly eventName: string;
  readonly eventVersion: number;
  readonly payload: unknown;
}): ThreadMessageSteered | undefined {
  if (envelope.eventName !== THREAD_MESSAGE_STEERED || envelope.eventVersion !== 1)
    return undefined;
  try {
    return decodeThreadMessageSteered(envelope.payload);
  } catch {
    return undefined;
  }
}

/** Every steered message journaled for one thread, in journal order. */
export function readThreadMessagesSteered(
  journal: Pick<Journal, "replayAggregateTypeForThread">,
  threadId: string,
): ReadonlyArray<ThreadMessageSteered> {
  const records: ThreadMessageSteered[] = [];
  let afterSequence = 0;
  while (records.length < MAX_STEERED_RECORDS_PER_THREAD) {
    const batch = journal.replayAggregateTypeForThread({
      aggregateType: THREAD_MESSAGE_STEERING_AGGREGATE_TYPE,
      threadId,
      afterSequence,
      limit: 200,
    });
    for (const envelope of batch) {
      afterSequence = envelope.globalSequence;
      const record = threadMessageSteeredFrom(envelope);
      if (record !== undefined) records.push(record);
    }
    if (batch.length < 200) break;
  }
  return records;
}

/** A thread's newest `limit` steered messages, oldest first among them. */
export function readNewestThreadMessagesSteered(
  journal: Pick<Journal, "latestAggregateTypeForThread">,
  threadId: string,
  limit: number,
): ReadonlyArray<ThreadMessageSteered> {
  return journal
    .latestAggregateTypeForThread({
      aggregateType: THREAD_MESSAGE_STEERING_AGGREGATE_TYPE,
      threadId,
      limit: Math.min(Math.max(limit, 1), 1_000),
    })
    .flatMap((envelope) => {
      const record = threadMessageSteeredFrom(envelope);
      return record === undefined ? [] : [record];
    })
    .reverse();
}

/**
 * Adds one steered message to what a turn already carries. A record for a
 * message the turn already shows is the same one read again, so replay and a
 * rebuild leave the turn as it was.
 */
export function withThreadMessageSteered(
  existing: ReadonlyArray<ThreadMessageSteeredIntoTurn> | undefined,
  record: ThreadMessageSteered,
): ReadonlyArray<ThreadMessageSteeredIntoTurn> {
  const current = existing ?? [];
  if (current.some((entry) => entry.messageId === record.messageId)) return current;
  if (current.length >= MAX_THREAD_MESSAGES_STEERED_PER_TURN) return current;
  return [
    ...current,
    { messageId: record.messageId, body: record.body, steeredAt: record.steeredAt },
  ];
}

/** The steered messages one turn carries, folded from the thread's records. */
export function threadMessagesSteeredInto(
  records: ReadonlyArray<ThreadMessageSteered>,
  turnKey: string,
): ReadonlyArray<ThreadMessageSteeredIntoTurn> {
  return records
    .filter((record) => record.turnKey === turnKey)
    .reduce<ReadonlyArray<ThreadMessageSteeredIntoTurn>>(withThreadMessageSteered, []);
}
