import { copyFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import {
  BackupVerificationFailed,
  PathOutsideDataDirectory,
  StoreBackupFailed,
  StoreRestoreFailed,
} from "./dataLifecycleErrors";
import { isPathWithinDirectory } from "./storePath";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

// File-level backup and restore for the disposable SQLite store. A backup is a
// single self-contained SQLite file produced by `VACUUM INTO`, so it carries no
// WAL sidecars and can be verified and swapped in atomically. Every path is
// confined to the resolved data directory before any filesystem write.

export interface StoreBackupReceipt {
  readonly migrationVersion: number;
  readonly journalHead: number;
  readonly byteLength: number;
}

export interface OpenBackupConnection {
  (path: string): SqliteConnection;
}

interface BackupCommonInput {
  readonly dataDirectory: string;
  readonly openConnection?: OpenBackupConnection;
}

/**
 * Writes a verified, self-contained snapshot of the live store to `backupPath`.
 * The snapshot is produced with `VACUUM INTO` against the open connection, then
 * reopened and verified before the receipt is returned. A pre-existing file at
 * `backupPath` is removed first so the operation is repeatable.
 */
export function createStoreBackup(
  input: BackupCommonInput & {
    readonly connection: SqliteConnection;
    readonly backupPath: string;
  },
): StoreBackupReceipt {
  if (!isPathWithinDirectory(input.dataDirectory, input.backupPath)) {
    throw new PathOutsideDataDirectory({ purpose: "backup" });
  }

  removeQuietly(input.backupPath);
  try {
    input.connection.exec(`VACUUM main INTO '${escapeSqlPath(input.backupPath)}'`);
  } catch {
    removeQuietly(input.backupPath);
    throw new StoreBackupFailed({ operation: "create" });
  }

  const verification = verifyStoreBackup({
    dataDirectory: input.dataDirectory,
    backupPath: input.backupPath,
    ...(input.openConnection === undefined ? {} : { openConnection: input.openConnection }),
  });
  return {
    migrationVersion: verification.migrationVersion,
    journalHead: verification.journalHead,
    byteLength: byteLength(input.backupPath),
  };
}

/**
 * Opens the backup file and confirms it is a usable Octant store: it passes
 * SQLite `integrity_check`, exposes a readable migration history, and carries an
 * event journal. Returns the recovered version/head or throws a redacted
 * verification failure.
 */
export function verifyStoreBackup(input: BackupCommonInput & { readonly backupPath: string }): {
  readonly migrationVersion: number;
  readonly journalHead: number;
} {
  if (!isPathWithinDirectory(input.dataDirectory, input.backupPath)) {
    throw new PathOutsideDataDirectory({ purpose: "restore" });
  }
  if (!existsSync(input.backupPath)) {
    throw new BackupVerificationFailed({ reason: "unreadable" });
  }

  const open = input.openConnection ?? openSqlite;
  let connection: SqliteConnection | undefined;
  try {
    connection = open(input.backupPath);
    if (connection.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new BackupVerificationFailed({ reason: "integrity-check-failed" });
    }
    if (!hasTable(connection, "event_journal")) {
      // A first-launch baseline has no journal yet: either an empty database or
      // just the (empty) migration-history table created before the very first
      // migration. Any other shape (unrelated tables, applied migration rows
      // without a journal) is not a recoverable Octant snapshot.
      const onlyBaselineTables = userTables(connection).every(
        (name) => name === "schema_migrations",
      );
      const appliedMigrationCount = hasTable(connection, "schema_migrations")
        ? numberValue(connection.prepare("SELECT count(*) AS value FROM schema_migrations").get())
        : 0;
      if (onlyBaselineTables && appliedMigrationCount === 0) {
        return { migrationVersion: 0, journalHead: 0 };
      }
      throw new BackupVerificationFailed({ reason: "not-an-octant-store" });
    }
    return {
      migrationVersion: numberValue(
        connection
          .prepare("SELECT coalesce(max(version), 0) AS value FROM schema_migrations")
          .get(),
      ),
      journalHead: numberValue(
        connection
          .prepare("SELECT coalesce(max(global_sequence), 0) AS value FROM event_journal")
          .get(),
      ),
    };
  } catch (error) {
    if (error instanceof BackupVerificationFailed) throw error;
    throw new BackupVerificationFailed({ reason: "unreadable" });
  } finally {
    connection?.close();
  }
}

/**
 * Replaces the live store at `databasePath` with a verified backup. The caller
 * MUST have closed every connection to `databasePath` first. The backup is
 * verified before any destructive filesystem write, then swapped in through a
 * temporary file and atomic rename so an interrupted restore never leaves a
 * half-written store. Stale WAL/SHM sidecars of the replaced store are removed.
 */
export function restoreStoreBackup(
  input: BackupCommonInput & {
    readonly databasePath: string;
    readonly backupPath: string;
  },
): StoreBackupReceipt {
  if (
    !isPathWithinDirectory(input.dataDirectory, input.databasePath) ||
    !isPathWithinDirectory(input.dataDirectory, input.backupPath)
  ) {
    throw new PathOutsideDataDirectory({ purpose: "restore" });
  }

  let verification: { readonly migrationVersion: number; readonly journalHead: number };
  try {
    verification = verifyStoreBackup({
      dataDirectory: input.dataDirectory,
      backupPath: input.backupPath,
      ...(input.openConnection === undefined ? {} : { openConnection: input.openConnection }),
    });
  } catch (error) {
    if (error instanceof BackupVerificationFailed || error instanceof PathOutsideDataDirectory) {
      throw error;
    }
    throw new StoreRestoreFailed({ stage: "verify-backup" });
  }

  const temporaryPath = `${input.databasePath}.restore-${process.pid}.tmp`;
  try {
    removeQuietly(temporaryPath);
    copyFileSync(input.backupPath, temporaryPath);
    renameSync(temporaryPath, input.databasePath);
    removeQuietly(`${input.databasePath}-wal`);
    removeQuietly(`${input.databasePath}-shm`);
  } catch {
    removeQuietly(temporaryPath);
    throw new StoreRestoreFailed({ stage: "swap-store" });
  }

  return {
    migrationVersion: verification.migrationVersion,
    journalHead: verification.journalHead,
    byteLength: byteLength(input.databasePath),
  };
}

export function backupPathFor(databasePath: string, label: string): string {
  return `${databasePath}.backup-${label}`;
}

function hasTable(connection: SqliteConnection, name: string): boolean {
  return (
    connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function userTables(connection: SqliteConnection): ReadonlyArray<string> {
  return (
    connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as ReadonlyArray<{ readonly name: string }>
  ).map((row) => row.name);
}

function numberValue(row: unknown): number {
  return (row as { readonly value: number }).value;
}

function byteLength(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort; a missing file is the desired post-state
  }
}

function escapeSqlPath(path: string): string {
  return path.replace(/'/g, "''");
}
