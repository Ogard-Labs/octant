import {
  THREAD_RETENTION_EVENT_NAMES,
  decodeThreadRetentionThreadPurged,
  decodeThreadRetentionWindowSet,
  type EventEnvelope,
  type OctantMode,
  type ProjectId,
  type RetentionScope,
  type RetentionWindow,
  type ThreadPurgeTombstone,
  type ThreadRetentionState,
  type ThreadRetentionThreadId,
  type ThreadRetentionWindowEntry,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const THREAD_RETENTION_AGGREGATE = "thread-retention";
export const THREAD_RETENTION_AGGREGATE_ID = Schema.decodeUnknownSync(
  Schema.UUID.pipe(Schema.brand("AggregateId")),
)("00000000-0000-4000-8000-000000000032");

interface WindowRow {
  readonly scope_kind: "host" | "project" | "thread";
  readonly scope_key: string;
  readonly window_json: string;
  readonly updated_at: string;
  readonly aggregate_version: number;
}

interface TombstoneRow {
  readonly mode: OctantMode;
  readonly thread_id: string;
  readonly project_id: string | null;
  readonly purged_at: string;
}

export class ThreadRetentionProjection implements Projection {
  readonly name = "thread-retention";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM thread_retention_projection;
      DELETE FROM thread_purge_tombstone;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1 || event.aggregateType !== THREAD_RETENTION_AGGREGATE) return;
    if (event.eventName === THREAD_RETENTION_EVENT_NAMES.windowSet) {
      const payload = decodeThreadRetentionWindowSet(event.payload);
      connection
        .prepare(
          `INSERT INTO thread_retention_projection (
            scope_kind, scope_key, window_json, updated_at, aggregate_version, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (scope_kind, scope_key) DO UPDATE SET
            window_json = excluded.window_json,
            updated_at = excluded.updated_at,
            aggregate_version = excluded.aggregate_version,
            last_sequence = excluded.last_sequence`,
        )
        .run(
          payload.scope.kind,
          scopeKey(payload.scope),
          JSON.stringify(payload.window),
          payload.updatedAt,
          event.aggregateVersion,
          event.globalSequence,
        );
      return;
    }
    if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
      const payload = decodeThreadRetentionThreadPurged(event.payload);
      connection
        .prepare(
          `INSERT INTO thread_purge_tombstone (
            mode, thread_id, project_id, purged_at, last_sequence
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (mode, thread_id) DO UPDATE SET
            project_id = excluded.project_id,
            purged_at = excluded.purged_at,
            last_sequence = excluded.last_sequence`,
        )
        .run(
          payload.mode,
          payload.threadId,
          payload.projectId ?? null,
          payload.purgedAt,
          event.globalSequence,
        );
    }
  }
}

export function readThreadRetentionState(connection: SqliteConnection): ThreadRetentionState {
  const windowRows = connection
    .prepare(
      `SELECT scope_kind, scope_key, window_json, updated_at, aggregate_version
       FROM thread_retention_projection ORDER BY scope_kind, scope_key`,
    )
    .all() as ReadonlyArray<WindowRow>;
  const tombstoneRows = connection
    .prepare(
      `SELECT mode, thread_id, project_id, purged_at FROM thread_purge_tombstone
       ORDER BY purged_at ASC, mode ASC, thread_id ASC`,
    )
    .all() as ReadonlyArray<TombstoneRow>;
  return {
    windows: windowRows.map(decodeWindowRow),
    tombstones: tombstoneRows.map(decodeTombstoneRow),
  };
}

export function readThreadPurgeTombstone(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
): ThreadPurgeTombstone | undefined {
  const row = connection
    .prepare(
      `SELECT mode, thread_id, project_id, purged_at
       FROM thread_purge_tombstone WHERE mode = ? AND thread_id = ?`,
    )
    .get(mode, String(threadId)) as TombstoneRow | undefined;
  return row === undefined ? undefined : decodeTombstoneRow(row);
}

export function scopeKey(scope: RetentionScope): string {
  if (scope.kind === "host") return "host";
  if (scope.kind === "project") return String(scope.projectId);
  return `${scope.mode}:${scope.threadId}`;
}

function decodeWindowRow(row: WindowRow): ThreadRetentionWindowEntry {
  return {
    scope: decodeScope(row.scope_kind, row.scope_key),
    window: JSON.parse(row.window_json) as RetentionWindow,
    updatedAt: row.updated_at as ThreadRetentionWindowEntry["updatedAt"],
    version: row.aggregate_version as ThreadRetentionWindowEntry["version"],
  };
}

function decodeTombstoneRow(row: TombstoneRow): ThreadPurgeTombstone {
  return {
    mode: row.mode,
    threadId: row.thread_id as ThreadRetentionThreadId,
    ...(row.project_id === null ? {} : { projectId: row.project_id as ProjectId }),
    purgedAt: row.purged_at as ThreadPurgeTombstone["purgedAt"],
  };
}

function decodeScope(kind: WindowRow["scope_kind"], key: string): RetentionScope {
  if (kind === "host") return { kind: "host" };
  if (kind === "project") return { kind: "project", projectId: key as ProjectId };
  const separator = key.indexOf(":");
  return {
    kind: "thread",
    mode: key.slice(0, separator) as OctantMode,
    threadId: key.slice(separator + 1) as ThreadRetentionThreadId,
  };
}
