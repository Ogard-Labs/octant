import {
  MAX_APPROVAL_OUTSIDE_CONTENT_SOURCES,
  MAX_NAMED_INGESTED_SOURCES,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  decodeApprovalOutsideContent,
  decodeContentClearedPayload,
  decodeContentIngestedPayload,
  decodeThreadExternalContentState,
  decodeThreadExternalContentTaint,
  SHIELD_WATCHER_LABELS,
  type ApprovalOutsideContent,
  type EventEnvelope,
  type ShieldWatcherLabel,
  type ThreadExternalContentState,
  type ThreadExternalContentTaint,
} from "@octant/contracts";
import {
  emptyThreadContentTaint,
  originTaintsThread,
  projectThreadContentTaint,
  type ThreadContentTaintEvent,
} from "@octant/domain/untrusted-content-policy";
import {
  SHIELD_WATCHER_SOURCE_PREFIX,
  shieldWatcherLabelOfSource,
} from "@octant/domain/shield-watcher-policy";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";

export const THREAD_EXTERNAL_CONTENT_TAINT_PROJECTION = "thread-external-content-taint";

interface TaintRow {
  readonly ingested_sources_json: string;
  readonly external_content_ingested: number;
}

/**
 * Rebuildable thread-lifetime projection for `thread.external-content-ingested@1`
 * and `thread.external-content-cleared@1`. Session, turn, and restart
 * boundaries never clear taint. A person's clear does: it forgets the thread's
 * ingestions, so a reference the thread read before the clear marks it again
 * when it returns. An explicit thread purge erases the derived rows with the
 * journal events that produced them.
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
    if (event.eventVersion !== 1 || event.aggregateType !== THREAD_EXTERNAL_CONTENT_AGGREGATE) {
      return;
    }
    if (
      event.eventName !== THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested &&
      event.eventName !== THREAD_EXTERNAL_CONTENT_EVENT_NAMES.cleared
    ) {
      return;
    }
    // A clear forgets every ingestion before it. An older event applied again
    // must not bring a forgotten reference back, or the same content would
    // never mark the thread after the clear; nor may an older clear unmark a
    // thread that has read more since.
    if (event.globalSequence <= appliedThroughSequence(connection, String(event.aggregateId))) {
      return;
    }
    if (event.eventName === THREAD_EXTERNAL_CONTENT_EVENT_NAMES.cleared) {
      applyCleared(connection, event);
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
          thread_id, content_reference, source_label, origin, last_sequence, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (thread_id, content_reference) DO NOTHING
      `,
      )
      .run(
        String(payload.threadId),
        payload.contentReference,
        payload.provenance.sourceLabel,
        payload.provenance.origin,
        event.globalSequence,
        event.occurredAt,
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

function applyCleared(connection: SqliteConnection, event: EventEnvelope): void {
  const payload = decodeContentClearedPayload(event.payload);
  const threadId = String(payload.threadId);
  if (threadId !== String(event.aggregateId)) {
    throw new Error("External-content clear aggregate does not match its thread.");
  }
  connection
    .prepare("DELETE FROM thread_external_content_ingestion_projection WHERE thread_id = ?")
    .run(threadId);
  connection
    .prepare(
      `
      INSERT INTO thread_external_content_taint_projection (
        thread_id,
        external_content_ingested,
        ingested_sources_json,
        aggregate_version,
        last_sequence
      ) VALUES (?, 0, '[]', ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        external_content_ingested = excluded.external_content_ingested,
        ingested_sources_json = excluded.ingested_sources_json,
        aggregate_version = excluded.aggregate_version,
        last_sequence = excluded.last_sequence
    `,
    )
    .run(threadId, event.aggregateVersion, event.globalSequence);
}

/**
 * The sequence of the last tainting ingestion or clear applied for a thread.
 * Events of one thread are applied in order, so anything at or below it has
 * been applied already.
 */
function appliedThroughSequence(connection: SqliteConnection, threadId: string): number {
  const row = connection
    .prepare(
      "SELECT last_sequence FROM thread_external_content_taint_projection WHERE thread_id = ?",
    )
    .get(threadId) as { readonly last_sequence: number } | undefined;
  return row?.last_sequence ?? 0;
}

interface SourceRow {
  readonly source_label: string;
  readonly ingestion_count: number;
  readonly first_ingested_at: string | null;
  readonly last_ingested_at: string | null;
}

/**
 * What a person reviews before clearing a thread: each source with how often
 * and when it was read since the last clear, and the aggregate version a clear
 * must name. Content references stay in the projection.
 */
