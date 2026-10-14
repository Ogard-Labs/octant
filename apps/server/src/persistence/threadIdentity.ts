import type { OctantMode } from "@octant/contracts";
import type { SqliteConnection } from "./sqlitePort";

/** The journal aggregate each mode's thread lives under. */
export const THREAD_AGGREGATE_TYPE_BY_MODE: Readonly<Record<OctantMode, string>> = {
  chat: "chat-thread",
  work: "work-thread",
  code: "code-thread",
};

const MODE_BY_THREAD_AGGREGATE_TYPE = new Map<string, OctantMode>(
  (["chat", "work", "code"] as const).map((mode) => [THREAD_AGGREGATE_TYPE_BY_MODE[mode], mode]),
);

export function threadModeOfAggregateType(aggregateType: string): OctantMode | undefined {
  return MODE_BY_THREAD_AGGREGATE_TYPE.get(aggregateType);
}

/**
 * The modes whose journaled thread answers to this id.
 *
 * Chat, Work, and Code threads share one id space. The outside-content mark,
 * turn metrics, harness sessions, attachments, worktree receipts, and the
 * thread purge all key by the bare id, so a second mode's thread under the
 * same id would share the first one's mark and rows, and purging it would
 * erase them.
 */
export function readThreadIdModes(
  connection: SqliteConnection,
  threadId: string,
): ReadonlyArray<OctantMode> {
  const rows = connection
    .prepare(
      `SELECT DISTINCT aggregate_type FROM event_journal
       WHERE aggregate_type IN (?, ?, ?) AND aggregate_id = ?`,
    )
    .all(
      THREAD_AGGREGATE_TYPE_BY_MODE.chat,
      THREAD_AGGREGATE_TYPE_BY_MODE.work,
      THREAD_AGGREGATE_TYPE_BY_MODE.code,
      threadId,
    ) as ReadonlyArray<{ readonly aggregate_type: string }>;
  const modes: OctantMode[] = [];
  for (const row of rows) {
    const mode = threadModeOfAggregateType(row.aggregate_type);
    if (mode !== undefined) modes.push(mode);
  }
  return modes;
}

/** Whether a thread of a mode other than `mode` already holds this id. */
export function threadIdHeldByAnotherMode(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: string,
): boolean {
  return readThreadIdModes(connection, threadId).some((holder) => holder !== mode);
}
