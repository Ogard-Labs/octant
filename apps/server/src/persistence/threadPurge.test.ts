import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeChatThread,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeImageGenerationScopeId,
  decodeProjectId,
  decodeWorkThreadId,
} from "@octant/contracts";
import { decodeHostExportUsageRow } from "@octant/contracts";
import { decodeThreadRetentionThreadId } from "@octant/contracts/thread-retention";
import { afterEach, describe, expect, it } from "vitest";
import { ChatAttachmentStore } from "../chat/chatAttachmentStore";
import { CodeAttachmentStore } from "../code/codeAttachmentStore";
import { GeneratedImageStore } from "../image/generatedImageStore";
import { WorkAttachmentStore } from "../work/workAttachmentStore";
import { writeChatContent } from "./chatProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { toSafeExportRow } from "./usageExport";
import { queryUsageRecords, readAllUsageRecords } from "./usageProjection";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { purgeThreadArtifacts } from "./threadArtifactPurge";
import { managedWorktreeRoot } from "../code/managedWorktreeService";
import { ThreadCheckpointProjection } from "./threadCheckpointProjection";
import { ThreadRetentionService } from "../threadRetentionService";

const directories: Array<string> = [];
const now = "2026-08-19T12:00:00.000Z";
const projectId = "c3630000-0000-4000-8000-000000000010";
const actorId = "c3630000-0000-4000-8000-0000000000a1";
const providerId = "c3630000-0000-4000-8000-0000000000a2";

const threads = {
  chat: {
    id: "c3630000-0000-4000-8000-000000000001",
    mode: "chat" as const,
    marker: "marker-chat-violet-ledger",
  },
  work: {
    id: "c3630000-0000-4000-8000-000000000002",
    mode: "work" as const,
    marker: "marker-work-amber-ledger",
  },
  code: {
    id: "c3630000-0000-4000-8000-000000000003",
    mode: "code" as const,
    marker: "marker-code-indigo-ledger",
  },
} as const;

