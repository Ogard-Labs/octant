import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ActorId, AggregateId, CorrelationId, EventId, LOCAL_HOST_ID } from "@octant/contracts";
import { PendingQuestionDeferral } from "@octant/contracts/pending-requests";
import { readAggregateVersion } from "./persistence/chatProjection";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

const aggregateType = "pending-question-deferral";
const aggregateId = Schema.decodeUnknownSync(AggregateId)("00000000-0000-4000-8000-0000000000d9");

/** Rebuilt attention preferences only. Question bodies, drafts and answers stay with their owners. */
export function pendingQuestionDeferrals(journal: Journal, connection: SqliteConnection) {
  const untilByKey = new Map<string, string>();
  const apply = (change: PendingQuestionDeferral) => {
    if (change.until === null || Date.parse(change.until) <= Date.now())
      untilByKey.delete(change.key);
    else untilByKey.set(change.key, change.until);
  };
  let afterVersion = 0;
  while (true) {
    const page = journal.replayAggregate({ aggregateType, aggregateId, afterVersion, limit: 1000 });
    for (const event of page) {
      apply(Schema.decodeUnknownSync(PendingQuestionDeferral)(event.payload));
      afterVersion = event.aggregateVersion;
    }
    if (page.length < 1000) break;
  }
  return {
    read: (key: string) => untilByKey.get(key),
    record: (change: PendingQuestionDeferral) => {
      const payload = Schema.decodeUnknownSync(PendingQuestionDeferral)(change);
      journal.append({
        aggregate: { aggregateType, aggregateId },
        expectedVersion: readAggregateVersion(connection, aggregateType, String(aggregateId)),
        events: [
          {
            eventId: Schema.decodeUnknownSync(EventId)(randomUUID()),
            eventName: "pending-question.deferred@1",
            eventVersion: 1,
            hostId: LOCAL_HOST_ID,
            correlationId: Schema.decodeUnknownSync(CorrelationId)(randomUUID()),
            actor: {
              kind: "local-user",
              actorId: Schema.decodeUnknownSync(ActorId)(OCTANT_LOCAL_ACTOR_ID),
            },
            occurredAt: new Date().toISOString(),
            payload,
          },
        ],
      });
      apply(payload);
      for (const [key, until] of untilByKey)
        if (Date.parse(until) <= Date.now()) untilByKey.delete(key);
    },
  };
}
