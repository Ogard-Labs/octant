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
    input.connection.exec(
      `UPDATE aggregate_heads
       SET aggregate_version = (
             SELECT MAX(event_journal.aggregate_version) FROM event_journal
             WHERE event_journal.aggregate_type = aggregate_heads.aggregate_type
               AND event_journal.aggregate_id = aggregate_heads.aggregate_id
           ),
           last_sequence = (
             SELECT MAX(event_journal.global_sequence) FROM event_journal
             WHERE event_journal.aggregate_type = aggregate_heads.aggregate_type
               AND event_journal.aggregate_id = aggregate_heads.aggregate_id
           )
       WHERE EXISTS (
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

const THREAD_OWNERSHIP_PATHS = [
  "$.threadId",
  "$.thread.id",
  "$.parentThreadId",
  "$.run.parentThreadId",
  "$.followUp.threadId",
  "$.version.definition.provenance.threadId",
  "$.version.provenance.threadId",
  "$.anchor.threadId",
  "$.checkpoint.anchor.threadId",
  "$.provenance.threadId",
  "$.record.provenance.threadId",
  "$.record.document.provenance.threadId",
  "$.originThreadId",
] as const;

const CANVAS_LINK_PATHS = [
  "$.canvasId",
  "$.receipt.canvasId",
  "$.version.canvasId",
  "$.record.canvasId",
  "$.record.document.canvasId",
  "$.event.canvasId",
] as const;
const RUN_LINK_PATHS = ["$.parentRunId", "$.run.parentRunId"] as const;

/** Aggregates a purge must not take, even when a payload names the thread. */
const RETAINED_AGGREGATE_TYPES = new Set<string>([THREAD_RETENTION_AGGREGATE, "context-ledger"]);

const USAGE_EVENT_NAME = "context.usage-reconciled@1";

export interface ThreadFileAnchors {
  readonly canvasIds: ReadonlyArray<string>;
  readonly runIds: ReadonlyArray<string>;
}

/** Canvas and agent-run identities a file purge can resolve before journal erasure. */
export function listThreadFileAnchors(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: string,
): ThreadFileAnchors {
  const aggregates = collectOwnedAggregates(connection, mode, threadId);
  return {
    canvasIds: aggregates
      .filter((aggregate) => aggregate.aggregateType === "canvas")
      .map((aggregate) => aggregate.aggregateId),
    runIds: aggregates
      .filter((aggregate) => aggregate.aggregateType === "agent-run")
      .map((aggregate) => aggregate.aggregateId),
  };
}

function collectOwnedAggregates(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: string,
): ReadonlyArray<AggregateKey> {
  const keys = new Map<string, AggregateKey>();
  const add = (aggregateType: string, aggregateId: string) => {
    if (RETAINED_AGGREGATE_TYPES.has(aggregateType) || aggregateId.length === 0) return;
    keys.set(`${aggregateType}:${aggregateId}`, { aggregateType, aggregateId });
  };
  add(THREAD_AGGREGATE_BY_MODE[mode], threadId);
  add("native-harness-session", threadId);
  for (const match of aggregatesMatching(connection, THREAD_OWNERSHIP_PATHS, threadId)) {
    add(match.aggregateType, match.aggregateId);
  }
  followLinkedAggregates(connection, keys, add, "canvas", CANVAS_LINK_PATHS);
  for (const canvasId of idsOf(keys, "canvas")) {
    add("canvas-comments", canvasId);
    add("artifact-mirror", canvasId);
  }
  followLinkedAggregates(connection, keys, add, "agent-run", RUN_LINK_PATHS);
  for (const sessionId of harnessSessionIds(connection, threadId)) {
    add("native-harness-transcript", sessionId);
    for (const match of aggregatesMatching(connection, ["$.sessionId"], sessionId)) {
      add(match.aggregateType, match.aggregateId);
    }
  }
  return [...keys.values()];
}

function followLinkedAggregates(
  connection: SqliteConnection,
  keys: Map<string, AggregateKey>,
  add: (aggregateType: string, aggregateId: string) => void,
  aggregateType: string,
  paths: ReadonlyArray<string>,
): void {
  const seen = new Set<string>();
  const pending = idsOf(keys, aggregateType);
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const match of aggregatesMatching(connection, paths, id)) {
      const before = keys.size;
      add(match.aggregateType, match.aggregateId);
      if (keys.size > before && match.aggregateType === aggregateType)
        pending.push(match.aggregateId);
    }
  }
}

function idsOf(keys: Map<string, AggregateKey>, aggregateType: string): string[] {
  const ids: string[] = [];
  for (const key of keys.values()) {
    if (key.aggregateType === aggregateType) ids.push(key.aggregateId);
  }
  return ids;
}

function aggregatesMatching(
  connection: SqliteConnection,
  paths: ReadonlyArray<string>,
  value: string,
): ReadonlyArray<AggregateKey> {
  if (paths.length === 0) return [];
  const clause = paths.map((path) => `json_extract(payload_json, '${path}') = ?`).join(" OR ");
  const rows = connection
    .prepare(`SELECT DISTINCT aggregate_type, aggregate_id FROM event_journal WHERE ${clause}`)
    .all(...paths.map(() => value)) as ReadonlyArray<{
    readonly aggregate_type: string;
    readonly aggregate_id: string;
  }>;
  return rows.map((row) => ({ aggregateType: row.aggregate_type, aggregateId: row.aggregate_id }));
}

function harnessSessionIds(connection: SqliteConnection, threadId: string): ReadonlyArray<string> {
  const rows = connection
    .prepare(
      `SELECT json_extract(payload_json, '$.id') AS session_id
       FROM event_journal
       WHERE aggregate_type = 'native-harness-session' AND aggregate_id = ?`,
    )
    .all(threadId) as ReadonlyArray<{ readonly session_id: unknown }>;
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row.session_id === "string" && row.session_id.length > 0) ids.push(row.session_id);
  }
  return ids;
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
        `SELECT global_sequence FROM event_journal
         WHERE aggregate_type = ? AND aggregate_id = ? AND event_name != ?`,
      )
      .all(aggregate.aggregateType, aggregate.aggregateId, USAGE_EVENT_NAME) as ReadonlyArray<{
      readonly global_sequence: number;
    }>;
    for (const row of sequences) {
      connection
        .prepare(`DELETE FROM event_quarantine WHERE global_sequence = ?`)
        .run(row.global_sequence);
    }
    connection
      .prepare(
        `DELETE FROM event_journal
         WHERE aggregate_type = ? AND aggregate_id = ? AND event_name != ?`,
      )
      .run(aggregate.aggregateType, aggregate.aggregateId, USAGE_EVENT_NAME);
  }
}

function tableHasColumn(connection: SqliteConnection, table: string, column: string): boolean {
  const columns = connection
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all() as ReadonlyArray<{ readonly name: string }>;
  return columns.some((entry) => entry.name === column);
}