const controlThreadId = "c3630000-0000-4000-8000-000000000004";
const controlMarker = "marker-control-kept-ledger";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("thread purge sweep", () => {
  it("refuses a remote principal and a purge that was not confirmed", async () => {
    const harness = openHarness();
    const scope = {
      kind: "thread" as const,
      mode: "chat" as const,
      threadId: decodeThreadRetentionThreadId(threads.chat.id),
    };
    expect(await harness.service.purge({ scope, confirm: true }, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "unauthorized",
    });
    expect(await harness.service.purge({ scope, confirm: false }, "local-window")).toMatchObject({
      kind: "refused",
      reason: "confirmation-required",
    });
  });

  it("leaves no trace of a purged thread except the scopes the outcome says it kept", async () => {
    const harness = openHarness();
    seedControlThread(harness);
    for (const thread of Object.values(threads)) seedThreadTraces(harness, thread);
    seedProjectMemory(harness.connection);

    const retained = new Set<string>();
    for (const thread of Object.values(threads)) {
      const outcome = await harness.service.purge(
        {
          scope: {
            kind: "thread",
            mode: thread.mode,
            threadId: decodeThreadRetentionThreadId(thread.id),
          },
          confirm: true,
        },
        "local-window",
      );
      expect(outcome).toMatchObject({ operation: "purge-threads" });
      if (!("retained" in outcome)) throw new Error("purge did not report retained scopes");
      for (const scope of outcome.retained) retained.add(scope);
    }

    const hits = scanHost(harness.connection, harness.directory, [
      ...Object.values(threads).flatMap((thread) => [thread.id, thread.marker]),
    ]);
    const unexplained = hits.filter((hit) => {
      const scope = classifyHit(hit);
      return scope === undefined || !retained.has(scope);
    });
    expect(unexplained.map(formatHit)).toEqual([]);
    expect(readControl(harness.connection)).toBe(controlMarker);
    expect(sharedWorktreeRemains(harness.directory)).toBe(true);
    // De-linked usage rows keep their aggregates but carry no thread identity.
    expect(usageRowsByThread(harness.connection)).toBe(0);
    expect(usageRowsDeLinked(harness.connection)).toBe(3);
    // Retained spend stays readable everywhere the host reads usage: the full
    // ledger, the unfiled read, and the host export, which must not drop a
    // de-linked row as unrepresentable.
    const ledger = readAllUsageRecords(harness.connection);
    expect(ledger.map((record) => record.subject)).toEqual([
      expect.objectContaining({ deLinked: true }),
      expect.objectContaining({ deLinked: true }),
      expect.objectContaining({ deLinked: true }),
    ]);
    expect(ledger.reduce((total, record) => total + record.inputTokens, 0)).toBe(9);
    expect(
      queryUsageRecords(harness.connection, {}, 100, 0, { kind: "unfiled" }).records,
    ).toHaveLength(3);
    expect(
      queryUsageRecords(harness.connection, {}, 100, 0, {
        kind: "projects",
        projectIds: [projectId],
      }).records,
    ).toHaveLength(0);
    expect(
      ledger.map((record) => decodeHostExportUsageRow(toSafeExportRow(record)).subjectId),
    ).toEqual([null, null, null]);
    // Project memory is Project data: the entry survives a thread purge, but
    // its provenance no longer names the purged thread.
    expect(projectMemoryEntriesRemain(harness.connection)).toBeGreaterThan(0);
    expect(projectMemoryNamesThread(harness.connection, threads.code.id)).toBe(false);
  });

  it("leaves a managed worktree in place whose receipt names a path outside the managed worktree directory", async () => {
    const harness = openHarness();
    seedControlThread(harness);
    const thread = threads.code;
    seedThreadTraces(harness, thread);
    const layout = worktreeLayout(harness.directory);
    const escaped = join(harness.directory, "escaped-worktree");
    mkdirSync(escaped, { recursive: true });
    writeFileSync(join(escaped, "note.txt"), thread.marker);
    const receipts = join(harness.directory, "managed-worktree-receipts");
    writeFileSync(
      join(receipts, "escaped.json"),
      JSON.stringify({
        ...worktreeReceipt(thread.id, escaped, layout),
        note: thread.marker,
      }),
    );

    const outcome = await harness.service.purge(
      {
        scope: {
          kind: "thread",
          mode: thread.mode,
          threadId: decodeThreadRetentionThreadId(thread.id),
        },
        confirm: true,
      },
      "local-window",
    );
    expect(outcome).toMatchObject({ operation: "purge-threads" });

    // A receipt the sweep cannot trust blocks it: nothing it names is deleted,
    // and every other owned worktree stays in place rather than half-removed.
    expect(readFileSync(join(escaped, "note.txt"), "utf8")).toBe(thread.marker);
    expect(
      readdirSync(
        join(harness.directory, "repository", ".octant-worktrees", layout.repositoryId),
      ).some((entry) => entry === thread.id),
    ).toBe(true);
    expect(readFileSync(join(receipts, "escaped.json"), "utf8")).toContain(thread.marker);
  });
});

interface Harness {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly service: ThreadRetentionService;
  readonly directory: string;
}

function openHarness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "octant-thread-purge-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const chatAttachments = new ChatAttachmentStore(directory);
  const workAttachments = new WorkAttachmentStore(directory);
  const codeAttachments = new CodeAttachmentStore(directory);
  const images = new GeneratedImageStore(directory);
  const workThreads = [
    { id: threads.work.id, projectId: decodeProjectId(projectId), updatedAt: now },
  ];
  const service = new ThreadRetentionService({
    connection,
    journal,
    clock: () => now,
    uuid: randomUUID,
    listWorkThreads: () => workThreads,
    forgetWorkThread: (threadId) => {
      const index = workThreads.findIndex((thread) => thread.id === threadId);
      if (index >= 0) workThreads.splice(index, 1);
    },
    purgeThreadArtifacts: ({ mode, threadId }) =>
      purgeThreadArtifacts({
        connection,
        dataDirectory: directory,
        mode,
        threadId: String(threadId),
        managedWorktreeRootPath: managedWorktreeRoot,
        purgeChatAttachments: (id) => chatAttachments.purgeThread(decodeChatThreadId(id)),
        purgeWorkAttachments: (id) => workAttachments.purgeThread(decodeWorkThreadId(id)),
        purgeCodeAttachments: (id) => codeAttachments.purgeThread(decodeCodeThreadId(id)),
        purgeGeneratedImages: async (id) => {
          try {
            await images.purgeScope(decodeImageGenerationScopeId(id));
          } catch {
            // A thread id that is not an image scope is not an image basin.
          }
        },
        purgeAgentMessages: async () => undefined,
      }),
  });
  return { connection, journal, service, directory };
}

