import {
  ActorId,
  AggregateId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  type EventActor,
} from "@octant/contracts";
import {
  decodeThreadSecretJournalRecord,
  THREAD_SECRET_AGGREGATE_TYPE,
  THREAD_SECRET_EVENT_NAME,
  type ThreadSecretJournalRecord,
  type ThreadSecretKind,
  type ThreadSecretLifetime,
} from "@octant/contracts/thread-secrets";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const REPLAY_PAGE = 1_000;
const LOCAL_PERSON: EventActor = {
  kind: "local-user",
  actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
};

export interface ThreadSecretsJournal {
  /** Appends every record or none; throws when it cannot, so nothing is granted unrecorded. */
  readonly record: (
    threadId: string,
    records: ReadonlyArray<ThreadSecretJournalRecord>,
    actor?: EventActor,
  ) => void;
  /** What an earlier host left: the secrets it never ended, and the last lifetime per name. */
  readonly history: () => ThreadSecretsHistory;
}

export interface ThreadSecretsHistory {
  readonly open: ReadonlyArray<ThreadSecretJournalRecord>;
  /** Keyed by {@link lifetimeKey}. */
  readonly lastLifetimes: ReadonlyMap<string, ThreadSecretLifetime>;
}

/** A name asked for as a token says nothing about the same name as an account password. */
export function lifetimeKey(kind: ThreadSecretKind, secretName: string): string {
  return `${kind}/${secretName}`;
}

/**
 * One aggregate per thread, so a thread's purge erases its secrets' records
 * with it. The payload is the decoded record, which has no field for a value.
 */
export function threadSecretsJournal(options: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => string;
}): ThreadSecretsJournal {
  return {
    record: (threadId, records, actor = LOCAL_PERSON) => {
      const payloads = records.map((record) => decodeThreadSecretJournalRecord(record));
      options.journal.append({
        aggregate: {
          aggregateType: THREAD_SECRET_AGGREGATE_TYPE,
          aggregateId: decodeAggregateId(threadId),
        },
        expectedVersion: readAggregateVersion(
          options.connection,
          THREAD_SECRET_AGGREGATE_TYPE,
          threadId,
        ),
        events: payloads.map((payload) => ({
          eventId: decodeEventId(options.uuid()),
          eventName: THREAD_SECRET_EVENT_NAME,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(options.uuid()),
          actor,
          occurredAt: options.now(),
          payload,
        })),
      });
    },
    history: () => {
      const open = new Map<string, ThreadSecretJournalRecord>();
      const lastLifetimes = new Map<string, ThreadSecretLifetime>();
      let afterSequence = 0;
      for (;;) {
        const page = options.journal.replayAggregateType({
          aggregateType: THREAD_SECRET_AGGREGATE_TYPE,
          afterSequence,
          limit: REPLAY_PAGE,
        });
        for (const event of page) {
          afterSequence = event.globalSequence;
          const record = readable(event.payload);
          if (record === undefined) continue;
          if (record.name === "thread-secret.granted") {
            open.set(record.secretId, record);
            lastLifetimes.set(lifetimeKey(record.kind, record.secretName), record.lifetime);
          } else if (record.name !== "thread-secret.used") {
            open.delete(record.secretId);
          }
        }
        if (page.length < REPLAY_PAGE) return { open: [...open.values()], lastLifetimes };
      }
    },
  };
}

/** One record this host cannot read keeps the others from nothing. */
function readable(payload: unknown): ThreadSecretJournalRecord | undefined {
  try {
    return decodeThreadSecretJournalRecord(payload);
  } catch {
    return undefined;
  }
}
