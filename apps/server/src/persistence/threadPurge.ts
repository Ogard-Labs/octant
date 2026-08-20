import {
  decodeChatThread,
  decodeContextSubjectRef,
  type OctantMode,
  type ProjectId,
  type ThreadRetentionThreadId,
} from "@octant/contracts";
import { purgeAgentRunSubjectContent } from "./agentRunContentStore";
import { purgeThreadContent } from "./chatProjection";
import { purgeContextSubjectContent } from "./contextProjection";
import { THREAD_RETENTION_AGGREGATE } from "./threadRetentionProjection";
import type { SqliteConnection } from "./sqlitePort";

const THREAD_AGGREGATE_BY_MODE: Readonly<Record<OctantMode, string>> = {
  chat: "chat-thread",
  work: "work-thread",
  code: "code-thread",
};

interface AggregateKey {
  readonly aggregateType: string;
  readonly aggregateId: string;
}

export function erasePurgedThread(input: {
  readonly connection: SqliteConnection;
  readonly mode: OctantMode;
  readonly threadId: ThreadRetentionThreadId;
}): void {
  const threadId = String(input.threadId);
  const aggregates = collectOwnedAggregates(input.connection, input.mode, threadId);
  input.connection.pragma("foreign_keys = OFF");
  try {
    purgeDerivedContent(input.connection, input.mode, threadId);
    deleteThreadScopedProjectionRows(input.connection, threadId);
    deleteJournalEvents(input.connection, aggregates);
    input.connection.exec(
      `DELETE FROM aggregate_heads WHERE NOT EXISTS (
         SELECT 1 FROM event_journal
         WHERE event_journal.aggregate_type = aggregate_heads.aggregate_type
           AND event_journal.aggregate_id = aggregate_heads.aggregate_id
       )`,
    );
  } finally {
    input.connection.pragma("foreign_keys = ON");
  }
}

export function listProjectedThreadSubjects(connection: SqliteConnection): ReadonlyArray<{
  readonly mode: OctantMode;
  readonly threadId: ThreadRetentionThreadId;
  readonly projectId?: ProjectId;
  readonly updatedAt: string;
}> {
  const chat = connection
    .prepare(`SELECT thread_id, thread_json, updated_at FROM chat_thread_projection`)
    .all() as ReadonlyArray<{
    readonly thread_id: string;
    readonly thread_json: string;
    readonly updated_at: string;
  }>;
  const code = connection
    .prepare(`SELECT thread_id, project_id, updated_at FROM code_thread_projection`)
    .all() as ReadonlyArray<{
    readonly thread_id: string;
    readonly project_id: string;
    readonly updated_at: string;
  }>;
  const subjects: Array<{
    readonly mode: OctantMode;
    readonly threadId: ThreadRetentionThreadId;
    readonly projectId?: ProjectId;
    readonly updatedAt: string;
  }> = [];
  for (const row of chat) {
    const thread = decodeChatThread(JSON.parse(row.thread_json));
    subjects.push({
      mode: "chat",
      threadId: row.thread_id as ThreadRetentionThreadId,
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      updatedAt: row.updated_at,
    });
  }
  for (const row of code) {
    subjects.push({
      mode: "code",
      threadId: row.thread_id as ThreadRetentionThreadId,
      projectId: row.project_id as ProjectId,
      updatedAt: row.updated_at,
    });
  }
  return subjects;
}

export function threadProjectionExists(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
): boolean {
  if (mode === "chat") {
    return (
      connection
        .prepare(`SELECT 1 AS present FROM chat_thread_projection WHERE thread_id = ?`)
        .get(String(threadId)) !== undefined
    );
  }
  if (mode === "code") {
    return (
      connection
        .prepare(`SELECT 1 AS present FROM code_thread_projection WHERE thread_id = ?`)
        .get(String(threadId)) !== undefined
    );
  }
  return (
    connection
      .prepare(
        `SELECT 1 AS present FROM event_journal
         WHERE aggregate_type = 'work-thread' AND aggregate_id = ? LIMIT 1`,
      )
      .get(String(threadId)) !== undefined
  );
}

function collectOwnedAggregates(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: string,
): ReadonlyArray<AggregateKey> {
  const keys = new Map<string, AggregateKey>();
  const add = (aggregateType: string, aggregateId: string) => {
    if (aggregateType === THREAD_RETENTION_AGGREGATE) return;
    keys.set(`${aggregateType}:${aggregateId}`, { aggregateType, aggregateId });
  };
  add(THREAD_AGGREGATE_BY_MODE[mode], threadId);
  const rows = connection
    .prepare(
      `SELECT DISTINCT aggregate_type, aggregate_id FROM event_journal
       WHERE (aggregate_type = ? AND aggregate_id = ?)
          OR json_extract(payload_json, '$.threadId') = ?
          OR json_extract(payload_json, '$.thread.id') = ?`,
    )
    .all(THREAD_AGGREGATE_BY_MODE[mode], threadId, threadId, threadId) as ReadonlyArray<{
    readonly aggregate_type: string;
    readonly aggregate_id: string;
  }>;
  for (const row of rows) add(row.aggregate_type, row.aggregate_id);
  return [...keys.values()];
}

function purgeDerivedContent(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: string,
): void {
  if (mode === "chat") purgeThreadContent(connection, threadId);
  if (mode === "code") {
    const contentIds = connection
      .prepare(
        `SELECT content_id FROM code_file_projection WHERE thread_id = ? AND content_id IS NOT NULL`,
      )
      .all(threadId) as ReadonlyArray<{ readonly content_id: string }>;
    for (const row of contentIds) {
      connection
        .prepare(`DELETE FROM code_evidence_content_store WHERE content_id = ?`)
        .run(row.content_id);
    }
  }
  const subject = decodeContextSubjectRef({
    aggregateType: THREAD_AGGREGATE_BY_MODE[mode],
    aggregateId: threadId,
  });
  purgeContextSubjectContent(connection, subject);
  purgeAgentRunSubjectContent(connection, subject);
}

function deleteThreadScopedProjectionRows(connection: SqliteConnection, threadId: string): void {
  const tables = (
    connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as ReadonlyArray<{ readonly name: string }>
  )
    .map((row) => row.name)
    .filter(
      (table) =>
        table !== "thread_purge_tombstone" && tableHasColumn(connection, table, "thread_id"),
    );
  for (const table of tables) {
    connection
      .prepare(`DELETE FROM "${table.replaceAll('"', '""')}" WHERE thread_id = ?`)
      .run(threadId);
  }
}

function deleteJournalEvents(
  connection: SqliteConnection,
  aggregates: ReadonlyArray<AggregateKey>,
): void {
  for (const aggregate of aggregates) {
    const sequences = connection
      .prepare(
        `SELECT global_sequence FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?`,
      )
      .all(aggregate.aggregateType, aggregate.aggregateId) as ReadonlyArray<{
      readonly global_sequence: number;
    }>;
    for (const row of sequences) {
      connection
        .prepare(`DELETE FROM event_quarantine WHERE global_sequence = ?`)
        .run(row.global_sequence);
    }
    connection
      .prepare(`DELETE FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?`)
      .run(aggregate.aggregateType, aggregate.aggregateId);
  }
}

function tableHasColumn(connection: SqliteConnection, table: string, column: string): boolean {
  const columns = connection
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all() as ReadonlyArray<{ readonly name: string }>;
  return columns.some((entry) => entry.name === column);
}