interface SeededThread {
  readonly id: string;
  readonly mode: "chat" | "work" | "code";
  readonly marker: string;
}

function seedThreadTraces(harness: Harness, thread: SeededThread): void {
  if (thread.mode === "chat") seedChatProjection(harness, thread.id, thread.marker);
  if (thread.mode === "code") seedCodeProjection(harness, thread.id);
  seedCanvasFamily(harness, thread);
  seedAttachments(harness.directory, thread);
  seedGeneratedImage(harness.directory, thread);
  seedAgentRun(harness, thread);
  seedCheckpoint(harness, thread);
  seedFollowUp(harness, thread);
  seedHarnessSession(harness, thread);
  seedWorktree(harness.directory, thread);
  seedUsage(harness.connection, thread);
}

function seedChatProjection(harness: Harness, threadId: string, marker: string): void {
  harness.journal.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
    expectedVersion: 0,
    events: [
      {
        eventId: randomUUID(),
        eventName: "chat.thread-created@1",
        eventVersion: 1,
        correlationId: randomUUID(),
        actor: { kind: "system", actorId },
        occurredAt: now,
        payload: {
          kind: "thread-created",
          thread: decodeChatThread({
            id: threadId,
            title: "Chat thread",
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model-a",
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be useful.",
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
        },
      },
    ],
  });
  writeChatContent(harness.connection, {
    contentId: randomUUID(),
    threadId,
    role: "user",
    body: marker,
    digest: createHash("sha256").update(marker).digest("hex"),
    byteLength: marker.length,
  });
}

function seedCodeProjection(harness: Harness, threadId: string): void {
  harness.connection
    .prepare(
      `INSERT INTO code_thread_projection (
        thread_id, project_id, checkout_id, lifecycle, schema_version, thread_json,
        aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, ?, 'active', 1, '{}', 1, ?, 1)`,
    )
    .run(threadId, projectId, `checkout-${threadId}`, now);
}

function seedCanvasFamily(harness: Harness, thread: SeededThread): void {
  const canvasId = uuidFor(thread.mode, "canvas");
  insertEvent(harness.connection, "canvas", canvasId, {
    canvasId,
    version: {
      definition: {
        title: thread.marker,
        provenance: { threadId: thread.id, mode: thread.mode },
      },
    },
  });
  insertEvent(harness.connection, "canvas-comments", canvasId, {
    canvasId,
    body: thread.marker,
  });
  const shareId = uuidFor(thread.mode, "share");
  insertEvent(harness.connection, "canvas-share", shareId, {
    record: {
      canvasId,
      note: thread.marker,
      provenance: { threadId: thread.id },
      document: {
        canvasId,
        note: thread.marker,
        provenance: { threadId: thread.id },
      },
    },
  });
  insertEvent(harness.connection, "canvas-share-access", uuidFor(thread.mode, "share-access"), {
    event: { canvasId, snapshotId: shareId, note: thread.marker },
  });
  insertEvent(harness.connection, "canvas-refresh", uuidFor(thread.mode, "refresh"), {
    receipt: { canvasId, detail: thread.marker },
  });
  insertEvent(harness.connection, "canvas-action", uuidFor(thread.mode, "action"), {
    receipt: { canvasId, detail: thread.marker },
  });
  const mirrorRoot = join(harness.directory, "artifact-mirrors");
  const relativePath = `${canvasId}/bundle.md`;
  mkdirSync(join(mirrorRoot, canvasId), { recursive: true });
  writeFileSync(join(mirrorRoot, relativePath), thread.marker);
  insertEvent(harness.connection, "artifact-mirror", canvasId, {
    receipt: {
      canvasId,
      destination: { kind: "global-folder", canonicalRoot: mirrorRoot },
      paths: [relativePath],
      detail: thread.marker,
    },
  });
}

