// Journals every delegation a host sends or receives, with the principal that
// petitioned. The journal is the audit trail; delegationStateStore holds the
// current state.

import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  HUB_DELEGATION_RECORDED,
  UtcTimestamp,
  decodeHubDelegationRecordedPayload,
  type AuditActingPrincipal,
  type EventActor,
  type HubDelegationRecordedPayload,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";

const HUB_DELEGATION_AGGREGATE = "hub-delegation";
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface DelegationJournalOptions {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  /** This host's id: the one aggregate its delegations are kept in. */
  readonly hostId: () => string;
  readonly localActorId: string;
  readonly uuid: () => string;
  readonly clock: () => string;
}

function actorFor(principal: AuditActingPrincipal, localActorId: string): EventActor {
  const actorId = decodeActorId(localActorId);
  switch (principal.kind) {
    case "local-window":
      return { kind: "local-user", actorId };
    case "remote-device":
      return { kind: "remote-device", actorId, deviceId: principal.deviceId };
    case "hub":
    case "peer":
    case "owner-unlock":
      return { kind: "system", actorId };
  }
}

export function createDelegationJournal(
  options: DelegationJournalOptions,
): (change: HubDelegationRecordedPayload) => void {
  const selectHead = options.connection.prepare(
    `SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?`,
  );
  return (change) => {
    const payload = decodeHubDelegationRecordedPayload(change);
    const aggregateId = options.hostId();
    const head = selectHead.get(HUB_DELEGATION_AGGREGATE, aggregateId) as
      | { readonly aggregate_version: number }
      | undefined;
    try {
      options.journal.append({
        aggregate: {
          aggregateType: HUB_DELEGATION_AGGREGATE,
          aggregateId: decodeAggregateId(aggregateId),
        },
        expectedVersion: decodeAggregateVersion(head?.aggregate_version ?? 0),
        events: [
          {
            eventId: decodeEventId(options.uuid()),
            eventName: decodeEventName(HUB_DELEGATION_RECORDED),
            eventVersion: 1,
            correlationId: decodeCorrelationId(options.uuid()),
            actor: actorFor(payload.actingPrincipal, options.localActorId),
            occurredAt: decodeTimestamp(options.clock()),
            payload,
          },
        ],
      });
    } catch {
      // The delegation already took effect; a journal that cannot take it is
      // reported rather than undone.
      console.warn("Octant could not record a delegation.");
    }
  };
}
