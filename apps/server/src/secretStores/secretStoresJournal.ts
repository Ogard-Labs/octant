import { Schema } from "effect";
import { ActorId, AggregateId, CorrelationId, EventId, LOCAL_HOST_ID } from "@octant/contracts";
import {
  decodeSecretStoreJournalRecord,
  SECRET_STORE_AGGREGATE_TYPE,
  SECRET_STORE_EVENT_NAME,
  type SecretStoreJournalRecord,
} from "@octant/contracts/secret-stores";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);

/** One host-wide aggregate: links and reference changes read as one ordered history. */
const SECRET_STORES_AGGREGATE_ID = decodeAggregateId("00000000-0000-4000-8000-0000000000c8");

export interface SecretStoresJournal {
  /** Appends a record; throws when it cannot, so the caller can undo its change. */
  readonly record: (record: SecretStoreJournalRecord) => void;
}

/**
 * Journals when a secret store is linked or unlinked and each change to a
 * credential's reference. The payload is the decoded record, which has no
 * field for the value an item resolves to: it is not an input here at all.
 */
export function secretStoresJournal(options: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => string;
}): SecretStoresJournal {
  return {
    record: (record) => {
      const payload = decodeSecretStoreJournalRecord(record);
      options.journal.append({
        aggregate: {
          aggregateType: SECRET_STORE_AGGREGATE_TYPE,
          aggregateId: SECRET_STORES_AGGREGATE_ID,
        },
        expectedVersion: readAggregateVersion(
          options.connection,
          SECRET_STORE_AGGREGATE_TYPE,
          String(SECRET_STORES_AGGREGATE_ID),
        ),
        events: [
          {
            eventId: decodeEventId(options.uuid()),
            eventName: SECRET_STORE_EVENT_NAME,
            eventVersion: 1,
            hostId: LOCAL_HOST_ID,
            correlationId: decodeCorrelationId(options.uuid()),
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: options.now(),
            payload,
          },
        ],
      });
    },
  };
}