function seedAttachments(directory: string, thread: SeededThread): void {
  const root =
    thread.mode === "chat" ? "threads" : thread.mode === "work" ? "work-threads" : "code-threads";
  const path = join(
    directory,
    root,
    thread.id,
    uuidFor(thread.mode, "attachment"),
    "finalized.bin",
  );
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, thread.marker);
}

function seedGeneratedImage(directory: string, thread: SeededThread): void {
  const path = join(
    directory,
    "generated-images",
    thread.id,
    uuidFor(thread.mode, "image"),
    "finalized.bin",
  );
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, thread.marker);
}

function seedAgentRun(harness: Harness, thread: SeededThread): void {
  const runId = uuidFor(thread.mode, "run");
  const childId = uuidFor(thread.mode, "child");
  const subjectType =
    thread.mode === "chat" ? "chat-thread" : thread.mode === "code" ? "code-thread" : "work-thread";
  insertEvent(harness.connection, "agent-run", runId, {
    run: { id: runId, parentThreadId: thread.id, task: thread.marker },
  });
  insertEvent(harness.connection, "agent-run", childId, {
    run: { id: childId, parentThreadId: thread.id, parentRunId: runId, task: thread.marker },
  });
  harness.connection
    .prepare(
      `INSERT INTO agent_run_content_store (
        content_id, run_id, subject_type, subject_id, content_kind, body_text, created_at
      ) VALUES (?, ?, ?, ?, 'result', ?, ?)`,
    )
    .run(uuidFor(thread.mode, "content"), childId, subjectType, thread.id, thread.marker, now);
  const receiptDir = join(harness.directory, "agent-run-workspace-receipts");
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(
    join(receiptDir, `${uuidFor(thread.mode, "receipt")}.json`),
    JSON.stringify({ parentThreadId: thread.id, note: thread.marker }),
  );
  const scratch = join(harness.directory, "agent-run-scratch", runId);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "session.txt"), thread.marker);
}

function seedCheckpoint(harness: Harness, thread: SeededThread): void {
  new ThreadCheckpointProjection().createTable(harness.connection);
  const checkpointId = uuidFor(thread.mode, "checkpoint");
  insertEvent(harness.connection, "thread-checkpoint", checkpointId, {
    checkpoint: {
      id: checkpointId,
      anchor: { mode: thread.mode, threadId: thread.id },
      label: thread.marker,
    },
  });
  if (thread.mode === "work") return;
  harness.connection
    .prepare(
      `INSERT INTO thread_checkpoint_projection (
        checkpoint_id, thread_id, mode, lifecycle, checkpoint_json, aggregate_version, last_sequence
      ) VALUES (?, ?, ?, 'marked', ?, 1, 1)`,
    )
    .run(checkpointId, thread.id, thread.mode, JSON.stringify({ label: thread.marker }));
}

function seedFollowUp(harness: Harness, thread: SeededThread): void {
  insertEvent(harness.connection, "thread-follow-up-suggestions", thread.id, {
    threadId: thread.id,
    followUps: [{ title: thread.marker }],
  });
  insertEvent(harness.connection, "thread-follow-up", thread.id, {
    kind: "follow-up-updated",
    followUp: { threadId: thread.id, reason: thread.marker },
  });
  insertEvent(harness.connection, "thread-turn-metrics", thread.id, {
    threadId: thread.id,
    modelId: thread.marker,
  });
}

function seedHarnessSession(harness: Harness, thread: SeededThread): void {
  const sessionId = uuidFor(thread.mode, "session");
  insertEvent(harness.connection, "native-harness-session", thread.id, {
    id: sessionId,
    threadId: thread.id,
    note: thread.marker,
  });
  insertEvent(harness.connection, "native-harness-transcript", sessionId, {
    sessionId,
    message: thread.marker,
  });
}

