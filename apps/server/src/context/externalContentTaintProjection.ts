import {
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  decodeContentIngestedPayload,
  decodeThreadExternalContentTaint,
  type EventEnvelope,
  type ThreadExternalContentTaint,
} from "@octant/contracts";
import {
  emptyThreadContentTaint,
  originTaintsThread,
  projectThreadContentTaint,
  type ThreadContentTaintEvent,
} from "@octant/domain/untrusted-content-policy";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";

export const THREAD_EXTERNAL_CONTENT_TAINT_PROJECTION = "thread-external-content-taint";

interface TaintRow {
  readonly ingested_sources_json: string;
  readonly external_content_ingested: number;
}

/**
 * Rebuildable thread-lifetime projection for `thread.external-content-ingested@1`.
 * Session, turn, and restart boundaries never clear taint; only an explicit
 * thread purge erases the derived rows with the journal events that produced them.
 */
export class ExternalContentTaintProjection implements Projection {
  readonly name = THREAD_EXTERNAL_CONTENT_TAINT_PROJECTION;
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM thread_external_content_ingestion_projection;
      DELETE FROM thread_external_content_taint_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (
      event.eventVersion !== 1 ||
      event.eventName !== THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested ||
      event.aggregateType !== THREAD_EXTERNAL_CONTENT_AGGREGATE
    ) {
      return;
    }
    const payload = decodeContentIngestedPayload(event.payload);
    if (String(payload.threadId) !== String(event.aggregateId)) {
      throw new Error("External-content ingestion aggregate does not match its thread.");
    }

    connection
      .prepare(
        `
        INSERT INTO thread_external_content_ingestion_projection (
          thread_id, content_reference, source_label, origin, last_sequence
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (thread_id, content_reference) DO NOTHING
      `,
      )
      .run(
        String(payload.threadId),
        payload.contentReference,
        payload.provenance.sourceLabel,
        payload.provenance.origin,
        event.globalSequence,
      );

    if (!originTaintsThread(payload.provenance.origin)) {
      return;
    }

    const next = projectThreadContentTaint(
      readThreadExternalContentTaint(connection, payload.threadId),
      {
        kind: "content-ingested",
        provenance: payload.provenance,
      },
    );
    connection
      .prepare(
        `
        INSERT INTO thread_external_content_taint_projection (
          thread_id,
          external_content_ingested,
          ingested_sources_json,
          aggregate_version,
          last_sequence
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (thread_id) DO UPDATE SET
          external_content_ingested = excluded.external_content_ingested,
          ingested_sources_json = excluded.ingested_sources_json,
          aggregate_version = excluded.aggregate_version,
          last_sequence = excluded.last_sequence
        WHERE excluded.last_sequence >= thread_external_content_taint_projection.last_sequence
      `,
      )
      .run(
        String(payload.threadId),
        next.externalContentIngested ? 1 : 0,
        JSON.stringify(next.ingestedSources),
        event.aggregateVersion,
        event.globalSequence,
      );
  }
}

export function readThreadExternalContentTaint(
  connection: SqliteConnection,
  threadId: string,
): ThreadExternalContentTaint {
  const row = connection
    .prepare(
      `
      SELECT external_content_ingested, ingested_sources_json
      FROM thread_external_content_taint_projection
      WHERE thread_id = ?
    `,
    )
    .get(String(threadId)) as TaintRow | undefined;
  if (row === undefined) return emptyThreadContentTaint();
  return decodeThreadExternalContentTaint({
    externalContentIngested: row.external_content_ingested === 1,
    ingestedSources: JSON.parse(row.ingested_sources_json),
  });
}

export function hasThreadExternalContentReference(
  connection: SqliteConnection,
  threadId: string,
  contentReference: string,
): boolean {
  return (
    connection
      .prepare(
        `
        SELECT 1 AS present
        FROM thread_external_content_ingestion_projection
        WHERE thread_id = ? AND content_reference = ?
      `,
      )
      .get(String(threadId), contentReference) !== undefined
  );
}

export function applyProvenanceToThreadTaint(
  initial: ThreadExternalContentTaint,
  events: ReadonlyArray<ThreadContentTaintEvent>,
): ThreadExternalContentTaint {
  return events.reduce((state, event) => projectThreadContentTaint(state, event), initial);
}
