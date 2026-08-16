import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { catchUpProjection, rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";
import {
  readRootlessThread,
  readRootlessThreads,
  readRootlessThreadList,
  readUnfiledRootlessThreads,
} from "./rootlessProjection";

const directories: Array<string> = [];
const now = "2026-07-25T10:00:00.000Z";
const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  correlation: "00000000-0000-4000-8000-000000000002",
  thread: "00000000-0000-4000-8000-000000000011",
  attachment: "00000000-0000-4000-8000-000000000010",
  project: "00000000-0000-4000-8000-000000000012",
  provider: "00000000-0000-4000-8000-000000000003",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("rootless persistence restart", () => {
  it("restores rootless thread state and attachment transition across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });

    firstJournal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000100",
          eventName: "rootless.thread-created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "thread-created",
            threadId: ids.thread,
            title: "Unfiled brief",
            mode: "work",
            hostId: "local",
            providerInstanceId: ids.provider,
            modelId: "model-a",
            workspace: { kind: "rootless" },
            createdAt: now,
          },
        },
      ],
    });

    expect(readRootlessThread(first, ids.thread as never)?.workspaceKind).toBe("rootless");
    expect(readUnfiledRootlessThreads(first)).toHaveLength(1);

    firstJournal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: ids.thread },
      expectedVersion: 1,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000101",
          eventName: "rootless.folder-attached@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "folder-attached",
            attachmentId: ids.attachment,
            threadId: ids.thread,
            projectId: ids.project,
            attachedAt: now,
          },
        },
      ],
    });

    expect(readRootlessThread(first, ids.thread as never)?.workspaceKind).toBe("project-backed");
    expect(readUnfiledRootlessThreads(first)).toHaveLength(0);
    first.close();

    const reopened = openSqlite(path);
    applyMigrations(reopened, MIGRATIONS, () => now);
    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    const rootlessProjection = restartedRuntime.projections.get("rootless");
    if (rootlessProjection === undefined) throw new Error("rootless projection must be registered");

    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: reopened,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }

    const restored = readRootlessThread(reopened, ids.thread as never);
    expect(restored?.workspaceKind).toBe("project-backed");
    expect(String(restored?.projectId)).toBe(ids.project);
    expect(readRootlessThreads(reopened)).toHaveLength(1);
    expect(readUnfiledRootlessThreads(reopened)).toHaveLength(0);

    rebuildProjection({
      connection: reopened,
      journal: restartedJournal,
      projection: rootlessProjection,
      clock: () => now,
    });

    expect(readRootlessThread(reopened, ids.thread as never)?.workspaceKind).toBe("project-backed");
    expect(readUnfiledRootlessThreads(reopened)).toHaveLength(0);
    reopened.close();
  });

  it("keeps a thread rootless after a folder-attachment-denied event across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-denied-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });

    firstJournal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000200",
          eventName: "rootless.thread-created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "thread-created",
            threadId: ids.thread,
            title: "Unfiled change",
            mode: "code",
            hostId: "local",
            providerInstanceId: ids.provider,
            modelId: "model-a",
            workspace: { kind: "rootless" },
            createdAt: now,
          },
        },
      ],
    });
    firstJournal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: ids.thread },
      expectedVersion: 1,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000201",
          eventName: "rootless.folder-attachment-denied@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "folder-attachment-denied",
            attachmentId: ids.attachment,
            threadId: ids.thread,
            reason: "concurrent-turn",
            message: "Cannot attach during an active turn.",
            deniedAt: now,
          },
        },
      ],
    });
    first.close();

    const reopened = openSqlite(path);
    applyMigrations(reopened, MIGRATIONS, () => now);
    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });

    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: reopened,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }

    const restored = readRootlessThread(reopened, ids.thread as never);
    expect(restored?.workspaceKind).toBe("rootless");
    expect(restored?.projectId).toBeNull();
    expect(readUnfiledRootlessThreads(reopened)).toHaveLength(1);
    reopened.close();
  });

  it("groups threads into recents, all, and unfiled in the list result", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-list-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const connection = openSqlite(path);
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });

    const threadA = "00000000-0000-4000-8000-000000000031";
    const threadB = "00000000-0000-4000-8000-000000000032";
    const threadC = "00000000-0000-4000-8000-000000000033";

    // Thread A: rootless work
    journal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: threadA },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000301",
          eventName: "rootless.thread-created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "thread-created",
            threadId: threadA,
            title: "Thread A",
            mode: "work",
            hostId: "local",
            providerInstanceId: ids.provider,
            modelId: "model-a",
            workspace: { kind: "rootless" },
            createdAt: now,
          },
        },
      ],
    });

    // Thread B: rootless code, then attached to project
    journal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: threadB },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000302",
          eventName: "rootless.thread-created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "thread-created",
            threadId: threadB,
            title: "Thread B",
            mode: "code",
            hostId: "local",
            providerInstanceId: ids.provider,
            modelId: "model-a",
            workspace: { kind: "rootless" },
            createdAt: now,
          },
        },
      ],
    });
    journal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: threadB },
      expectedVersion: 1,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000303",
          eventName: "rootless.folder-attached@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "folder-attached",
            attachmentId: ids.attachment,
            threadId: threadB,
            projectId: ids.project,
            attachedAt: now,
          },
        },
      ],
    });

    // Thread C: rootless work (unfiled)
    journal.append({
      aggregate: { aggregateType: "rootless-thread", aggregateId: threadC },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000304",
          eventName: "rootless.thread-created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "thread-created",
            threadId: threadC,
            title: "Thread C",
            mode: "work",
            hostId: "local",
            providerInstanceId: ids.provider,
            modelId: "model-a",
            workspace: { kind: "rootless" },
            createdAt: now,
          },
        },
      ],
    });

    const list = readRootlessThreadList(connection);
    expect(list.all).toHaveLength(3);
    expect(list.unfiled).toHaveLength(2);
    expect(list.unfiled.every((s) => s.workspaceKind === "rootless")).toBe(true);
    expect(list.recents.length).toBeLessThanOrEqual(20);
    expect(list.recents).toHaveLength(3);

    const projectBacked = list.all.find((s) => s.workspaceKind === "project-backed");
    expect(projectBacked).toBeDefined();
    expect(String(projectBacked?.projectId)).toBe(ids.project);

    connection.close();
  });
});