export function readThreadExternalContentState(
  connection: SqliteConnection,
  threadId: string,
): ThreadExternalContentState {
  const tainting = "origin IN ('tool-result', 'external-content')";
  const sources = connection
    .prepare(
      `
      SELECT source_label,
             COUNT(*) AS ingestion_count,
             MIN(ingested_at) AS first_ingested_at,
             MAX(ingested_at) AS last_ingested_at
      FROM thread_external_content_ingestion_projection
      WHERE thread_id = ? AND ${tainting}
      GROUP BY source_label
      ORDER BY MIN(last_sequence)
      LIMIT ?
    `,
    )
    .all(String(threadId), MAX_NAMED_INGESTED_SOURCES) as ReadonlyArray<SourceRow>;
  const total = connection
    .prepare(
      `
      SELECT COUNT(*) AS ingestion_count
      FROM thread_external_content_ingestion_projection
      WHERE thread_id = ? AND ${tainting}
    `,
    )
    .get(String(threadId)) as { readonly ingestion_count: number };
  return decodeThreadExternalContentState({
    threadId: String(threadId),
    externalContentIngested: readThreadExternalContentTaint(connection, threadId)
      .externalContentIngested,
    version: readAggregateVersion(connection, THREAD_EXTERNAL_CONTENT_AGGREGATE, String(threadId)),
    ingestionCount: total.ingestion_count,
    sources: sources.map((row) => ({
      sourceLabel: row.source_label,
      ingestionCount: row.ingestion_count,
      ...(row.first_ingested_at === null ? {} : { firstIngestedAt: row.first_ingested_at }),
      ...(row.last_ingested_at === null ? {} : { lastIngestedAt: row.last_ingested_at }),
    })),
  });
}

/**
 * The sources an approval on a marked thread names, most recently read first,
 * or nothing when the thread is not marked. A prompt that says only "approve
 * once" left a person unable to tell why the call could not be remembered or
 * what it might be acting on.
 */
export function readApprovalOutsideContent(
  connection: SqliteConnection,
  threadId: string,
): ApprovalOutsideContent | undefined {
  if (!readThreadExternalContentTaint(connection, threadId).externalContentIngested) {
    return undefined;
  }
  const tainting = "origin IN ('tool-result', 'external-content')";
  const sources = connection
    .prepare(
      `
      SELECT source_label,
             COUNT(*) AS ingestion_count,
             MIN(ingested_at) AS first_ingested_at,
             MAX(ingested_at) AS last_ingested_at
      FROM thread_external_content_ingestion_projection
      WHERE thread_id = ? AND ${tainting}
      GROUP BY source_label
      ORDER BY MAX(last_sequence) DESC
      LIMIT ?
    `,
    )
    .all(String(threadId), MAX_APPROVAL_OUTSIDE_CONTENT_SOURCES) as ReadonlyArray<SourceRow>;
  const total = connection
    .prepare(
      `
      SELECT COUNT(DISTINCT source_label) AS source_count
      FROM thread_external_content_ingestion_projection
      WHERE thread_id = ? AND ${tainting}
    `,
    )
    .get(String(threadId)) as { readonly source_count: number };
  return decodeApprovalOutsideContent({
    sources: sources.map((row) => ({
      sourceLabel: row.source_label,
      ingestionCount: row.ingestion_count,
      ...(row.first_ingested_at === null ? {} : { firstIngestedAt: row.first_ingested_at }),
      ...(row.last_ingested_at === null ? {} : { lastIngestedAt: row.last_ingested_at }),
    })),
    sourceCount: total.source_count,
  });
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

/**
 * What Octant Shield's Watcher found in what the thread read since its mark
 * was last cleared: label kinds only, in the contract's order.
 */
export function readShieldWatcherLabels(
  connection: SqliteConnection,
  threadId: string,
): ReadonlyArray<ShieldWatcherLabel> {
  const rows = connection
    .prepare(
      `
      SELECT DISTINCT source_label
      FROM thread_external_content_ingestion_projection
      WHERE thread_id = ? AND substr(source_label, 1, ?) = ?
    `,
    )
    .all(
      String(threadId),
      SHIELD_WATCHER_SOURCE_PREFIX.length,
      SHIELD_WATCHER_SOURCE_PREFIX,
    ) as ReadonlyArray<{ readonly source_label: string }>;
  const found = new Set(rows.map((row) => shieldWatcherLabelOfSource(row.source_label)));
  return SHIELD_WATCHER_LABELS.filter((label) => found.has(label));
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
