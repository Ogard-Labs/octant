import {
  TURN_METRICS_AGGREGATE_TYPE,
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
import { REPLICA_ARTIFACT_EVENT_NAMES } from "../replica/replicaArtifactEvents";
import { REPLICA_MEMBERSHIP_AGGREGATE_TYPE } from "../replica/replicaMembershipProjection";
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
    delinkUsageRecords(
      input.connection,
      input.mode,
      threadId,
      aggregates
        .filter((aggregate) => aggregate.aggregateType === "agent-run")
        .map((aggregate) => aggregate.aggregateId),
    );
    delinkProjectMemoryProvenance(input.connection, threadId);
    deleteThreadScopedProjectionRows(input.connection, threadId);
    eraseReplicaArtifactCopies(
      input.connection,
      aggregates
        .filter((aggregate) => aggregate.aggregateType === "canvas")
        .map((aggregate) => aggregate.aggregateId),
    );
    deleteJournalEvents(input.connection, aggregates);
    reconcileAggregateHeads(input.connection);
  } finally {
    input.connection.pragma("foreign_keys = ON");
  }
}

/**
 * Aggregate heads whose journal history is gone leave with it, and a head
 * with surviving events falls back to the surviving version and sequence, so
 * a later append expects a version that exists.
 */
function reconcileAggregateHeads(connection: SqliteConnection): void {
  connection.exec(
    `DELETE FROM aggregate_heads WHERE NOT EXISTS (
       SELECT 1 FROM event_journal
       WHERE event_journal.aggregate_type = aggregate_heads.aggregate_type
         AND event_journal.aggregate_id = aggregate_heads.aggregate_id
     )`,
  );
  connection.exec(
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

/**
 * Aggregate types that belong to a Canvas and nothing else: the Canvas, its
 * comments, share and access history, refresh and action receipts, and
 * artifact-mirror receipts.
 */
const CANVAS_FAMILY_AGGREGATE_TYPES = new Set<string>([
  "canvas",
  "canvas-comments",
  "canvas-share",
  "canvas-share-access",
  "canvas-refresh",
  "canvas-action",
  "artifact-mirror",
]);

/**
 * Every journal aggregate a Canvas owns, found with the ownership walk the
 * thread purge uses. A Project-scoped erase deletes exactly these, so a
 * Canvas disappears completely instead of leaving subsidiary state a restart
 * or rebuild would resurrect. Only Canvas-owned aggregate types are taken: a
 * thread whose events merely mention the Canvas is not the Project's to erase.
 */
export function collectCanvasFamilyAggregates(
  connection: SqliteConnection,
  canvasId: string,
): ReadonlyArray<AggregateKey> {
  const keys = new Map<string, AggregateKey>();
  const add = (aggregateType: string, aggregateId: string) => {
    if (!CANVAS_FAMILY_AGGREGATE_TYPES.has(aggregateType) || aggregateId.length === 0) return;
    keys.set(`${aggregateType}:${aggregateId}`, { aggregateType, aggregateId });
  };
  add("canvas", canvasId);
  followLinkedAggregates(connection, keys, add, "canvas", CANVAS_LINK_PATHS);
  add("canvas-comments", canvasId);
  add("artifact-mirror", canvasId);
  return [...keys.values()];
}

/**
 * Canvas identities a Project owns, by the provenance the journal records.
 */
export function listProjectCanvasIds(
  connection: SqliteConnection,
  projectId: string,
): ReadonlyArray<string> {
  const rows = connection
    .prepare(
      `SELECT DISTINCT aggregate_id FROM event_journal
       WHERE aggregate_type = 'canvas'
         AND json_extract(payload_json, '$.version.definition.provenance.projectId') = ?`,
    )
    .all(projectId) as ReadonlyArray<{ readonly aggregate_id: string }>;
  return rows.map((row) => row.aggregate_id);
}

/**
 * Erases what a Project owns beyond its threads: its memory entries and the
 * complete family of each Canvas it owns. The journal is authoritative, so the
 * history leaves with the projection rows; aggregate heads and quarantine rows
 * that point at it are cleaned in the same pass, so a rebuild cannot bring
 * either back. Returns whether any memory existed, so the report names only
 * scopes that actually held data.
 */
export function erasePurgedProjectData(input: {
  readonly connection: SqliteConnection;
  readonly projectId: string;
  readonly canvasIds: ReadonlyArray<string>;
}): { readonly memoryErased: boolean } {
  const { connection, projectId } = input;
  const memoryAggregate = { aggregateType: "project-memory", aggregateId: projectId };
  const memoryErased =
    connection
      .prepare(`SELECT 1 AS present FROM project_memory_projection WHERE project_id = ? LIMIT 1`)
      .get(projectId) !== undefined ||
    connection
      .prepare(
        `SELECT 1 AS present FROM event_journal
         WHERE aggregate_type = ? AND aggregate_id = ? LIMIT 1`,
      )
      .get(memoryAggregate.aggregateType, memoryAggregate.aggregateId) !== undefined;
  const aggregates = new Map<string, AggregateKey>([
    [`project-memory:${projectId}`, memoryAggregate],
  ]);
  for (const canvasId of input.canvasIds) {
    for (const aggregate of collectCanvasFamilyAggregates(connection, canvasId)) {
      aggregates.set(`${aggregate.aggregateType}:${aggregate.aggregateId}`, aggregate);
    }
  }
  connection.pragma("foreign_keys = OFF");
  try {
    connection.prepare("DELETE FROM project_memory_projection WHERE project_id = ?").run(projectId);
    eraseReplicaArtifactCopies(connection, input.canvasIds);
    deleteJournalEvents(connection, [...aggregates.values()]);
    reconcileAggregateHeads(connection);
  } finally {
    connection.pragma("foreign_keys = ON");
  }
  return { memoryErased };
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
  add(TURN_METRICS_AGGREGATE_TYPE, threadId);
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

/**
 * Usage rows are host accounting: their token and cost aggregates stay, but a
 * purged thread's identity leaves them. The row keeps its aggregate meaning
 * while spending nothing that names the person's thread (OCT-366, decision 1:
 * de-link, never retain the id, never delete the aggregates). The thread's
 * child runs are erased with it, so their rows are de-linked the same way.
 */
function delinkUsageRecords(
  connection: SqliteConnection,
  mode: OctantMode,
  threadId: string,
  runIds: ReadonlyArray<string>,
): void {
  connection
    .prepare(
      `UPDATE usage_record_projection
       SET subject_id = NULL
       WHERE subject_id = ? AND subject_type = ?`,
    )
    .run(threadId, THREAD_AGGREGATE_BY_MODE[mode]);
  const delinkRun = connection.prepare(
    `UPDATE usage_record_projection
     SET subject_id = NULL
     WHERE subject_id = ? AND subject_type = 'agent-run'`,
  );
  for (const runId of runIds) delinkRun.run(runId);
}

/**
 * Project memory is Project data and survives a thread purge (OCT-366,
 * decision 2), but an entry's provenance no longer names the purged thread.
 * The entry's text stays; only the thread reference is removed.
 */
function delinkProjectMemoryProvenance(connection: SqliteConnection, threadId: string): void {
  const update = connection.prepare(
    `UPDATE project_memory_projection
     SET entry_json = ?
     WHERE project_id = ? AND entry_id = ?`,
  );
  const rows = connection
    .prepare(
      `SELECT project_id, entry_id, entry_json FROM project_memory_projection
       WHERE instr(entry_json, ?) > 0`,
    )
    .all(threadId) as ReadonlyArray<{
    readonly project_id: string;
    readonly entry_id: string;
    readonly entry_json: string;
  }>;
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.entry_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.provenance === undefined || typeof parsed.provenance !== "object") continue;
    const provenance = parsed.provenance as Record<string, unknown>;
    if (provenance.threadId !== threadId) continue;
    delete provenance.threadId;
    update.run(JSON.stringify(parsed), row.project_id, row.entry_id);
  }
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

/**
 * Artifact sync keeps its own copies of a Canvas: a queued publish carries
 * the bundle, and an entry a pull kept carries its exact text. Both live
 * under the replica aggregate, which the Canvas family walk does not reach,
 * so a purge erases them here. A queued publish of an erased Canvas is
 * dropped. A kept entry becomes a content-free erased slot, so its slot stays
 * settled and a later pull does not import the erased content again. Slots
 * this host published keep their content-free `published` record for the
 * same reason. The copy already in the store is the store's: nothing here
 * deletes from it.
 */
function eraseReplicaArtifactCopies(
  connection: SqliteConnection,
  canvasIds: ReadonlyArray<string>,
): void {
  for (const canvasId of canvasIds) {
    const queued = connection
      .prepare(
        `SELECT global_sequence FROM event_journal
         WHERE aggregate_type = ? AND event_name = ?
           AND json_extract(payload_json, '$.artifact.canvasId') = ?`,
      )
      .all(
        REPLICA_MEMBERSHIP_AGGREGATE_TYPE,
        REPLICA_ARTIFACT_EVENT_NAMES.queued,
        canvasId,
      ) as ReadonlyArray<{ readonly global_sequence: number }>;
    for (const row of queued) {
      connection
        .prepare(`DELETE FROM event_quarantine WHERE global_sequence = ?`)
        .run(row.global_sequence);
      connection
        .prepare(`DELETE FROM event_journal WHERE global_sequence = ?`)
        .run(row.global_sequence);
    }
    connection
      .prepare(
        `UPDATE event_journal
         SET event_name = ?,
             payload_json = json_object(
               'instanceId', json_extract(payload_json, '$.instanceId'),
               'sequence', json_extract(payload_json, '$.sequence')
             )
         WHERE aggregate_type = ? AND event_name = ?
           AND json_extract(payload_json, '$.text') IS NOT NULL
           AND json_extract(json_extract(payload_json, '$.text'), '$.artifact.canvasId') = ?`,
      )
      .run(
        REPLICA_ARTIFACT_EVENT_NAMES.slotErased,
        REPLICA_MEMBERSHIP_AGGREGATE_TYPE,
        REPLICA_ARTIFACT_EVENT_NAMES.reconciled,
        canvasId,
      );
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
