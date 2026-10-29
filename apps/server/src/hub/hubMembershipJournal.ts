// Journals every change to hub membership on this host, with the principal
// that petitioned. The journal is the audit trail; hubStateStore holds the
// current state.

import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  HUB_MEMBERSHIP_CHANGED,
  UtcTimestamp,
  decodeHubMembershipChangedPayload,
  type AuditActingPrincipal,
  type EventActor,
  type HubMembershipChangedPayload,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";

const HUB_MEMBERSHIP_AGGREGATE = "hub-membership";
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface HubMembershipJournalOptions {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  /** This host's id: the one aggregate its membership changes are kept in. */
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
      return { kind: "system", actorId };
  }
}

export function createHubMembershipJournal(
  options: HubMembershipJournalOptions,
): (change: HubMembershipChangedPayload) => void {
  const selectHead = options.connection.prepare(
    `SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?`,
  );
  return (change) => {
    const payload = decodeHubMembershipChangedPayload(change);
    const aggregateId = options.hostId();
    const head = selectHead.get(HUB_MEMBERSHIP_AGGREGATE, aggregateId) as
      | { readonly aggregate_version: number }
      | undefined;
    try {
      options.journal.append({
        aggregate: {
          aggregateType: HUB_MEMBERSHIP_AGGREGATE,
          aggregateId: decodeAggregateId(aggregateId),
        },
        expectedVersion: decodeAggregateVersion(head?.aggregate_version ?? 0),
        events: [
          {
            eventId: decodeEventId(options.uuid()),
            eventName: decodeEventName(HUB_MEMBERSHIP_CHANGED),
            eventVersion: 1,
            correlationId: decodeCorrelationId(options.uuid()),
            actor: actorFor(payload.actingPrincipal, options.localActorId),
            occurredAt: decodeTimestamp(options.clock()),
            payload,
          },
        ],
      });
    } catch {
      // The change already took effect; a journal that cannot take it is
      // reported rather than undone.
      console.warn("Octant could not record a hub membership change.");
    }
  };
}
