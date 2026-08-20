import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChatThread, decodeChatThreadId } from "@octant/contracts";
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
  const service = new ThreadRetentionService({
    connection,
    journal,
    clock: () => now,
    uuid: randomUUID,
    listWorkThreads: () => [],
  });
  return { connection, journal, service, runtime };
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
});
