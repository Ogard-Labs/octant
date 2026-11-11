import type { SqliteConnection } from "../persistence/sqlitePort";

const HOUR_MS = 60 * 60_000;

/** The host turn a coordinator wake or worker start began on a thread, and the hop of what began it. */
export interface CoordinatorHostTurn {
  readonly operationId: string;
  readonly hop: number;
}

/**
 * The counts a coordinator's bounds read, kept where a restart cannot clear
 * them (docs/design/coordinator-threads.md#bounds). Each method is one
 * statement against the host store, so a crash between a count and its
 * record loses at most that one record.
 */
export interface CoordinatorCounts {
  /** One `start` call by this coordinator, admitted or proposed. */
  readonly recordStart: (threadId: string, at: number) => void;
  readonly startsSince: (threadId: string, since: number) => number;
  /** One wake turn the host started on this thread. */
  readonly recordWake: (threadId: string, at: number) => void;
  readonly wakesSince: (threadId: string, since: number) => number;
  /** Replaces the thread's latest host-started turn. */
  readonly recordHostTurn: (threadId: string, turn: CoordinatorHostTurn) => void;
  readonly hostTurn: (threadId: string) => CoordinatorHostTurn | undefined;
}

/**
 * The coordinator counts in the host's own SQLite store (migration
 * `create_coordinator_count_store`). Times older than an hour bound nothing,
 * so each record prunes them for that thread; a purged thread's rows go with
 * the rest of its `thread_id` rows.
 */
export function createCoordinatorCountStore(connection: SqliteConnection): CoordinatorCounts {
  const record = (threadId: string, kind: "start" | "wake", at: number): void => {
    connection
      .prepare(`DELETE FROM coordinator_count_store WHERE thread_id = ? AND kind = ? AND at <= ?`)
      .run(threadId, kind, at - HOUR_MS);
    connection
      .prepare(`INSERT INTO coordinator_count_store (thread_id, kind, at) VALUES (?, ?, ?)`)
      .run(threadId, kind, at);
  };
  const since = (threadId: string, kind: "start" | "wake", from: number): number => {
    const row = connection
      .prepare(
        `SELECT COUNT(*) AS count FROM coordinator_count_store WHERE thread_id = ? AND kind = ? AND at > ?`,
      )
      .get(threadId, kind, from);
    return typeof row === "object" &&
      row !== null &&
      "count" in row &&
      (typeof row.count === "number" || typeof row.count === "bigint")
      ? Number(row.count)
      : 0;
  };
  return {
    recordStart: (threadId, at) => record(threadId, "start", at),
    startsSince: (threadId, from) => since(threadId, "start", from),
    recordWake: (threadId, at) => record(threadId, "wake", at),
    wakesSince: (threadId, from) => since(threadId, "wake", from),
    recordHostTurn: (threadId, turn) => {
      connection
        .prepare(
          `INSERT INTO coordinator_host_turn_store (thread_id, operation_id, hop) VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET operation_id = excluded.operation_id, hop = excluded.hop`,
        )
        .run(threadId, turn.operationId, turn.hop);
    },
    hostTurn: (threadId) => {
      const row = connection
        .prepare(`SELECT operation_id, hop FROM coordinator_host_turn_store WHERE thread_id = ?`)
        .get(threadId);
      return typeof row === "object" &&
        row !== null &&
        "operation_id" in row &&
        typeof row.operation_id === "string" &&
        "hop" in row &&
        typeof row.hop === "number"
        ? { operationId: row.operation_id, hop: row.hop }
        : undefined;
    },
  };
}
