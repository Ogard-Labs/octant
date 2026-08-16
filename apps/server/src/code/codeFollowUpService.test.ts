import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeThreadId,
  type AggregateVersion,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { PersistenceService } from "../persistence/persistenceService";
import { rebuildProjection } from "../persistence/projection";
import { CodeFollowUpService } from "./codeFollowUpService";

const directories: Array<string> = [];
const now = "2026-07-21T12:00:00.000Z";
const ids = {
  thread: "20000000-0000-4000-8000-000000000010",
  triggerEvent: "20000000-0000-4000-8000-000000000060",
  replayTrigger: "20000000-0000-4000-8000-000000000061",
  newTrigger: "20000000-0000-4000-8000-000000000062",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-code-follow-up-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function fixture(options?: { readonly lifecycle?: CodeThread["lifecycle"] }): {
  persistence: PersistenceService;
  service: CodeFollowUpService;
} {
  const connection = openConnection();
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const codeThread = {
    id: decodeCodeThreadId(ids.thread),
    lifecycle: options?.lifecycle ?? "active",
    title: "Follow-up thread",
  } as unknown as CodeThread;
  const persistence = {
    connection,
    journal,
    projections: runtime.projections,
    readCodeThread: (threadId: CodeThreadId) =>
      String(threadId) === ids.thread ? codeThread : undefined,
    status: () => ({ state: "current", integrity: "ok" }),
  } as unknown as PersistenceService;
  return {
    persistence,
    service: new CodeFollowUpService({
      persistence,
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    }),
  };
}

const threadId = decodeCodeThreadId(ids.thread);

describe("CodeFollowUpService", () => {
  it("opens follow-up manually and reads it back durably", async () => {
    const { service } = fixture();
    const result = await service.execute({
      kind: "open-code-follow-up",
      threadId,
      expectedVersion: 0 as AggregateVersion,
      reason: "Revisit after review",
      origin: "manual",
      triggerSequence: 1,
    });
    expect(result.followUp.state).toBe("open");
    expect(result.followUp.origin).toBe("manual");

    const view = service.read(threadId);
    expect(view.followUpVersion).toBe(1);
    expect(view.followUp?.state).toBe("open");
    expect(view.followUp?.reason).toBe("Revisit after review");
  });

  it("completes only with matching acknowledgement and never clears on view", async () => {
    const { service } = fixture();
    await service.execute({
      kind: "open-code-follow-up",
      threadId,
      expectedVersion: 0 as AggregateVersion,
      reason: "Approval requested: git-push",
      origin: "automatic",
      triggerSequence: 5,
    });

    // Wrong acknowledgement is rejected as invalid.
    await expect(
      service.execute({
        kind: "complete-code-follow-up",
        threadId,
        expectedVersion: 1 as AggregateVersion,
        acknowledgedThroughSequence: 4,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    const completed = await service.execute({
      kind: "complete-code-follow-up",
      threadId,
      expectedVersion: 1 as AggregateVersion,
      acknowledgedThroughSequence: 5,
    });
    expect(completed.followUp.state).toBe("completed");

    // Reading (viewing) the thread never reopens or clears the marker.
    const view = service.read(threadId);
    expect(view.followUp?.state).toBe("completed");
  });

  it("is idempotent for a replayed automatic trigger and reopens once on a newer one", async () => {
    const { service, persistence } = fixture();
    const first = await service.observeTrigger({
      threadId,
      sourceEventId: ids.triggerEvent,
      sourceSequence: 5,
      reason: "Approval requested: git-push",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(first.state).toBe("open");
    expect(first.triggerSequence).toBe(5);

    const eventsAfterFirst = (
      persistence.connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get() as {
        readonly count: number;
      }
    ).count;

    // Re-delivering the same source event appends nothing (idempotent).
    const replay = await service.observeTrigger({
      threadId,
      sourceEventId: ids.triggerEvent,
      sourceSequence: 5,
      reason: "Approval requested: git-push (replayed)",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(replay.triggerSequence).toBe(5);
    expect(
      (
        persistence.connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get() as {
          readonly count: number;
        }
      ).count,
    ).toBe(eventsAfterFirst);

    // Acknowledge, then a strictly newer trigger reopens exactly once.
    await service.execute({
      kind: "complete-code-follow-up",
      threadId,
      expectedVersion: 1 as AggregateVersion,
      acknowledgedThroughSequence: 5,
    });
    const reopened = await service.observeTrigger({
      threadId,
      sourceEventId: ids.newTrigger,
      sourceSequence: 12,
      reason: "Input requested",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(reopened.state).toBe("open");
    expect(reopened.triggerSequence).toBe(12);
    expect(reopened.acknowledgedThroughSequence).toBe(5);

    // An acknowledged, older source can never reopen it.
    const staleReplay = await service.observeTrigger({
      threadId,
      sourceEventId: ids.replayTrigger,
      sourceSequence: 3,
      reason: "Stale",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(staleReplay.triggerSequence).toBe(12);
  });

  it("rejects follow-up on an unknown or archived thread", async () => {
    const { service } = fixture({ lifecycle: "archived" });
    await expect(
      service.execute({
        kind: "open-code-follow-up",
        threadId,
        expectedVersion: 0 as AggregateVersion,
        reason: "Blocked",
        origin: "manual",
        triggerSequence: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    const missing = fixture().service;
    const other = decodeCodeThreadId("20000000-0000-4000-8000-0000000000ff");
    await expect(
      missing.execute({
        kind: "open-code-follow-up",
        threadId: other,
        expectedVersion: 0 as AggregateVersion,
        reason: "Blocked",
        origin: "manual",
        triggerSequence: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("rebuilds follow-up state from the journal via projection reset", async () => {
    const { service, persistence } = fixture();
    await service.execute({
      kind: "open-code-follow-up",
      threadId,
      expectedVersion: 0 as AggregateVersion,
      reason: "Approval requested: git-push",
      origin: "automatic",
      triggerSequence: 7,
    });

    const projection = persistence.projections.get("code");
    if (projection === undefined) throw new Error("code projection must be registered");
    rebuildProjection({
      connection: persistence.connection,
      journal: persistence.journal,
      projection,
      clock: () => now,
    });
    const view = service.read(threadId);
    expect(view.followUp?.state).toBe("open");
    expect(view.followUp?.triggerSequence).toBe(7);
  });
});
