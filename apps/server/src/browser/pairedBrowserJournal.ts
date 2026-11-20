import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActorDeviceId,
  EventId,
  EventName,
  UtcTimestamp,
} from "@octant/contracts";
import {
  PAIRED_BROWSER_HOLD_AGGREGATE,
  PAIRED_BROWSER_HOLD_ENDED_EVENT,
  PAIRED_BROWSER_HOLD_STARTED_EVENT,
  decodePairedBrowserHoldEndedPayload,
  decodePairedBrowserHoldStartedPayload,
  type PairedBrowserEndReason,
  type PairedBrowserLeaseId,
  type PairedBrowserProfileKind,
} from "@octant/contracts/paired-browser-control";
import type { BrowserContextId, BrowserThreadId } from "@octant/contracts/browser-automation";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";

export type PairedBrowserJournalFact =
  | {
      readonly kind: "started";
      readonly deviceId: string;
      readonly threadId: BrowserThreadId;
      readonly contextId: BrowserContextId;
      readonly tabId: string;
      readonly profileKind: PairedBrowserProfileKind;
      readonly origin: string;
      readonly leaseId: PairedBrowserLeaseId;
    }
  | {
      readonly kind: "ended";
      readonly deviceId: string;
      readonly threadId: BrowserThreadId;
      readonly contextId: BrowserContextId;
      readonly tabId: string;
      readonly profileKind: PairedBrowserProfileKind;
      readonly origin: string;
      readonly leaseId: PairedBrowserLeaseId;
      readonly endReason: PairedBrowserEndReason;
      readonly eventCount: number;
      readonly frameCount: number;
    };

/**
 * Journals `browser.remote-hold-started@1` and `browser.remote-hold-ended@1`
 * on the thread's remote-hold aggregate with the device as `remote-device`
 * actor. Typed values, keys, coordinates, frames, and addresses after the
 * first are never recorded; thread purge erases these records.
 */
export function createPairedBrowserJournal(input: {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
}): (fact: PairedBrowserJournalFact) => void {
  return (fact) => {
    const aggregateId = Schema.decodeUnknownSync(AggregateId)(String(fact.threadId));
    const eventName =
      fact.kind === "started" ? PAIRED_BROWSER_HOLD_STARTED_EVENT : PAIRED_BROWSER_HOLD_ENDED_EVENT;
    const payload =
      fact.kind === "started"
        ? decodePairedBrowserHoldStartedPayload({
            threadId: fact.threadId,
            contextId: fact.contextId,
            tabId: fact.tabId,
            profileKind: fact.profileKind,
            origin: fact.origin,
            leaseId: fact.leaseId,
          })
        : decodePairedBrowserHoldEndedPayload({
            threadId: fact.threadId,
            contextId: fact.contextId,
            tabId: fact.tabId,
            profileKind: fact.profileKind,
            origin: fact.origin,
            leaseId: fact.leaseId,
            endReason: fact.endReason,
            eventCount: fact.eventCount,
            frameCount: fact.frameCount,
          });
    input.journal.append({
      aggregate: { aggregateType: PAIRED_BROWSER_HOLD_AGGREGATE, aggregateId },
      expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(
        readAggregateVersion(input.connection, PAIRED_BROWSER_HOLD_AGGREGATE, aggregateId),
      ),
      events: [
        {
          eventId: Schema.decodeUnknownSync(EventId)(input.uuid()),
          eventName: Schema.decodeUnknownSync(EventName)(eventName),
          eventVersion: 1,
          correlationId: Schema.decodeUnknownSync(CorrelationId)(input.uuid()),
          actor: {
            kind: "remote-device",
            actorId: Schema.decodeUnknownSync(ActorId)(fact.deviceId),
            deviceId: Schema.decodeUnknownSync(EventActorDeviceId)(fact.deviceId),
          },
          occurredAt: Schema.decodeUnknownSync(UtcTimestamp)(input.clock()),
          payload,
        },
      ],
    });
  };
}
