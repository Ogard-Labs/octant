import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasId,
  decodeCanvasVersion,
  decodeChatThread,
  decodeChatThreadId,
  decodeProject,
  decodeProjectId,
} from "@octant/contracts";
import { decodeThreadRetentionThreadId } from "@octant/contracts/thread-retention";
import { afterEach, describe, expect, it } from "vitest";
import { writeChatContent, readChatThread, readChatThreads } from "./persistence/chatProjection";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { rebuildProjection } from "./persistence/projection";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { ThreadRetentionService } from "./threadRetentionService";

const directories: Array<string> = [];
const now = "2026-08-19T12:00:00.000Z";
const ids = {
  actor: "c1000000-0000-4000-8000-000000000001",
  correlation: "c1000000-0000-4000-8000-000000000002",
  provider: "c1000000-0000-4000-8000-000000000003",
  thread: decodeThreadRetentionThreadId("c1000000-0000-4000-8000-000000000010"),
  other: "c1000000-0000-4000-8000-000000000011",
  content: "c1000000-0000-4000-8000-000000000030",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openHarness() {
  const directory = mkdtempSync(join(tmpdir(), "octant-thread-retention-"));
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
  const erasedCanvasFiles: Array<ReadonlyArray<string>> = [];
  const service = new ThreadRetentionService({
    connection,
    journal,
    clock: () => now,
    uuid: randomUUID,
    listWorkThreads: () => [],
    forgetCanvases: (canvasIds) => runtime.canvasProjection.evict(canvasIds),
    purgeCanvasFiles: (canvasIds) => {
      erasedCanvasFiles.push(canvasIds);
    },
  });
  return { connection, journal, service, runtime, erasedCanvasFiles };
}

function pending(eventName: string, payload: unknown) {
  return {
    eventId: randomUUID(),
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system" as const, actorId: ids.actor },
    occurredAt: now,
    payload,
  };
}

function chatThread(threadId: string, title: string) {
  return decodeChatThread({
    id: threadId,
    title,
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be useful.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function seedChatThread(
  journal: Journal,
  connection: SqliteConnection,
  threadId: string,
  title: string,
  body: string,
): void {
  journal.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
    expectedVersion: 0,
    events: [
      pending("chat.thread-created@1", {
        kind: "thread-created",
        thread: chatThread(threadId, title),
      }),
    ],
  });
  writeChatContent(connection, {
    contentId: randomUUID(),
    threadId,
    role: "user",
    body,
    digest: createHash("sha256").update(body).digest("hex"),
    byteLength: body.length,
  });
}

describe("ThreadRetentionService", () => {
  it("refuses a remote principal and a purge without confirmation", async () => {
    const { service } = openHarness();
    const scope = { kind: "thread" as const, mode: "chat" as const, threadId: ids.thread };
    expect(await service.purge({ scope, confirm: true }, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "unauthorized",
    });
    expect(await service.purge({ scope, confirm: false }, "local-window")).toMatchObject({
      kind: "refused",
      reason: "confirmation-required",
    });
  });

  it("purges a named thread from ordinary reads and from the journal so a rebuild cannot resurrect it", async () => {
    const { connection, journal, service, runtime } = openHarness();
    seedChatThread(journal, connection, ids.thread, "Secret title", "user said a secret");
    seedChatThread(journal, connection, ids.other, "Keep this one", "other body");
    const report = await service.purge(
      { scope: { kind: "thread", mode: "chat", threadId: ids.thread }, confirm: true },
      "local-window",
    );
    expect(report).toMatchObject({
      operation: "purge-threads",
      purged: [{ mode: "chat", threadId: ids.thread }],
    });
    expect(readChatThread(connection, decodeChatThreadId(ids.thread))).toBeUndefined();
    expect(readChatThreads(connection).map((thread) => String(thread.id))).toEqual([ids.other]);
    expect(
      (
        connection
          .prepare("SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ?")
          .get(ids.thread) as { readonly count: number }
      ).count,
    ).toBe(0);
    expect(
      (
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM event_journal WHERE aggregate_type = 'chat-thread' AND aggregate_id = ?",
          )
          .get(ids.thread) as { readonly count: number }
      ).count,
    ).toBe(0);
    const chat = runtime.projections.get("chat");
    if (chat === undefined) throw new Error("chat projection must be registered");
    rebuildProjection({ connection, journal, projection: chat, clock: () => now });
    expect(readChatThread(connection, decodeChatThreadId(ids.thread))).toBeUndefined();
    expect(readChatThread(connection, decodeChatThreadId(ids.other))?.title).toBe("Keep this one");
  });

  it("erases a Project's memory and Canvases completely on a Project-scoped purge", async () => {
    const harness = openHarness();
    const { connection, journal, runtime, service } = harness;
    const projectId = "c1000000-0000-4000-8000-0000000000a1";
    const canvasId = "c1000000-0000-4000-8000-0000000000a3";
    const keptCanvasId = "c1000000-0000-4000-8000-0000000000a4";
    const past = "2026-08-01T12:00:00.000Z";
    seedProject(connection, projectId);
    connection
      .prepare(
        `INSERT INTO code_thread_projection (
          thread_id, project_id, checkout_id, lifecycle, schema_version, thread_json,
          aggregate_version, updated_at, last_sequence
        ) VALUES (?, ?, 'checkout-a', 'active', 1, '{}', 1, ?, 1)`,
      )
      .run(ids.thread, projectId, past);
    service.setWindow(
      {
        scope: { kind: "project", projectId: decodeProjectId(projectId) },
        window: { kind: "duration-days", days: 7 },
      },
      "local-window",
    );
    journal.append({
      aggregate: { aggregateType: "project-memory", aggregateId: projectId },
      expectedVersion: 0,
      events: [pending("memory.entry-created@1", { entry: memoryEntry(projectId) })],
    });
    appendCanvas(journal, canvasId, projectId);
    appendCanvas(journal, keptCanvasId, "c1000000-0000-4000-8000-0000000000b1");
    appendRaw(connection, "canvas-comments", canvasId, "canvas.comment-created@1", { canvasId });
    appendRaw(connection, "artifact-mirror", canvasId, "canvas.artifact-written@1", { canvasId });
    appendRaw(connection, "canvas-refresh", `${canvasId}-refresh`, "canvas.refresh@1", {
      canvasId,
    });
    connection
      .prepare(
        `INSERT INTO event_quarantine (projection_name, global_sequence, event_id, reason, observed_at)
         SELECT 'canvas', global_sequence, event_id, 'projection-application-failed', ?
         FROM event_journal WHERE aggregate_type = 'canvas' AND aggregate_id = ?`,
      )
      .run(now, canvasId);
    expect(runtime.canvasProjection.getById(decodeCanvasId(canvasId))).toBeDefined();

    const report = await service.purge(
      { scope: { kind: "project", projectId: decodeProjectId(projectId) }, confirm: true },
      "local-window",
    );

    if (!("deleted" in report) || "kind" in report) throw new Error("purge did not report scopes");
    expect(report.deleted).toContain("project-memory");
    expect(report.deleted).toContain("project-canvases");
    expect(
      count(
        connection,
        `SELECT COUNT(*) AS count FROM event_journal
         WHERE aggregate_type IN ('project-memory', 'canvas-comments', 'artifact-mirror', 'canvas-refresh')
            OR (aggregate_type = 'canvas' AND aggregate_id = '${canvasId}')`,
      ),
    ).toBe(0);
    expect(count(connection, "SELECT COUNT(*) AS count FROM project_memory_projection")).toBe(0);
    // Heads and quarantine rows that referenced the removed history leave with
    // it, and the foreign-key relation between them still holds.
    expect(
      count(
        connection,
        `SELECT COUNT(*) AS count FROM aggregate_heads
         WHERE aggregate_type IN ('project-memory', 'canvas-comments', 'artifact-mirror')
            OR (aggregate_type = 'canvas' AND aggregate_id = '${canvasId}')`,
      ),
    ).toBe(0);
    expect(count(connection, "SELECT COUNT(*) AS count FROM event_quarantine")).toBe(0);
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    // The live Canvas projection stops serving the erased Canvas at once, and
    // another Project's Canvas stays.
    expect(runtime.canvasProjection.getById(decodeCanvasId(canvasId))).toBeUndefined();
    expect(runtime.canvasProjection.byProject(decodeProjectId(projectId))).toEqual([]);
    expect(runtime.canvasProjection.getById(decodeCanvasId(keptCanvasId))).toBeDefined();
    expect(harness.erasedCanvasFiles).toEqual([[canvasId]]);

    // A rebuild from the journal cannot resurrect either.
    const projects = runtime.projections.get("projects");
    if (projects === undefined) throw new Error("projects projection must be registered");
    rebuildProjection({ connection, journal, projection: projects, clock: () => now });
    expect(count(connection, "SELECT COUNT(*) AS count FROM project_memory_projection")).toBe(0);
    rebuildProjection({
      connection,
      journal,
      projection: runtime.canvasProjection,
      clock: () => now,
    });
    expect(runtime.canvasProjection.getById(decodeCanvasId(canvasId))).toBeUndefined();
    expect(runtime.canvasProjection.getById(decodeCanvasId(keptCanvasId))).toBeDefined();
  });

  it("evicts a purged thread's Canvas from the live projection", async () => {
    const { connection, journal, runtime, service } = openHarness();
    const projectId = "c1000000-0000-4000-8000-0000000000a1";
    const canvasId = "c1000000-0000-4000-8000-0000000000a3";
    seedChatThread(journal, connection, ids.thread, "Has a canvas", "body");
    appendCanvas(journal, canvasId, projectId, ids.thread);
    expect(runtime.canvasProjection.getById(decodeCanvasId(canvasId))).toBeDefined();
    await service.purge(
      { scope: { kind: "thread", mode: "chat", threadId: ids.thread }, confirm: true },
      "local-window",
    );
    expect(runtime.canvasProjection.getById(decodeCanvasId(canvasId))).toBeUndefined();
  });
});

function seedProject(connection: SqliteConnection, projectId: string): void {
  const project = decodeProject({
    id: projectId,
    name: "Erased project",
    type: "chat",
    lifecycle: "active",
    pinned: false,
    rank: "1/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  connection
    .prepare(
      `INSERT INTO project_projection (
        project_id, schema_version, project_type, lifecycle, pinned, project_json, aggregate_version
      ) VALUES (?, 1, 'chat', 'active', 0, ?, 1)`,
    )
    .run(projectId, JSON.stringify(project));
}

function memoryEntry(projectId: string) {
  return {
    id: "c1000000-0000-4000-8000-0000000000a2",
    projectId,
    kind: "decision",
    content: "Prefers small PRs.",
    provenance: { kind: "user-authored" },
    author: { kind: "local-user", actorId: ids.actor },
    status: "active",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function appendCanvas(
  journal: Journal,
  canvasId: string,
  projectId: string,
  threadId: string = "c1000000-0000-4000-8000-0000000000c1",
): void {
  const provenance = {
    mode: "chat",
    hostId: "local",
    projectId,
    threadId,
    actor: { kind: "local-user", actorId: ids.actor },
    providerInstanceId: ids.provider,
    modelId: "octant-test-model",
    createdAt: now,
  };
  const version = decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId,
    versionId: randomUUID(),
    sequence: 1,
    definition: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Erasable Canvas",
      provenance,
      sourceManifest: [],
      blocks: [
        {
          blockId: "block-1",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "heading",
          level: 1,
          text: "Sensitive heading",
        },
      ],
    },
    createdBy: provenance.actor,
    createdAt: now,
  });
  journal.append({
    aggregate: { aggregateType: "canvas", aggregateId: canvasId },
    expectedVersion: 0,
    events: [pending("canvas.created@1", { canvasId, version })],
  });
}

/** A journaled event with its aggregate head, as the journal itself would leave it. */
function appendRaw(
  connection: SqliteConnection,
  aggregateType: string,
  aggregateId: string,
  eventName: string,
  payload: unknown,
): void {
  const inserted = connection
    .prepare(
      `INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
        correlation_id, actor_kind, actor_id, occurred_at, payload_json, host_id
      ) VALUES (?, ?, ?, 1, ?, 1, ?, 'system', ?, ?, ?, 'local')`,
    )
    .run(
      randomUUID(),
      aggregateType,
      aggregateId,
      eventName,
      ids.correlation,
      ids.actor,
      now,
      JSON.stringify(payload),
    );
  connection
    .prepare(
      `INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence)
       VALUES (?, ?, 1, ?)`,
    )
    .run(aggregateType, aggregateId, Number(inserted.lastInsertRowid));
}

function count(connection: SqliteConnection, sql: string): number {
  return (connection.prepare(sql).get() as { readonly count: number }).count;
}
