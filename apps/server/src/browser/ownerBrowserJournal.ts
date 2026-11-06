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
  OWNER_BROWSER_AUDIT_AGGREGATE,
  OWNER_BROWSER_AUDIT_EVENT,
  decodeOwnerBrowserAuditRecord,
} from "@octant/contracts/owner-browser";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { OwnerBrowserAuditFact } from "./ownerBrowserControl";

export function createOwnerBrowserJournal(input: {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly localActorId: string;
  readonly uuid: () => string;
  readonly clock: () => string;
}): (fact: OwnerBrowserAuditFact) => void {
  return (fact) => {
    const payload = decodeOwnerBrowserAuditRecord({
      actingPrincipal: fact.principal,
      hostMemberId: fact.target.hostMemberId,
      threadId: fact.target.threadId,
      contextId: fact.target.contextId,
      controlId: fact.controlId,
      targetVersion: fact.target.targetVersion,
      documentRevision: fact.target.documentRevision,
      operation: fact.operation,
      phase: fact.phase,
      ...(fact.inputKind === undefined ? {} : { inputKind: fact.inputKind }),
    });
    const aggregateId = Schema.decodeUnknownSync(AggregateId)(String(payload.threadId));
    input.journal.append({
      aggregate: { aggregateType: OWNER_BROWSER_AUDIT_AGGREGATE, aggregateId },
      expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(
        readAggregateVersion(input.connection, OWNER_BROWSER_AUDIT_AGGREGATE, aggregateId),
      ),
      events: [
        {
          eventId: Schema.decodeUnknownSync(EventId)(input.uuid()),
          eventName: Schema.decodeUnknownSync(EventName)(OWNER_BROWSER_AUDIT_EVENT),
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
