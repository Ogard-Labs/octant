import { Schema } from "effect";
import {
  ActorId,
  AggregateId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  type HostOAuthJournalRecord,
  type HostOAuthTermsAcknowledgment,
} from "@octant/contracts";
import { decodeHostOAuthJournalRecord } from "@octant/contracts/host-oauth";
import type { Journal } from "../../persistence/journal";
import type { SqliteConnection } from "../../persistence/sqlitePort";
import { readAggregateVersion } from "../../persistence/chatProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../../shellService";

const AGGREGATE_TYPE = "host-oauth";
const AGGREGATE_ID = "8f0c1a2b-3d4e-4f50-8a61-7b8c9d0e1f2a";
const EVENT_NAME = "host-oauth.recorded@1";

const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);

/**
 * Persist public sign-in records on the event journal. The payload is the
 * decoded record, which cannot carry an access token, refresh token, code,
 * or verifier.
 */
export function hostOAuthEventJournal(options: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => string;
}): {
  readonly append: (record: HostOAuthJournalRecord) => void;
  readonly acknowledgments: () => readonly HostOAuthTermsAcknowledgment[];
} {
  return {
    append: (record) => {
      const decoded = decodeHostOAuthJournalRecord(record);
      const expectedVersion = readAggregateVersion(
        options.connection,
        AGGREGATE_TYPE,
        AGGREGATE_ID,
      );
      options.journal.append({
        aggregate: {
          aggregateType: AGGREGATE_TYPE,
          aggregateId: decodeAggregateId(AGGREGATE_ID),
        },
        expectedVersion,
        events: [
          {
            eventId: decodeEventId(options.uuid()),
            eventName: EVENT_NAME,
            eventVersion: 1,
            hostId: LOCAL_HOST_ID,
            correlationId: decodeCorrelationId(options.uuid()),
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: options.now(),
            payload: decoded,
          },
        ],
      });
    },
    acknowledgments: () => readAcknowledgments(options.connection),
  };
}

function readAcknowledgments(
  connection: SqliteConnection,
): readonly HostOAuthTermsAcknowledgment[] {
  const rows = connection
    .prepare(
      `SELECT payload_json FROM event_journal WHERE event_name = ? ORDER BY global_sequence ASC`,
    )
    .all(EVENT_NAME) as readonly { readonly payload_json: string }[];
  const acknowledgments: HostOAuthTermsAcknowledgment[] = [];
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
      const record = decodeHostOAuthJournalRecord(payload);
      if (record.name === "host-oauth.terms-acknowledged") acknowledgments.push(record);
    } catch {
      continue;
    }
  }
  return acknowledgments;
}
