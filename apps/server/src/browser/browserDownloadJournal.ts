import {
  AggregateId,
  AggregateVersion,
  BROWSER_DOWNLOAD_AGGREGATE_TYPE,
  BROWSER_DOWNLOAD_EVENT_NAMES,
  decodeBrowserDownloadRefused,
  decodeBrowserDownloadSaved,
  decodeEventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type BrowserDownloadRefusalReason,
  type BrowserThreadId,
  type CorrelationId,
  type ProviderInstanceId,
} from "@octant/contracts";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const MAX_APPEND_ATTEMPTS = 3;

export interface BrowserDownloadJournalContext {
  readonly threadId: BrowserThreadId;
  readonly origin: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly correlationId: CorrelationId;
}

export interface BrowserDownloadRecorder {
  readonly saved: (
    context: BrowserDownloadJournalContext,
    file: {
      readonly path: string;
      readonly sizeBytes: number;
      readonly mediaType: string;
      readonly sha256: string;
    },
  ) => void;
  readonly refused: (
    context: BrowserDownloadJournalContext,
    file: {
      readonly name: string;
      readonly sizeBytes?: number | undefined;
      readonly mediaType?: string | undefined;
      readonly reason: BrowserDownloadRefusalReason;
    },
  ) => void;
}

export interface BrowserDownloadJournalOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
}

/**
 * Records what became of the files an agent's Browser downloaded: saved into a
 * workspace, or refused or denied. One aggregate per thread, and never bytes.
 */
export function createBrowserDownloadJournal(
  options: BrowserDownloadJournalOptions,
): BrowserDownloadRecorder {
  const append = (
    context: BrowserDownloadJournalContext,
    eventName: string,
    payload: unknown,
    occurredAt: string,
  ): void => {
    const aggregateId = decodeAggregateId(String(context.threadId));
    for (let attempt = 1; ; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(options.connection, BROWSER_DOWNLOAD_AGGREGATE_TYPE, aggregateId),
      );
      try {
        options.journal.append({
          aggregate: { aggregateType: BROWSER_DOWNLOAD_AGGREGATE_TYPE, aggregateId },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(options.uuid()),
              eventName: decodeEventName(eventName),
              eventVersion: 1,
              correlationId: context.correlationId,
              actor: decodeEventActor({
                kind: "agent",
                actorId: context.providerInstanceId,
                providerInstanceId: context.providerInstanceId,
                threadId: context.threadId,
              }),
              occurredAt: decodeTimestamp(occurredAt),
              payload,
            },
          ],
        });
        return;
      } catch (error) {
        if (!(error instanceof ConcurrencyConflict) || attempt >= MAX_APPEND_ATTEMPTS) throw error;
      }
    }
  };
  return {
    saved: (context, file) => {
      const savedAt = options.clock();
      append(
        context,
        BROWSER_DOWNLOAD_EVENT_NAMES.saved,
        decodeBrowserDownloadSaved({
          threadId: context.threadId,
          origin: context.origin,
          path: file.path,
          sizeBytes: file.sizeBytes,
          mediaType: file.mediaType,
          sha256: file.sha256,
          savedAt,
        }),
        savedAt,
      );
    },
    refused: (context, file) => {
      const refusedAt = options.clock();
      append(
        context,
        BROWSER_DOWNLOAD_EVENT_NAMES.refused,
        decodeBrowserDownloadRefused({
          threadId: context.threadId,
          origin: context.origin,
          name: file.name === "" ? "download" : file.name.slice(0, 256),
          ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
          ...(file.mediaType === undefined || file.mediaType === ""
            ? {}
            : { mediaType: file.mediaType }),
          reason: file.reason,
          refusedAt,
        }),
        refusedAt,
      );
    },
  };
}
