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
  BrowserSessionGranted,
  BrowserSessionHeld,
  BrowserSessionResumed,
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
const decodeGranted = Schema.decodeUnknownSync(BrowserSessionGranted);
const decodeHeld = Schema.decodeUnknownSync(BrowserSessionHeld);
const decodeResumed = Schema.decodeUnknownSync(BrowserSessionResumed);
const SESSION_AGGREGATE = "browser-session-permission";
/** A 30-day grant attested once per host lifetime stays far below this. */
const MAX_GRANT_EVENTS = 1_000;

export function browserSessionGrantJournal(options: {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly personActor: EventActor;
  readonly hostActor: EventActor;
}) {
  return (event: {
    readonly kind: keyof typeof BROWSER_SESSION_EVENT_NAMES;
    readonly grant: BrowserSessionGrant;
    readonly windowId?: WindowId;
  }): void => {
    const aggregateType = SESSION_AGGREGATE;
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
          actor: event.windowId === undefined ? options.hostActor : options.personActor,
          occurredAt: decodeUtcTimestamp(new Date(options.now()).toISOString()),
          payload: event,
        },
      ],
    });
  };
}

/**
 * The grants a restart may restore: those whose whole history is a person's
 * grant followed only by clean-close attestations, the newest one unconsumed.
 *
 * A grant with no revocation on record is not proof that it was never revoked:
 * a revocation whose write failed and a host that was killed both leave the
 * same history. Only `held`, written by a clean close for a grant still live
 * at that moment, proves it. Anything else, including a record that does not
 * decode or a gap in the versions, restores nothing for that grant.
 */
export function heldBrowserSessionGrants(
  journal: Pick<Journal, "aggregateVersions" | "replayAggregate">,
): () => ReadonlyArray<{ readonly grant: BrowserSessionGrant; readonly windowId: WindowId }> {
  return () =>
    journal.aggregateVersions(SESSION_AGGREGATE).flatMap(({ aggregateId, aggregateVersion }) => {
      // granted, then held/resumed pairs: a history ending in `held` is even.
      if (aggregateVersion % 2 !== 0 || aggregateVersion > MAX_GRANT_EVENTS) return [];
      try {
        const events = journal.replayAggregate({
          aggregateType: SESSION_AGGREGATE,
          aggregateId,
          afterVersion: 0,
          limit: MAX_GRANT_EVENTS,
        });
        const [first, ...later] = events;
        if (
          first === undefined ||
          events.length !== aggregateVersion ||
          events.some((event, index) => event.aggregateVersion !== index + 1) ||
          first.eventName !== BROWSER_SESSION_EVENT_NAMES.granted ||
          first.actor.kind !== "local-user"
        )
          return [];
        const { grant, windowId } = decodeGranted(first.payload);
        if (windowId === undefined || String(grant.grantId) !== aggregateId) return [];
        for (const [index, event] of later.entries()) {
          const attests = index % 2 === 0;
          if (
            event.eventName !==
            (attests ? BROWSER_SESSION_EVENT_NAMES.held : BROWSER_SESSION_EVENT_NAMES.resumed)
          )
            return [];
          const payload = attests ? decodeHeld(event.payload) : decodeResumed(event.payload);
          if (String(payload.grant.grantId) !== aggregateId) return [];
        }
        return [{ grant, windowId }];
      } catch {
        return [];
      }
    });
}
