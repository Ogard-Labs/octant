import { Schema } from "effect";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  UtcTimestamp,
} from "@octant/contracts";
import {
  OWNER_APPROVAL_AUDIT_AGGREGATE,
  OWNER_APPROVAL_AUDIT_EVENT,
  decodeOwnerApprovalAuditRecord,
  type OwnerApprovalAuditRecord,
} from "@octant/contracts/owner-approvals";
import type { Journal } from "../persistence/journal";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";

/** A request identity can be claimed once, across restarts, before provider delivery. */
export function createOwnerApprovalJournal(input: {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly localActorId: string;
  readonly uuid: () => string;
  readonly clock: () => string;
}): (fact: OwnerApprovalAuditRecord) => void {
  return (fact) => {
    const payload = decodeOwnerApprovalAuditRecord(fact);
    const aggregateId = Schema.decodeUnknownSync(AggregateId)(String(payload.requestId));
    input.journal.append({
      aggregate: { aggregateType: OWNER_APPROVAL_AUDIT_AGGREGATE, aggregateId },
      expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(
        payload.phase === "admitted"
          ? 0
          : readAggregateVersion(input.connection, OWNER_APPROVAL_AUDIT_AGGREGATE, aggregateId),
      ),
      events: [
        {
          eventId: Schema.decodeUnknownSync(EventId)(input.uuid()),
          eventName: Schema.decodeUnknownSync(EventName)(OWNER_APPROVAL_AUDIT_EVENT),
          eventVersion: 1,
          correlationId: Schema.decodeUnknownSync(CorrelationId)(input.uuid()),
          actor: { kind: "system", actorId: Schema.decodeUnknownSync(ActorId)(input.localActorId) },
          occurredAt: Schema.decodeUnknownSync(UtcTimestamp)(input.clock()),
          payload,
        },
      ],
    });
  };
}
