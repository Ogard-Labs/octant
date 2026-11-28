import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  OfflineStoreRestoreError,
  restoreOfflineStoreBackup,
  verifyOfflineStoreBackup,
} from "./offlineStoreRestore";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createStoreFixture(
  path: string,
  options: { readonly migrationVersion: number; readonly journalHead: number },
): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE event_journal (global_sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
      options.migrationVersion,
      `migration-${options.migrationVersion}`,
    );
    db.prepare("INSERT INTO event_journal (global_sequence, payload) VALUES (?, ?)").run(
      options.journalHead,
      `event-${options.journalHead}`,
    );
  } finally {
    db.close();
  }
}

describe("offlineStoreRestore", () => {
  it("verifies a pre-upgrade backup and atomically replaces the migrated store and stale sidecars", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-cli-restore-"));
    roots.push(dataDirectory);
    const databasePath = join(dataDirectory, "octant.sqlite3");
    const backupPath = join(dataDirectory, "octant.sqlite3.backup-pre-upgrade");

    createStoreFixture(backupPath, { migrationVersion: 3, journalHead: 12 });
    createStoreFixture(databasePath, { migrationVersion: 4, journalHead: 15 });
    writeFileSync(`${databasePath}-wal`, "stale-wal");
    writeFileSync(`${databasePath}-shm`, "stale-shm");

    const receipt = await restoreOfflineStoreBackup({ dataDirectory, databasePath, backupPath });
    expect(receipt.migrationVersion).toBe(3);
    expect(receipt.journalHead).toBe(12);
    expect(receipt.byteLength).toBeGreaterThan(0);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);

    const verified = await verifyOfflineStoreBackup({ dataDirectory, backupPath: databasePath });
    expect(verified).toEqual({ migrationVersion: 3, journalHead: 12 });
  });

  it("refuses a corrupt backup without modifying the live store", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-cli-restore-"));
    roots.push(dataDirectory);
    const databasePath = join(dataDirectory, "octant.sqlite3");
    const backupPath = join(dataDirectory, "octant.sqlite3.backup-corrupt");

    createStoreFixture(databasePath, { migrationVersion: 4, journalHead: 15 });
    const beforeBytes = readFileSync(databasePath);
    writeFileSync(backupPath, "not a sqlite database");

    await expect(
      restoreOfflineStoreBackup({ dataDirectory, databasePath, backupPath }),
    ).rejects.toBeInstanceOf(OfflineStoreRestoreError);
    expect(readFileSync(databasePath)).toEqual(beforeBytes);
  });

  it("refuses a backup outside the data directory or behind a symbolic link", async () => {
    const outer = mkdtempSync(join(tmpdir(), "octant-cli-restore-outer-"));
    roots.push(outer);
    const dataDirectory = join(outer, "data");
    mkdirSync(dataDirectory, { recursive: true });
    const outsideBackup = join(outer, "outside.sqlite3");
    createStoreFixture(outsideBackup, { migrationVersion: 1, journalHead: 1 });

    await expect(
      restoreOfflineStoreBackup({ dataDirectory, backupPath: outsideBackup }),
    ).rejects.toMatchObject({ reason: "path-confined" });

    const linkedBackup = join(dataDirectory, "linked.sqlite3");
    symlinkSync(outsideBackup, linkedBackup);
    await expect(
      restoreOfflineStoreBackup({ dataDirectory, backupPath: linkedBackup }),
    ).rejects.toMatchObject({ reason: "path-confined" });
  });
});
