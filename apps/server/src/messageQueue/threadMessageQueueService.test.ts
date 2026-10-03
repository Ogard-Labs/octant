import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEventActor,
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueueScope,
  WindowId,
  type ThreadMessageQueueSnapshot,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erasePurgedThread } from "../persistence/threadPurge";
import { ThreadRetentionThreadId } from "@octant/contracts";
import { THREAD_RETENTION_AGGREGATE_ID } from "../persistence/threadRetentionProjection";
import { ThreadMessageQueueProjection } from "./threadMessageQueuePersistence";
import { rebuildProjection } from "../persistence/projection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import type {
  ThreadMessageQueueModePort,
  ThreadMessageQueueInspection,
} from "./threadMessageQueuePort";
import { ThreadMessageQueueService } from "./threadMessageQueueService";

const now = "2026-10-03T18:00:00.000Z";
const actor = decodeEventActor({ kind: "system", actorId: randomUUID() });
const windowId = Schema.decodeUnknownSync(WindowId)(randomUUID());
const scope = decodeThreadMessageQueueScope({ mode: "chat", threadId: randomUUID() });
const dirs: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function port() {
  let inspection: ThreadMessageQueueInspection = { status: "ready", binding: "authorized-target" };
  const admit = vi.fn<ThreadMessageQueueModePort["admit"]>(async () => ({ status: "accepted" }));
  const reconcile = vi.fn<ThreadMessageQueueModePort["reconcile"]>(async () => ({
    status: "accepted",
  }));
  const retain = vi.fn<ThreadMessageQueueModePort["retain"]>(() => ({ status: "retained" }));
  const release = vi.fn<ThreadMessageQueueModePort["release"]>(async () => ({
    status: "released",
  }));
  const commit = vi.fn<ThreadMessageQueueModePort["commit"]>();
  return {
    inspect: vi.fn(async () => inspection),
    admit,
    reconcile,
    retain,
    release,
    commit,
    setInspection(value: ThreadMessageQueueInspection) {
      inspection = value;
    },
  };
}
function fixture(p = port(), path?: string) {
  const directory =
    path === undefined ? mkdtempSync(join(tmpdir(), "octant-thread-queue-")) : undefined;
  if (directory) dirs.push(directory);
  const database = path ?? join(directory ?? "", "events.sqlite3");
  const connection = openSqlite(database);
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const service = new ThreadMessageQueueService({
    connection,
    journal,
    port: p,
    actor,
    clock: () => now,
  });
  return {
    connection,
    journal,
    service,
    p,
    database,
    runtime,
    close() {
      service.dispose();
      connection.close();
      connections.splice(connections.indexOf(connection), 1);
    },
  };
}
async function snapshot(
  service: ThreadMessageQueueService,
  reader = windowId,
): Promise<ThreadMessageQueueSnapshot> {
  const read = await service.read(reader, scope);
  if (read.status !== "ready") throw new Error(read.reason);
  return read.snapshot;
}
function enqueue(expectedVersion = 0, messageId = randomUUID(), prompt = "private prompt") {
  const result = decodeThreadMessageQueueCommand({
    kind: "enqueue",
    scope,
    requestId: randomUUID(),
    expectedVersion,
    messageId,
    payload: { mode: "chat", prompt },
  });
  if (result.kind !== "enqueue") throw new Error("Expected enqueue");
  return result;
}
function command(
  kind: string,
  expectedVersion: number,
  fields: Readonly<Record<string, unknown>> = {},
) {
  return decodeThreadMessageQueueCommand({
    kind,
    scope,
    requestId: randomUUID(),
    expectedVersion,
    ...fields,
  });
}
describe("durable ordinary thread queue", () => {
  it("keeps private bodies out of the journal and holds pending work after reopening", async () => {
    const f = fixture();
    const c = enqueue();
    expect((await f.service.execute(windowId, c)).status).toBe("applied");
    expect(
      JSON.stringify(f.connection.prepare("SELECT payload_json FROM event_journal").all()),
    ).not.toContain("private prompt");
    expect((await snapshot(f.service)).items[0]?.payload?.prompt).toBe("private prompt");
    f.close();
    const reopened = fixture(port(), f.database);
    await reopened.service.recover();
    expect((await snapshot(reopened.service)).holdReason).toBe("host-restart");
    await reopened.service.tick();
    expect(reopened.p.admit).not.toHaveBeenCalled();
    expect(reopened.p.retain).toHaveBeenCalledWith(expect.objectContaining({ reason: "restore" }));
    expect((await reopened.service.execute(windowId, c)).status).toBe("duplicate");
  });
  it("serializes competing edits and preserves removed UUID tombstones", async () => {
    const f = fixture();
    const c = enqueue();
    await f.service.execute(windowId, c);
    const competing = await Promise.all([
      f.service.execute(windowId, command("edit", 1, { messageId: c.messageId, prompt: "first" })),
      f.service.execute(windowId, command("edit", 1, { messageId: c.messageId, prompt: "second" })),
    ]);
    expect(competing.map((x) => x.status)).toEqual(["applied", "conflict"]);
    expect((await snapshot(f.service)).items[0]?.payload?.prompt).toBe("first");
    await f.service.execute(windowId, command("remove", 2, { messageId: c.messageId }));
    expect((await f.service.execute(windowId, c)).status).toBe("duplicate");
    expect((await snapshot(f.service)).items).toEqual([]);
    expect(
      f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
    ).toEqual([]);
  });
  it("sends only one item at a time and advances only after durable normal completion", async () => {
    const f = fixture();
    const first = enqueue();
    const second = enqueue(1);
    await f.service.execute(windowId, first);
    await f.service.execute(windowId, second);
    await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
    expect(f.p.admit).toHaveBeenCalledTimes(1);
    expect(f.p.admit.mock.calls[0]?.[0].messageId).toBe(first.messageId);
    f.p.reconcile.mockResolvedValue({ status: "completed" });
    await f.service.tick();
    expect(f.p.admit).toHaveBeenCalledTimes(2);
    expect(f.p.admit.mock.calls[1]?.[0].messageId).toBe(second.messageId);
    await f.service.tick();
    expect((await snapshot(f.service)).items).toEqual([]);
    expect((await f.service.execute(windowId, first)).status).toBe("duplicate");
  });
  it("holds uncertain delivery across restart and requires durable absence plus explicit resume", async () => {
    const f = fixture();
    const first = enqueue();
    await f.service.execute(windowId, first);
    f.p.admit.mockResolvedValue({ status: "unknown" });
    f.p.reconcile.mockResolvedValue({ status: "unknown" });
    await f.service.tick();
    expect((await snapshot(f.service)).holdReason).toBe("delivery-unknown");
    f.close();
    const restored = fixture(port(), f.database);
    restored.p.reconcile.mockResolvedValue({ status: "unknown" });
    await restored.service.recover();
    await restored.service.tick();
    expect(restored.p.admit).not.toHaveBeenCalled();
    let state = await snapshot(restored.service);
    expect(
      (await restored.service.execute(windowId, command("resume", state.version))).status,
    ).toBe("refused");
    restored.p.reconcile.mockResolvedValue({ status: "not-admitted" });
    await restored.service.tick();
    state = await snapshot(restored.service);
    expect(state.items[0]?.status).toBe("queued");
    expect(restored.p.admit).not.toHaveBeenCalled();
    await restored.service.execute(windowId, command("resume", state.version));
    await restored.service.tick();
    expect(restored.p.admit.mock.calls[0]?.[0].messageId).toBe(first.messageId);
  });
  it("allows an acknowledged old failure but holds new failures and target changes", async () => {
    const f = fixture();
    f.p.setInspection({
      status: "ready",
      binding: "authorized-target",
      tail: { id: "old-failure", status: "failed" },
    });
    await f.service.execute(windowId, enqueue());
    await f.service.tick();
    expect(f.p.admit).toHaveBeenCalledTimes(1);
    let state = await snapshot(f.service);
    await f.service.execute(windowId, enqueue(state.version));
    f.p.reconcile.mockResolvedValue({ status: "failed" });
    await f.service.tick();
    state = await snapshot(f.service);
    expect(state.holdReason).toBe("failed");
    expect(f.p.admit).toHaveBeenCalledTimes(1);
    f.p.setInspection({ status: "ready", binding: "different-target" });
    expect(await f.service.execute(windowId, command("resume", state.version))).toMatchObject({
      status: "refused",
      reason: "binding-changed",
    });
    f.p.setInspection({
      status: "ready",
      binding: "authorized-target",
      tail: { id: "new-failure", status: "failed" },
    });
    await f.service.execute(windowId, command("resume", state.version));
    await f.service.tick();
    expect(f.p.admit).toHaveBeenCalledTimes(2);
  });
  it("refuses unauthorized reads and commands without exposing private payloads", async () => {
    const f = fixture();
    await f.service.execute(windowId, enqueue());
    f.p.setInspection({ status: "held", reason: "unauthorized" });
    expect(await f.service.read(windowId, scope)).toEqual({
      status: "refused",
      reason: "unauthorized",
    });
    expect(await f.service.execute(windowId, enqueue(1))).toMatchObject({
      status: "refused",
      reason: "unauthorized",
    });
    await f.service.tick();
    expect(f.p.admit).not.toHaveBeenCalled();
  });
  it("reorders pending messages and refuses attempts to move an accepted item", async () => {
    const f = fixture();
    const a = enqueue();
    const b = enqueue(1);
    await f.service.execute(windowId, a);
    await f.service.execute(windowId, b);
    await f.service.execute(
      windowId,
      command("reorder", 2, { messageIds: [b.messageId, a.messageId] }),
    );
    await f.service.tick();
    expect(f.p.admit.mock.calls[0]?.[0].messageId).toBe(b.messageId);
    const state = await snapshot(f.service);
    expect(
      await f.service.execute(
        windowId,
        command("reorder", state.version, { messageIds: [a.messageId, b.messageId] }),
      ),
    ).toMatchObject({ status: "refused", reason: "not-editable" });
  });
  it("cancels an in-flight admission immediately when the authorizing window is revoked", async () => {
    const f = fixture();
    await f.service.execute(windowId, enqueue());
    f.p.admit.mockImplementation(
      async (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener("abort", () => resolve({ status: "unknown" }), {
            once: true,
          });
        }),
    );
    const tick = f.service.tick();
    await vi.waitFor(() => expect(f.p.admit).toHaveBeenCalledTimes(1));
    const revoked = f.service.revokeWindow(windowId);
    await Promise.all([tick, revoked]);
    expect(f.p.admit.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(
      (await snapshot(f.service, Schema.decodeUnknownSync(WindowId)(randomUUID()))).holdReason,
    ).toBe("authority-revoked");
  });
  it("does not restore an authorization revoked while enqueue inspection was pending", async () => {
    const f = fixture();
    let finish: ((value: ThreadMessageQueueInspection) => void) | undefined;
    f.p.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.service.execute(windowId, enqueue());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await f.service.revokeWindow(windowId);
    finish?.({ status: "ready", binding: "authorized-target" });
    expect(await pending).toMatchObject({ status: "refused", reason: "authority-revoked" });
    await f.service.tick();
    expect(f.p.admit).not.toHaveBeenCalled();
  });
  it("pins before the private append and keeps trusted metadata for cleanup retries", async () => {
    const f = fixture();
    const c = enqueue();
    f.p.retain.mockReturnValue({
      status: "retained",
      privateContextJson: JSON.stringify({ trusted: "private references" }),
    });
    f.p.commit.mockImplementation((input) => {
      expect(
        f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
      ).toHaveLength(1);
      expect(input.privateContextJson).toContain("private references");
    });
    await f.service.execute(windowId, c);
    expect(
      JSON.stringify(f.connection.prepare("SELECT payload_json FROM event_journal").all()),
    ).not.toContain("private references");
    f.p.release.mockResolvedValueOnce({ status: "refused" });
    await f.service.execute(windowId, command("remove", 1, { messageId: c.messageId }));
    expect(
      f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
    ).toHaveLength(1);
    await f.service.tick();
    expect(
      f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
    ).toHaveLength(0);
  });

  it("refuses changed enqueue identities and changed command receipts even after removal", async () => {
    const f = fixture();
    const c = enqueue();
    await f.service.execute(windowId, c);
    expect(
      await f.service.execute(windowId, { ...c, payload: { ...c.payload, prompt: "different" } }),
    ).toMatchObject({ status: "refused", reason: "invalid-payload" });
    const remove = command("remove", 1, { messageId: c.messageId });
    await f.service.execute(windowId, remove);
    expect((await f.service.execute(windowId, c)).status).toBe("duplicate");
    expect(
      await f.service.execute(windowId, {
        ...c,
        requestId: command("pause", 2).requestId,
        payload: { ...c.payload, prompt: "different" },
      }),
    ).toMatchObject({ status: "refused", reason: "invalid-payload" });
    expect(
      await f.service.execute(
        windowId,
        decodeThreadMessageQueueCommand({
          kind: "pause",
          scope,
          expectedVersion: 1,
          requestId: remove.requestId,
        }),
      ),
    ).toMatchObject({ status: "refused", reason: "invalid-payload" });
  });
  it("does not write an admission result after synchronous disposal", async () => {
    const f = fixture();
    await f.service.execute(windowId, enqueue());
    let finish: ((value: { status: "accepted" }) => void) | undefined;
    f.p.admit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const tick = f.service.tick();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const before = f.journal.headSequence();
    f.service.dispose();
    finish?.({ status: "accepted" });
    await tick;
    expect(f.journal.headSequence()).toBe(before);
  });

  it("atomically rolls back private bodies and returns draft ownership when append fails", async () => {
    const f = fixture();
    f.connection.exec(
      "CREATE TRIGGER refuse_append BEFORE INSERT ON event_journal BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END;",
    );
    expect(await f.service.execute(windowId, enqueue())).toMatchObject({
      status: "refused",
      reason: "storage-unavailable",
    });
    expect(
      f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
    ).toEqual([]);
    expect(f.p.release).toHaveBeenCalledWith(expect.objectContaining({ reason: "rollback" }));
    expect(f.p.commit).not.toHaveBeenCalled();
  });
  it("replays metadata without restoring private bodies and retains idempotency tombstones", async () => {
    const f = fixture();
    const c = enqueue();
    await f.service.execute(windowId, c);
    f.connection.exec("DELETE FROM thread_message_queue_content");
    rebuildProjection({
      connection: f.connection,
      journal: f.journal,
      projection: new ThreadMessageQueueProjection(),
      clock: () => now,
    });
    expect((await snapshot(f.service)).items[0]?.payload).toBeUndefined();
    await f.service.tick();
    expect((await snapshot(f.service)).holdReason).toBe("content-unavailable");
    expect(f.p.admit).not.toHaveBeenCalled();
    expect((await f.service.execute(windowId, c)).status).toBe("duplicate");
  });
  it("purges private queue content in the deletion transaction and cannot resurrect it on restart", async () => {
    const f = fixture();
    const c = enqueue();
    await f.service.execute(windowId, c);
    f.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: scope.threadId },
      expectedVersion: 0,
      events: [
        {
          eventId: randomUUID(),
          eventName: "chat.thread-created@1",
          eventVersion: 1,
          correlationId: randomUUID(),
          actor,
          occurredAt: now,
          payload: {
            kind: "thread-created",
            thread: {
              id: scope.threadId,
              title: "Queued conversation",
              lifecycle: "active",
              providerInstanceId: randomUUID(),
              modelId: "model-a",
              researchEnabled: false,
              researchRouting: "automatic",
              personalityInstructions: "Be concise.",
              version: 1,
              createdAt: now,
              updatedAt: now,
            },
          },
        },
      ],
    });
    const append = f.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: scope.threadId },
      expectedVersion: 1,
      events: [
        {
          eventId: randomUUID(),
          eventName: "chat.deleted@1",
          eventVersion: 1,
          correlationId: randomUUID(),
          actor,
          occurredAt: now,
          payload: { kind: "deleted", threadId: scope.threadId, deletedAt: now },
        },
      ],
    });
    expect(
      f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
    ).toEqual([]);
    await f.service.onCommittedAppend(append);
    expect(f.p.release).toHaveBeenCalledWith(expect.objectContaining({ reason: "purged" }));
    f.close();
    const reopened = fixture(port(), f.database);
    await reopened.service.recover();
    expect(reopened.p.retain).not.toHaveBeenCalled();
    expect(await reopened.service.read(windowId, scope)).toMatchObject({
      status: "refused",
      reason: "thread-unavailable",
    });
    rebuildProjection({
      connection: reopened.connection,
      journal: reopened.journal,
      projection: new ThreadMessageQueueProjection(),
      clock: () => now,
    });
    expect(await reopened.service.execute(windowId, c)).toMatchObject({
      status: "refused",
      reason: "thread-unavailable",
    });
  });
  it("recognizes a durable accepted turn after losing its acknowledgment across SQLite reopen", async () => {
    const f = fixture();
    f.connection.exec("CREATE TABLE fixture_turns(message_id TEXT PRIMARY KEY) STRICT");
    f.p.admit.mockImplementation(async (input) => {
      f.connection.prepare("INSERT INTO fixture_turns(message_id) VALUES(?)").run(input.messageId);
      return { status: "unknown" };
    });
    const c = enqueue();
    await f.service.execute(windowId, c);
    await f.service.tick();
    f.close();
    const reopened = fixture(port(), f.database);
    reopened.p.reconcile.mockImplementation(async (input) => ({
      status:
        reopened.connection
          .prepare("SELECT 1 FROM fixture_turns WHERE message_id=?")
          .get(input.messageId) === undefined
          ? "not-admitted"
          : "completed",
    }));
    await reopened.service.recover();
    await reopened.service.tick();
    expect(reopened.p.admit).not.toHaveBeenCalled();
    expect((await snapshot(reopened.service)).items).toEqual([]);
    expect((await reopened.service.execute(windowId, c)).status).toBe("duplicate");
  });
  it("bounds item counts and rejects oversized private context before durable acceptance", async () => {
    const f = fixture();
    f.p.retain.mockReturnValueOnce({
      status: "retained",
      privateContextJson: JSON.stringify({ body: "x".repeat(65536) }),
    });
    expect((await f.service.execute(windowId, enqueue())).status).toBe("refused");
    expect(f.p.release).toHaveBeenCalledWith(expect.objectContaining({ reason: "rollback" }));
    for (let index = 0; index < 32; index++)
      expect((await f.service.execute(windowId, enqueue(index))).status).toBe("applied");
    expect(await f.service.execute(windowId, enqueue(32))).toMatchObject({
      status: "refused",
      reason: "queue-full",
    });
  });
  it.each(["chat", "work", "code"])(
    "erases queue fingerprints and journal ownership on a %s thread purge",
    async (mode) => {
      const f = fixture();
      const target = decodeThreadMessageQueueScope({ mode, threadId: randomUUID() });
      const c = decodeThreadMessageQueueCommand({
        kind: "enqueue",
        scope: target,
        requestId: randomUUID(),
        expectedVersion: 0,
        messageId: randomUUID(),
        payload: { mode, prompt: "private queued body" },
      });
      expect((await f.service.execute(windowId, c)).status).toBe("applied");
      f.journal.append({
        aggregate: {
          aggregateType: "thread-retention",
          aggregateId: THREAD_RETENTION_AGGREGATE_ID,
        },
        expectedVersion: 0,
        events: [
          {
            eventId: randomUUID(),
            eventName: "thread-retention.thread-purged@1",
            eventVersion: 1,
            correlationId: randomUUID(),
            actor,
            occurredAt: now,
            payload: { kind: "thread-purged", mode, threadId: target.threadId, purgedAt: now },
          },
        ],
      });
      expect(
        f.connection.prepare("SELECT message_id FROM thread_message_queue_identity").all(),
      ).toEqual([]);
      expect(
        f.connection.prepare("SELECT request_id FROM thread_message_queue_receipt").all(),
      ).toEqual([]);
      expect(
        f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
      ).toEqual([]);
      erasePurgedThread({
        connection: f.connection,
        mode: target.mode,
        threadId: Schema.decodeUnknownSync(ThreadRetentionThreadId)(target.threadId),
      });
      expect(
        f.connection
          .prepare("SELECT event_id FROM event_journal WHERE aggregate_type='thread-message-queue'")
          .all(),
      ).toEqual([]);
      rebuildProjection({
        connection: f.connection,
        journal: f.journal,
        projection: new ThreadMessageQueueProjection(),
        clock: () => now,
      });
      expect(
        f.connection.prepare("SELECT message_id FROM thread_message_queue_identity").all(),
      ).toEqual([]);
      const reopened = fixture(port(), f.database);
      await reopened.service.recover();
      expect(reopened.p.retain).not.toHaveBeenCalled();
      expect(await reopened.service.execute(windowId, c)).toMatchObject({
        status: "refused",
        reason: "thread-unavailable",
      });
    },
  );
  it("keeps paused and busy queues idle until explicit resume and ordinary mode readiness", async () => {
    const f = fixture();
    await f.service.execute(windowId, enqueue());
    await f.service.execute(windowId, command("pause", 1));
    await f.service.tick();
    expect(f.p.admit).not.toHaveBeenCalled();
    f.p.setInspection({
      status: "busy",
      binding: "authorized-target",
      tail: { id: "active", status: "active" },
    });
    await f.service.execute(windowId, command("resume", 2));
    await f.service.tick();
    expect(f.p.admit).not.toHaveBeenCalled();
    f.p.setInspection({
      status: "ready",
      binding: "authorized-target",
      tail: { id: "active", status: "completed" },
    });
    await f.service.tick();
    expect(f.p.admit).toHaveBeenCalledTimes(1);
  });
  it("bounds the combined private queue bytes and refuses cleanup completion on release failure", async () => {
    const f = fixture();
    for (let index = 0; index < 20; index++)
      expect(
        (await f.service.execute(windowId, enqueue(index, randomUUID(), "x".repeat(200000))))
          .status,
      ).toBe("applied");
    expect(
      await f.service.execute(windowId, enqueue(20, randomUUID(), "x".repeat(200000))),
    ).toMatchObject({ status: "refused", reason: "queue-full" });
    f.p.release.mockResolvedValue({ status: "refused" });
    expect(await f.service.purgeThread(scope)).toEqual({ status: "refused" });
    expect(await f.service.execute(windowId, enqueue(21))).toMatchObject({
      status: "refused",
      reason: "thread-unavailable",
    });
    expect(
      f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
    ).toHaveLength(20);
    f.p.release.mockResolvedValue({ status: "released" });
    expect(await f.service.purgeThread(scope)).toEqual({ status: "released" });
    expect(
      f.connection.prepare("SELECT message_id FROM thread_message_queue_content").all(),
    ).toHaveLength(0);
  });
  it("refuses resume without writing when disposal happens during its item authorization", async () => {
    const f = fixture();
    await f.service.execute(windowId, enqueue());
    let finish: ((value: ThreadMessageQueueInspection) => void) | undefined;
    f.p.inspect
      .mockResolvedValueOnce({ status: "ready", binding: "authorized-target" })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const pending = f.service.execute(windowId, command("resume", 1));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const before = f.journal.headSequence();
    f.service.dispose();
    finish?.({ status: "ready", binding: "authorized-target" });
    expect(await pending).toMatchObject({ status: "refused", reason: "authority-revoked" });
    await f.service.awaitIdle();
    expect(f.journal.headSequence()).toBe(before);
  });
});