function seedWorktree(directory: string, thread: SeededThread): void {
  const layout = worktreeLayout(directory);
  const owned = layout.worktreeFor(thread.id);
  mkdirSync(owned, { recursive: true });
  writeFileSync(join(owned, "note.txt"), thread.marker);
  const shared = layout.worktreeFor(controlThreadId);
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "note.txt"), controlMarker);
  const receipts = join(directory, "managed-worktree-receipts");
  mkdirSync(receipts, { recursive: true });
  const receipt = (threadId: string, path: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...worktreeReceipt(threadId, path, layout), ...extra });
  writeFileSync(
    join(receipts, uuidFor(thread.mode, "worktree") + ".json"),
    receipt(thread.id, owned, { note: thread.marker }),
  );
  if (thread.mode === "chat") {
    writeFileSync(join(receipts, "shared.json"), receipt(controlThreadId, shared));
    writeFileSync(
      join(receipts, "shared-purged.json"),
      JSON.stringify({
        ...worktreeReceipt(thread.id, shared, layout),
        note: thread.marker,
      }),
    );
  }
}

function seedUsage(connection: SqliteConnection, thread: SeededThread): void {
  const subjectType =
    thread.mode === "chat" ? "chat-thread" : thread.mode === "code" ? "code-thread" : "work-thread";
  connection
    .prepare(
      `INSERT INTO usage_record_projection (
        reconciliation_id, subject_type, subject_id, provider_instance_id, model_id,
        request_shape, quality, input_tokens, output_tokens, planned_input_tokens,
        variance_tokens, schema_version, attribution_json, observed_at, last_sequence, host_id
      ) VALUES (?, ?, ?, ?, 'model-a', 'turn', 'exact', 3, 1, 3, 0, 2, '[]', ?, 1, 'local')`,
    )
    .run(uuidFor(thread.mode, "usage"), subjectType, thread.id, providerId, now);
}

function seedControlThread(harness: Harness): void {
  seedChatProjection(harness, controlThreadId, controlMarker);
}

function insertEvent(
  connection: SqliteConnection,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
): void {
  connection
    .prepare(
      `INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
        correlation_id, actor_kind, actor_id, occurred_at, payload_json, host_id
      ) VALUES (?, ?, ?, 1, 'fixture.planted@1', 1, ?, 'system', ?, ?, ?, 'local')`,
    )
    .run(
      randomUUID(),
      aggregateType,
      aggregateId,
      randomUUID(),
      actorId,
      now,
      JSON.stringify(payload),
    );
}

interface TraceHit {
  readonly where: string;
  readonly needle: string;
}

function scanHost(
  connection: SqliteConnection,
  directory: string,
  needles: ReadonlyArray<string>,
): ReadonlyArray<TraceHit> {
  const hits: TraceHit[] = [];
  const tables = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as ReadonlyArray<{ readonly name: string }>;
  for (const table of tables) {
    const quoted = `"${table.name.replaceAll('"', '""')}"`;
    const rows = connection.prepare(`SELECT * FROM ${quoted}`).all() as ReadonlyArray<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const where =
        table.name === "event_journal" && typeof row.aggregate_type === "string"
          ? `aggregate:${row.aggregate_type}`
          : `table:${table.name}`;
      const text = JSON.stringify(row);
      for (const needle of needles) {
        if (text.includes(needle)) hits.push({ where, needle });
      }
    }
  }
  walkFiles(directory, (path, text) => {
    for (const needle of needles) {
      if (text.includes(needle) || path.includes(needle))
        hits.push({ where: `file:${path}`, needle });
    }
  });
  return hits;
}

function walkFiles(directory: string, visit: (path: string, text: string) => void): void {
  let entries: ReadonlyArray<string> = [];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walkFiles(path, visit);
      continue;
    }
    if (!stat.isFile()) continue;
    visit(path, readFileSync(path).toString("utf8"));
  }
}

function classifyHit(hit: TraceHit): string | undefined {
  const tombstone =
    hit.where === "table:thread_purge_tombstone" || hit.where === "aggregate:thread-retention";
  if (tombstone) return hit.needle.startsWith("marker-") ? undefined : "purge-tombstone";
  if (hit.where.startsWith("table:usage_")) {
    return hit.needle.startsWith("marker-") ? undefined : "usage-records";
  }
  if (hit.where.startsWith("file:") && isSqliteStoreFile(hit.where)) return "sqlite-free-pages";
  return undefined;
}

function isSqliteStoreFile(where: string): boolean {
  return (
    where.endsWith(".sqlite3") || where.endsWith(".sqlite3-wal") || where.endsWith(".sqlite3-shm")
  );
}

