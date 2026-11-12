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
  BROWSER_DOWNLOAD_PERMISSION_EVENT,
  type BrowserDownloadPermissionChanged,
} from "@octant/contracts/browser-download-permissions";
import type { EventActor, WindowId } from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { readAggregateVersion } from "../persistence/chatProjection";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);

export function browserDownloadPermissionJournal(options: {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly personActor: EventActor;
  readonly hostActor: EventActor;
  /** The paired device a reviewing scope is, when it is one; its record names the device. */
  readonly deviceActor?: (scopeId: WindowId) => EventActor | undefined;
}) {
  return (event: BrowserDownloadPermissionChanged): void => {
    const aggregateType = "browser-download-permission";
    const aggregateId = decodeAggregateId(event.permission.permissionId);
    options.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion: decodeAggregateVersion(
        readAggregateVersion(options.connection, aggregateType, aggregateId),
      ),
      events: [
        {
          eventId: decodeEventId(options.uuid()),
          eventName: decodeEventName(BROWSER_DOWNLOAD_PERMISSION_EVENT),
          eventVersion: 1,
          correlationId: decodeCorrelationId(event.permission.permissionId),
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
