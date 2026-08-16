import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ReplayCursor } from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import { EventRegistry } from "./eventRegistry";
import { Journal } from "./journal";
import { DuplicateEventIdentity } from "./journalErrors";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { ProjectionRegistry, rebuildProjection } from "./projection";
import { verifyDatabase } from "./recovery";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";
const fixturePath = fileURLToPath(new URL("./crashFixture.ts", import.meta.url));
const replayCursor = Schema.decodeUnknownSync(ReplayCursor);
const ids = {
  aggregate: "00000000-0000-4000-8000-000000000801",
  actor: "00000000-0000-4000-8000-000000000802",
  correlation: "00000000-0000-4000-8000-000000000803",
  event: "00000000-0000-4000-8000-000000000804",
} as const;

interface CrashResult {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly projections: ProjectionRegistry;
}

type CrashChild = ChildProcessByStdio<null, Readable, null>;
type CrashMode = "before-commit" | "after-commit" | "synchronization-failure";

function appendRequest() {
  return {
    aggregate: { aggregateType: "fixture", aggregateId: ids.aggregate },
    expectedVersion: 0,
    events: [
      {
        eventId: ids.event,
        eventName: "fixture.recorded",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { value: "synthetic-crash-fixture" },
      },
    ],
  };
}

function count(connection: SqliteConnection, table: string): number {
  return (connection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function reopen(databasePath: string): CrashResult {
  const connection = openSqlite(databasePath);
  applyMigrations(connection, MIGRATIONS, () => now);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({
    connection,
    projections,
    registry: new EventRegistry().register(
      "fixture.recorded",
      1,
      Schema.Struct({ value: Schema.String }),
    ),
    clock: () => now,
  });
  return { connection, journal, projections };
}

async function waitForReady(child: CrashChild): Promise<void> {
  child.stdout.setEncoding("utf8");
  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("OCTANT_CRASH_SYNC_FAILURE\n")) {
        cleanup();
        reject(new Error("crash fixture reported synchronization failure"));
        return;
      }
      if (stdout.includes("OCTANT_CRASH_READY\n")) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("crash fixture exited before synchronization"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("crash fixture failed before synchronization"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("crash fixture synchronization timed out"));
    }, 10_000);
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function runCrashFixture(
  mode: CrashMode,
  onSpawned?: (child: CrashChild, directory: string) => void,
): Promise<CrashResult> {
  const directory = mkdtempSync(join(tmpdir(), "octant-crash-"));
  directories.push(directory);
  const databasePath = join(directory, "events.sqlite3");
  const child = spawn("bun", [fixturePath, mode, databasePath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  onSpawned?.(child, directory);
  let killSent = false;

  try {
    await waitForReady(child);
    killSent = child.kill("SIGKILL");
    expect(killSent).toBe(true);
  } finally {
    const childIsLive =
      child.pid !== undefined && child.exitCode === null && child.signalCode === null;
    if (!killSent && childIsLive) killSent = child.kill("SIGKILL");
    if (killSent || child.pid !== undefined) await closed;
  }
  expect(child.signalCode).toBe("SIGKILL");

  return reopen(databasePath);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("event store crash recovery", () => {
  it("waits for forced child closure when synchronization fails", async () => {
    let childClosed = false;
    let childPid: number | undefined;
    let directory: string | undefined;

    await expect(
      runCrashFixture("synchronization-failure", (child, spawnedDirectory) => {
        childPid = child.pid;
        directory = spawnedDirectory;
        child.once("close", () => {
          childClosed = true;
        });
      }),
    ).rejects.toThrow("crash fixture reported synchronization failure");

    expect(childClosed).toBe(true);
    expect(isProcessRunning(childPid)).toBe(false);
    const cleanupDirectory = directory;
    expect(cleanupDirectory).toBeDefined();
    if (cleanupDirectory === undefined) {
      throw new Error("crash fixture directory was not recorded");
    }
    expect(() => rmSync(cleanupDirectory, { recursive: true })).not.toThrow();
  });

  it("leaves no attempted work when killed before commit", async () => {
    const { connection, journal, projections } = await runCrashFixture("before-commit");

    try {
      expect(count(connection, "event_journal")).toBe(0);
      expect(count(connection, "aggregate_heads")).toBe(0);
      expect(count(connection, "projection_checkpoints")).toBe(0);
      expect(journal.replay(replayCursor({ afterSequence: 0, limit: 10 }))).toEqual([]);
      expect(verifyDatabase({ connection, journal, projections })).toMatchObject({ valid: true });
    } finally {
      connection.close();
    }
  });

  it("preserves exactly one complete append when killed after commit", async () => {
    const { connection, journal, projections } = await runCrashFixture("after-commit");

    try {
      expect(count(connection, "event_journal")).toBe(1);
      expect(count(connection, "aggregate_heads")).toBe(1);
      expect(count(connection, "projection_checkpoints")).toBe(1);
      expect(journal.replay(replayCursor({ afterSequence: 0, limit: 10 }))).toMatchObject([
        {
          eventId: ids.event,
          globalSequence: 1,
          aggregateVersion: 1,
          payload: { value: "synthetic-crash-fixture" },
        },
      ]);
      expect(
        connection.prepare("SELECT aggregate_version, last_sequence FROM aggregate_heads").get(),
      ).toEqual({ aggregate_version: 1, last_sequence: 1 });
      expect(
        connection
          .prepare("SELECT projection_name, last_sequence FROM projection_checkpoints")
          .get(),
      ).toEqual({ projection_name: "aggregate-heads", last_sequence: 1 });
      expect(() => journal.append(appendRequest())).toThrow(DuplicateEventIdentity);
      expect(count(connection, "event_journal")).toBe(1);
      const projection = projections.get("aggregate-heads");
      expect(projection).toBeDefined();
      if (projection === undefined) throw new Error("aggregate-heads projection is not registered");
      expect(
        rebuildProjection({
          connection,
          journal,
          projection,
          clock: () => now,
        }),
      ).toMatchObject({ lastSequence: 1 });
      expect(verifyDatabase({ connection, journal, projections })).toMatchObject({ valid: true });
    } finally {
      connection.close();
    }
  });
});

function isProcessRunning(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
