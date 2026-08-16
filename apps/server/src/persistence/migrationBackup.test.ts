import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupVerificationFailed,
  MigrationDowngradeRefused,
  MigrationInterruptedRestored,
} from "./dataLifecycleErrors";
import { MigrationChecksumMismatch } from "./migrationErrors";
import { migrateStoreWithBackup } from "./migrationBackup";
import { applyMigrations, MIGRATIONS, type Migration } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { backupPathFor, createStoreBackup } from "./storeBackup";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";

function temporaryStore(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "octant-migration-backup-"));
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

function backupArtifacts(directory: string): ReadonlyArray<string> {
  return readdirSync(directory).filter((name) => name.includes(".backup-"));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrateStoreWithBackup", () => {
  it("migrates a fresh store to the latest version and retires the backup", () => {
    const { directory, databasePath } = temporaryStore();

    const result = migrateStoreWithBackup({
      databasePath,
      dataDirectory: directory,
      migrations: MIGRATIONS,
      clock: () => now,
    });

    expect(result.outcome).toBe("upgraded");
    expect(result.backupProtected).toBe(true);
    expect(result.status.currentVersion).toBe(MIGRATIONS.at(-1)!.version);
    expect(backupArtifacts(directory)).toEqual([]);
    result.connection.close();
  });

  it("performs no backup and no write for an already-current store", () => {
    const { directory, databasePath } = temporaryStore();
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS, () => now);
    seedEvent(seeded, "1");
    seeded.close();

    const result = migrateStoreWithBackup({
      databasePath,
      dataDirectory: directory,
      migrations: MIGRATIONS,
      clock: () => "2099-01-01T00:00:00.000Z",
    });

    expect(result.outcome).toBe("up-to-date");
    expect(result.backupProtected).toBe(false);
    expect(result.status.appliedVersions).toEqual([]);
    expect(backupArtifacts(directory)).toEqual([]);
    result.connection.close();
  });

  it("refuses a downgrade without opening the store to writes", () => {
    const { directory, databasePath } = temporaryStore();
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS, () => now);
    seedEvent(seeded, "1");
    seeded.close();

    // A binary that only knows an earlier migration set must refuse.
    expect(() =>
      migrateStoreWithBackup({
        databasePath,
        dataDirectory: directory,
        migrations: MIGRATIONS.slice(0, 20),
        clock: () => now,
      }),
    ).toThrow(MigrationDowngradeRefused);

    const inspected = openSqlite(databasePath);
    expect(
      (
        inspected.prepare("SELECT coalesce(max(version),0) AS v FROM schema_migrations").get() as {
          v: number;
        }
      ).v,
    ).toBe(MIGRATIONS.at(-1)!.version);
    inspected.close();
  });

  it("refuses a checksum-incompatible store without restoring or modifying it", () => {
    const { directory, databasePath } = temporaryStore();
    const seeded = openSqlite(databasePath);
    seeded.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE event_journal (global_sequence INTEGER PRIMARY KEY) STRICT;
      INSERT INTO schema_migrations VALUES (1, 'create_event_store', 'wrong-checksum', '${now}');
    `);
    seeded.close();

    expect(() =>
      migrateStoreWithBackup({
        databasePath,
        dataDirectory: directory,
        migrations: MIGRATIONS,
        clock: () => now,
      }),
    ).toThrow(MigrationChecksumMismatch);
    expect(backupArtifacts(directory)).toEqual([]);
  });

  it("restores the verified pre-migration store when a multi-step upgrade is interrupted", () => {
    const { directory, databasePath } = temporaryStore();
    // Establish a real, non-empty store at version 2.
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS.slice(0, 2), () => now);
    seedEvent(seeded, "1");
    seeded.close();

    // A migration set whose later step fails mid-sequence.
    const failing: ReadonlyArray<Migration> = [
      ...MIGRATIONS.slice(0, 2),
      { version: 3, name: "healthy_step", sql: "CREATE TABLE step_three (id INTEGER) STRICT;" },
      {
        version: 4,
        name: "broken_step",
        sql: "CREATE TABLE step_four (id INTEGER) STRICT; INSERT INTO missing_table VALUES (1);",
      },
    ];

    let observed: unknown;
    try {
      migrateStoreWithBackup({
        databasePath,
        dataDirectory: directory,
        migrations: failing,
        clock: () => now,
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(MigrationInterruptedRestored);
    expect(observed).toMatchObject({ fromVersion: 2, attemptedVersion: 4, restored: true });

    // The store is back at the exact pre-migration version with no partial
    // schema (neither the healthy nor the broken step survives).
    const inspected = openSqlite(databasePath);
    expect(
      (
        inspected.prepare("SELECT coalesce(max(version),0) AS v FROM schema_migrations").get() as {
          v: number;
        }
      ).v,
    ).toBe(2);
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('step_three','step_four')",
        )
        .all(),
    ).toEqual([]);
    expect(
      (inspected.prepare("SELECT count(*) AS c FROM event_journal").get() as { c: number }).c,
    ).toBe(1);
    expect(inspected.pragma("integrity_check", { simple: true })).toBe("ok");
    inspected.close();
    expect(backupArtifacts(directory)).toEqual([]);
  });

  it("recovers a leftover pre-migration snapshot before overwriting it, then upgrades", () => {
    const { directory, databasePath } = temporaryStore();
    // A good pre-migration store at version 2 with one event.
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS.slice(0, 2), () => now);
    seedEvent(seeded, "1");
    // Capture the verified pre-migration snapshot beside the store, exactly as an
    // interrupted prior upgrade would have left behind.
    createStoreBackup({
      connection: seeded,
      dataDirectory: directory,
      backupPath: backupPathFor(databasePath, "pre-migration"),
    });
    // Simulate the partial/damaged live store the interrupted upgrade left: the
    // seeded event is gone. If the new run backed up before recovering, this
    // damaged state would overwrite the only good copy.
    seeded.exec("DELETE FROM event_journal");
    seeded.close();

    const result = migrateStoreWithBackup({
      databasePath,
      dataDirectory: directory,
      migrations: MIGRATIONS,
      clock: () => now,
    });

    expect(result.outcome).toBe("upgraded");
    expect(result.status.currentVersion).toBe(MIGRATIONS.at(-1)!.version);
    // The event recovered from the snapshot survived, proving recovery ran before
    // any fresh backup could overwrite the good copy.
    expect(
      (result.connection.prepare("SELECT count(*) AS c FROM event_journal").get() as { c: number })
        .c,
    ).toBe(1);
    expect(backupArtifacts(directory)).toEqual([]);
    result.connection.close();
  });

  it("leaves an unusable leftover snapshot in place instead of destroying or overwriting it", () => {
    const { directory, databasePath } = temporaryStore();
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS.slice(0, 2), () => now);
    seedEvent(seeded, "1");
    seeded.close();
    // A corrupt leftover snapshot that cannot be verified.
    const backupPath = backupPathFor(databasePath, "pre-migration");
    writeFileSync(backupPath, "not a sqlite database");

    expect(() =>
      migrateStoreWithBackup({
        databasePath,
        dataDirectory: directory,
        migrations: MIGRATIONS,
        clock: () => now,
      }),
    ).toThrow(BackupVerificationFailed);

    // The unusable snapshot is retained for a later manual recovery attempt and
    // the store is left untouched at its pre-migration version.
    expect(existsSync(backupPath)).toBe(true);
    const inspected = openSqlite(databasePath);
    expect(
      (
        inspected.prepare("SELECT coalesce(max(version),0) AS v FROM schema_migrations").get() as {
          v: number;
        }
      ).v,
    ).toBe(2);
    inspected.close();
  });

  it("does not leak the data directory path in a refusal diagnostic", () => {
    const { directory, databasePath } = temporaryStore();
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS, () => now);
    seeded.close();

    let observed: unknown;
    try {
      migrateStoreWithBackup({
        databasePath,
        dataDirectory: directory,
        migrations: MIGRATIONS.slice(0, 10),
        clock: () => now,
      });
    } catch (error) {
      observed = error;
    }
    expect(String(observed)).not.toContain(directory);
  });
});
