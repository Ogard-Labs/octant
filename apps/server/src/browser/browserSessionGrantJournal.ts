import {
  AggregateId,
  CorrelationId,
  EventId,
  EventName,
  decodeAggregateVersion,
  decodeUtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import {
  BROWSER_SESSION_EVENT_NAMES,
  type BrowserSessionGrant,
} from "@octant/contracts/browser-session-grants";
import type { WindowId, EventActor } from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { readAggregateVersion } from "../persistence/chatProjection";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);

export function browserSessionGrantJournal(options: {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly personActor: EventActor;
  readonly hostActor: EventActor;
  /** The paired device a reviewing scope is, when it is one; its record names the device. */
  readonly deviceActor?: (scopeId: WindowId) => EventActor | undefined;
}) {
  return (event: {
    readonly kind: "granted" | "revoked" | "expired" | "changed";
    readonly grant: BrowserSessionGrant;
    readonly windowId?: WindowId;
  }): void => {
    const aggregateType = "browser-session-permission";
    const aggregateId = decodeAggregateId(event.grant.grantId);
    options.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion: decodeAggregateVersion(
        readAggregateVersion(options.connection, aggregateType, aggregateId),
      ),
      events: [
        {
          eventId: decodeEventId(options.uuid()),
          eventName: decodeEventName(BROWSER_SESSION_EVENT_NAMES[event.kind]),
          eventVersion: 1,
          correlationId: decodeCorrelationId(event.grant.grantId),
          actor:
            event.windowId === undefined
              ? options.hostActor
              : (options.deviceActor?.(event.windowId) ?? options.personActor),
          occurredAt: decodeUtcTimestamp(new Date(options.now()).toISOString()),
          payload: event,
        },
      ],
    });
  };
}
