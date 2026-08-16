import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupVerificationFailed, PathOutsideDataDirectory } from "./dataLifecycleErrors";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import {
  backupPathFor,
  createStoreBackup,
  restoreStoreBackup,
  verifyStoreBackup,
} from "./storeBackup";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";

function temporaryStore(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "octant-store-backup-"));
  directories.push(directory);
  return { directory, databasePath: join(directory, "octant.sqlite3") };
}

function seedEvent(connection: SqliteConnection, marker: string): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, correlation_id, causation_id,
        actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, 'fixture', ?, 1, 'fixture.recorded', 1, ?, NULL, 'system', ?, ?, ?)
    `)
    .run(
      `11111111-1111-4111-8111-${marker.padStart(12, "0")}`,
      `22222222-2222-4222-8222-${marker.padStart(12, "0")}`,
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      now,
      JSON.stringify({ value: marker }),
    );
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createStoreBackup", () => {
  it("writes a verified, self-contained snapshot without WAL sidecars", () => {
    const { directory, databasePath } = temporaryStore();
    const connection = openSqlite(databasePath);
    applyMigrations(connection, MIGRATIONS, () => now);
    seedEvent(connection, "1");

    const backupPath = backupPathFor(databasePath, "pre-migration");
    const receipt = createStoreBackup({
      connection,
      dataDirectory: directory,
      backupPath,
    });
    connection.close();

    expect(receipt.migrationVersion).toBe(MIGRATIONS.at(-1)!.version);
    expect(receipt.journalHead).toBe(1);
    expect(receipt.byteLength).toBeGreaterThan(0);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(`${backupPath}-wal`)).toBe(false);
    expect(existsSync(`${backupPath}-shm`)).toBe(false);
  });

  it("overwrites a stale backup file so the operation is repeatable", () => {
    const { directory, databasePath } = temporaryStore();
    const connection = openSqlite(databasePath);
    applyMigrations(connection, MIGRATIONS, () => now);
    const backupPath = backupPathFor(databasePath, "pre-migration");
    writeFileSync(backupPath, "stale-not-a-database");

    expect(() =>
      createStoreBackup({ connection, dataDirectory: directory, backupPath }),
    ).not.toThrow();
    connection.close();
    expect(verifyStoreBackup({ dataDirectory: directory, backupPath }).migrationVersion).toBe(
      MIGRATIONS.at(-1)!.version,
    );
  });

  it("refuses to write a backup outside the data directory", () => {
    const { directory, databasePath } = temporaryStore();
    const connection = openSqlite(databasePath);
    applyMigrations(connection, MIGRATIONS, () => now);

    expect(() =>
      createStoreBackup({
        connection,
        dataDirectory: directory,
        backupPath: join(tmpdir(), "escape.sqlite3"),
      }),
    ).toThrow(PathOutsideDataDirectory);
    connection.close();
  });
});

describe("verifyStoreBackup", () => {
  it("rejects a file that is not an Octant store", () => {
    const { directory } = temporaryStore();
    const backupPath = join(directory, "octant.sqlite3.backup-broken");
    const scratch = openSqlite(backupPath);
    scratch.exec("CREATE TABLE unrelated (id INTEGER) STRICT;");
    scratch.close();

    expect(() => verifyStoreBackup({ dataDirectory: directory, backupPath })).toThrow(
      BackupVerificationFailed,
    );
  });

  it("rejects a missing backup as unreadable", () => {
    const { directory } = temporaryStore();
    let observed: unknown;
    try {
      verifyStoreBackup({
        dataDirectory: directory,
        backupPath: join(directory, "absent.backup"),
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ _tag: "BackupVerificationFailed", reason: "unreadable" });
  });
});

describe("restoreStoreBackup", () => {
  it("restores the exact pre-backup journal and removes stale WAL sidecars", () => {
    const { directory, databasePath } = temporaryStore();
    const connection = openSqlite(databasePath);
    applyMigrations(connection, MIGRATIONS, () => now);
    seedEvent(connection, "1");
    const backupPath = backupPathFor(databasePath, "pre-migration");
    createStoreBackup({ connection, dataDirectory: directory, backupPath });

    // Diverge the live store after the backup, then close it before restore.
    seedEvent(connection, "2");
    expect(
      (connection.prepare("SELECT count(*) AS c FROM event_journal").get() as { c: number }).c,
    ).toBe(2);
    connection.close();

    const receipt = restoreStoreBackup({ dataDirectory: directory, databasePath, backupPath });
    expect(receipt.journalHead).toBe(1);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);

    const reopened = openSqlite(databasePath);
    expect(
      (reopened.prepare("SELECT count(*) AS c FROM event_journal").get() as { c: number }).c,
    ).toBe(1);
    expect(reopened.pragma("integrity_check", { simple: true })).toBe("ok");
    reopened.close();
  });

  it("refuses to restore from a backup outside the data directory", () => {
    const { directory, databasePath } = temporaryStore();
    const connection = openSqlite(databasePath);
    applyMigrations(connection, MIGRATIONS, () => now);
    connection.close();

    expect(() =>
      restoreStoreBackup({
        dataDirectory: directory,
        databasePath,
        backupPath: join(tmpdir(), "escape.sqlite3"),
      }),
    ).toThrow(PathOutsideDataDirectory);
  });

  it("leaves the live store untouched when the backup fails verification", () => {
    const { directory, databasePath } = temporaryStore();
    const connection = openSqlite(databasePath);
    applyMigrations(connection, MIGRATIONS, () => now);
    seedEvent(connection, "1");
    connection.close();
    const backupPath = join(directory, "octant.sqlite3.backup-corrupt");
    writeFileSync(backupPath, "corrupt");

    expect(() =>
      restoreStoreBackup({ dataDirectory: directory, databasePath, backupPath }),
    ).toThrow(BackupVerificationFailed);

    const reopened = openSqlite(databasePath);
    expect(
      (reopened.prepare("SELECT count(*) AS c FROM event_journal").get() as { c: number }).c,
    ).toBe(1);
    reopened.close();
  });
});