function formatHit(hit: TraceHit): string {
  return `${hit.where} contains ${hit.needle}`;
}

function readControl(connection: SqliteConnection): string | undefined {
  const row = connection
    .prepare("SELECT body_text FROM chat_content_store WHERE thread_id = ?")
    .get(controlThreadId) as { readonly body_text: string } | undefined;
  return row?.body_text;
}

function usageRowsByThread(connection: SqliteConnection): number {
  const row = connection
    .prepare(
      `SELECT COUNT(*) AS count FROM usage_record_projection
       WHERE subject_id IN (?, ?, ?)`,
    )
    .get(threads.chat.id, threads.work.id, threads.code.id) as { readonly count: number };
  return row.count;
}

function usageRowsDeLinked(connection: SqliteConnection): number {
  const row = connection
    .prepare(
      `SELECT COUNT(*) AS count FROM usage_record_projection
       WHERE subject_id IS NULL AND input_tokens = 3 AND output_tokens = 1`,
    )
    .get() as { readonly count: number };
  return row.count;
}

function seedProjectMemory(connection: SqliteConnection): void {
  connection
    .prepare(
      `INSERT INTO project_memory_projection (
        project_id, entry_id, schema_version, status, memory_kind, entry_json, aggregate_version
      ) VALUES (?, ?, 1, 'active', 'summary', ?, 1)`,
    )
    .run(
      projectId,
      "c3630000-0000-4000-8000-0000000000m1",
      JSON.stringify({
        kind: "summary",
        projectId,
        entryId: "c3630000-0000-4000-8000-0000000000m1",
        text: "The team prefers small focused PRs.",
        provenance: { threadId: threads.code.id },
        createdAt: now,
        updatedAt: now,
      }),
    );
}

function projectMemoryEntriesRemain(connection: SqliteConnection): number {
  const row = connection
    .prepare("SELECT COUNT(*) AS count FROM project_memory_projection")
    .get() as { readonly count: number };
  return row.count;
}

function projectMemoryNamesThread(connection: SqliteConnection, threadId: string): boolean {
  const row = connection
    .prepare("SELECT COUNT(*) AS count FROM project_memory_projection WHERE entry_json LIKE ?")
    .get(`%${threadId}%`) as { readonly count: number };
  return row.count > 0;
}

function sharedWorktreeRemains(directory: string): boolean {
  try {
    const layout = worktreeLayout(directory);
    return (
      readFileSync(join(layout.worktreeFor(controlThreadId), "note.txt"), "utf8") === controlMarker
    );
  } catch {
    return false;
  }
}

/**
 * The layout the managed-worktree service derives. The seeded receipts use the
 * same shape the store writes, so the sweep's containment gate is exercised by
 * the same derivation that created the worktrees.
 */
function worktreeLayout(directory: string): {
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly worktreeFor: (threadId: string) => string;
} {
  const repositoryRoot = join(directory, "repository", "checkout");
  const repositoryId = "repo_" + "a".repeat(64);
  return {
    repositoryRoot,
    repositoryId,
    worktreeFor: (threadId: string) =>
      join(directory, "repository", ".octant-worktrees", repositoryId, threadId),
  };
}

function worktreeReceipt(
  threadId: string,
  canonicalWorktreePath: string,
  layout: ReturnType<typeof worktreeLayout>,
): Record<string, unknown> {
  return {
    version: 1,
    receiptId: randomUUID(),
    repositoryId: layout.repositoryId,
    threadId,
    checkoutId: randomUUID(),
    canonicalRepositoryPath: layout.repositoryRoot,
    canonicalWorktreePath,
    branchIntent: "octant/agent-run/" + threadId,
    refIntent: "refs/heads/octant/agent-run/" + threadId,
    expectedHead: "a".repeat(40),
    state: "ready",
    createdAt: now,
    updatedAt: now,
  };
}

function uuidFor(mode: string, kind: string): string {
  const salt = createHash("sha256").update(`${mode}:${kind}`).digest("hex");
  return `${salt.slice(0, 8)}-${salt.slice(8, 12)}-4${salt.slice(13, 16)}-8${salt.slice(17, 20)}-${salt.slice(20, 32)}`;
}
