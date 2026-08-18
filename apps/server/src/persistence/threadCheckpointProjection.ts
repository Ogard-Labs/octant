import {
  ThreadCheckpointForgotten,
  ThreadCheckpointMarked,
  ThreadCheckpointRestored,
  decodeThreadCheckpoint,
  type EventEnvelope,
  type ThreadCheckpoint,
  type ThreadCheckpointId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const THREAD_CHECKPOINT_AGGREGATE = "thread-checkpoint";
export const THREAD_CHECKPOINT_MARKED = "checkpoint.marked@1";
export const THREAD_CHECKPOINT_FORGOTTEN = "checkpoint.forgotten@1";
export const THREAD_CHECKPOINT_RESTORED = "checkpoint.restored@1";

const decodeMarked = Schema.decodeUnknownSync(ThreadCheckpointMarked);
const decodeForgotten = Schema.decodeUnknownSync(ThreadCheckpointForgotten);
const decodeRestored = Schema.decodeUnknownSync(ThreadCheckpointRestored);

interface ThreadCheckpointRow {
  readonly checkpoint_json: string;
  readonly aggregate_version: number;
}

/**
 * The read model behind the checkpoint list a thread shows.
 *
 * Every event carries the whole checkpoint as the server settled it, so the
 * projection writes rather than merges: a replay in sequence order arrives at
 * the same row whether it runs once or a hundred times. `thread_id` is stored
 * beside the record because the only question this projection is ever asked is
 * "what did this thread mark", and a marker is not worth a scan of every
 * checkpoint on the host to answer it.
 */
export class ThreadCheckpointProjection implements Projection {
  readonly name = "thread-checkpoint";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM thread_checkpoint_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    const checkpoint =
      event.eventName === THREAD_CHECKPOINT_MARKED
        ? decodeMarked(event.payload).checkpoint
        : event.eventName === THREAD_CHECKPOINT_FORGOTTEN
          ? decodeForgotten(event.payload).checkpoint
          : event.eventName === THREAD_CHECKPOINT_RESTORED
            ? decodeRestored(event.payload).checkpoint
            : undefined;
    if (checkpoint === undefined) return;

    connection
      .prepare(
        `
      INSERT OR REPLACE INTO thread_checkpoint_projection (
        checkpoint_id,
        thread_id,
        mode,
        lifecycle,
        checkpoint_json,
        aggregate_version,
        last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        String(checkpoint.id),
        String(checkpoint.anchor.threadId),
        checkpoint.anchor.mode,
        checkpoint.lifecycle,
        JSON.stringify(checkpoint),
        event.aggregateVersion,
        event.globalSequence,
      );
  }

  createTable(connection: SqliteConnection): void {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS thread_checkpoint_projection (
        checkpoint_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL DEFAULT 0,
        last_sequence INTEGER NOT NULL DEFAULT 0
      )
    `);
  }
}

export function readThreadCheckpoint(
  connection: SqliteConnection,
  checkpointId: ThreadCheckpointId,
): ThreadCheckpoint | undefined {
  const row = connection
    .prepare(
      `SELECT checkpoint_json, aggregate_version FROM thread_checkpoint_projection
       WHERE checkpoint_id = ?`,
    )
    .get(String(checkpointId)) as ThreadCheckpointRow | undefined;
  return row === undefined ? undefined : decodeRow(row);
}

/**
 * Every checkpoint a thread carries, oldest first, including forgotten ones.
 * Forgotten markers stay readable so a client that is holding one learns it was
 * put away rather than watching it silently disappear.
 */
export function readThreadCheckpoints(
  connection: SqliteConnection,
  threadId: string,
): ReadonlyArray<ThreadCheckpoint> {
  const rows = connection
    .prepare(
      `SELECT checkpoint_json, aggregate_version FROM thread_checkpoint_projection
       WHERE thread_id = ? ORDER BY last_sequence ASC`,
    )
    .all(String(threadId)) as ReadonlyArray<ThreadCheckpointRow>;
  return rows.map(decodeRow);
}

function decodeRow(row: ThreadCheckpointRow): ThreadCheckpoint {
  const stored = decodeThreadCheckpoint(JSON.parse(row.checkpoint_json));
  return stored.version === row.aggregate_version
    ? stored
    : decodeThreadCheckpoint({ ...stored, version: row.aggregate_version });
}
