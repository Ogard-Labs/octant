import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Offline SQLite store backup verification and atomic restore for the CLI
 * upgrade coordinator. Runs only while Octant is stopped and under exclusive
 * maintenance ownership.
 *
 * Mirrors the invariants of `apps/server/src/persistence/storeBackup.ts`
 * without importing `apps/server` (dependencies point inward):
 * - both `databasePath` and `backupPath` must be confined inside `dataDirectory`
 *   and must never be symbolic links;
 * - the backup is opened read-only via the runtime's built-in SQLite engine
 *   (`bun:sqlite` under Bun in packaged headless artifacts, `node:sqlite` under
 *   Node 24+) and must pass `PRAGMA integrity_check === "ok"` and carry a
 *   valid Octant schema (`event_journal` or an empty `schema_migrations` baseline);
 * - the verified backup is copied to a private temporary file beside the store,
 *   atomically renamed over `databasePath`, and stale `-wal`/`-shm` sidecars
 *   are removed.
 */

export type OfflineStoreRestoreFailureReason =
  | "path-confined"
  | "unreadable"
  | "integrity-check-failed"
  | "not-an-octant-store"
  | "swap-failed";

export class OfflineStoreRestoreError extends Error {
  override readonly name = "OfflineStoreRestoreError";
  readonly reason: OfflineStoreRestoreFailureReason;

  constructor(reason: OfflineStoreRestoreFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface OfflineStoreBackupReceipt {
  readonly migrationVersion: number;
  readonly journalHead: number;
  readonly byteLength: number;
}

export interface ReadOnlySqliteInspector {
  integrityCheck(): string | undefined;
  userTables(): ReadonlyArray<string>;
  maxMigrationVersion(): number;
  maxJournalHead(): number;
  appliedMigrationCount(): number;
  close(): void;
}

export type OpenOfflineBackupInspector = (path: string) => Promise<ReadOnlySqliteInspector>;

export interface RestoreOfflineStoreBackupInput {
  readonly dataDirectory: string;
  readonly backupPath: string;
  readonly databasePath?: string;
  /** Test seam; defaults to runtime-native `bun:sqlite` or `node:sqlite`. */
  readonly openInspector?: OpenOfflineBackupInspector;
}

function isPathWithinDirectory(directory: string, candidate: string): boolean {
  const resolvedDirectory = resolve(directory);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedDirectory) return true;
  const rel = relative(resolvedDirectory, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertNotSymlinkIfPresent(path: string, reason: OfflineStoreRestoreFailureReason): void {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new OfflineStoreRestoreError(
        reason,
        "Refused to read or replace a symbolic link or non-regular file.",
      );
    }
  } catch (error) {
    if (error instanceof OfflineStoreRestoreError) throw error;
    if ((error as { readonly code?: unknown }).code === "ENOENT") return;
    throw new OfflineStoreRestoreError(reason, "The store path could not be inspected.");
  }
}

function numberValue(row: unknown): number {
  if (typeof row === "object" && row !== null && "value" in row) {
    const value = (row as { readonly value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
  }
  return 0;
}

async function openRuntimeInspector(path: string): Promise<ReadOnlySqliteInspector> {
  if (process.versions.bun !== undefined) {
    const bunSqlite = await import("bun:sqlite");
    const db = new bunSqlite.Database(path, { readonly: true });
    return {
      integrityCheck: () => {
        const rows = db.query<Record<string, unknown>, []>("PRAGMA integrity_check").all();
        const first = rows[0];
        const value = first === undefined ? undefined : Object.values(first)[0];
        return typeof value === "string" ? value : undefined;
      },
      userTables: () =>
        db
          .query<{ readonly name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => row.name),
      maxMigrationVersion: () =>
        numberValue(
          db
            .query<unknown, []>("SELECT coalesce(max(version), 0) AS value FROM schema_migrations")
            .get(),
        ),
      maxJournalHead: () =>
        numberValue(
          db
            .query<unknown, []>(
              "SELECT coalesce(max(global_sequence), 0) AS value FROM event_journal",
            )
            .get(),
        ),
      appliedMigrationCount: () =>
        numberValue(db.query<unknown, []>("SELECT count(*) AS value FROM schema_migrations").get()),
      close: () => db.close(true),
    };
  }
  const nodeSqlite = await import("node:sqlite");
  const db = new nodeSqlite.DatabaseSync(path, { readOnly: true });
  return {
    integrityCheck: () => {
      const row = db.prepare("PRAGMA integrity_check").get();
      if (typeof row !== "object" || row === null) return undefined;
      const value = Object.values(row)[0];
      return typeof value === "string" ? value : undefined;
    },
    userTables: () =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .flatMap((row) =>
          typeof row === "object" && row !== null && typeof row.name === "string" ? [row.name] : [],
        ),
    maxMigrationVersion: () =>
      numberValue(
        db.prepare("SELECT coalesce(max(version), 0) AS value FROM schema_migrations").get(),
      ),
    maxJournalHead: () =>
      numberValue(
        db.prepare("SELECT coalesce(max(global_sequence), 0) AS value FROM event_journal").get(),
      ),
    appliedMigrationCount: () =>
      numberValue(db.prepare("SELECT count(*) AS value FROM schema_migrations").get()),
    close: () => db.close(),
  };
}

export async function verifyOfflineStoreBackup(input: {
  readonly dataDirectory: string;
  readonly backupPath: string;
  readonly openInspector?: OpenOfflineBackupInspector;
}): Promise<{ readonly migrationVersion: number; readonly journalHead: number }> {
  if (!isPathWithinDirectory(input.dataDirectory, input.backupPath)) {
    throw new OfflineStoreRestoreError(
      "path-confined",
      "The requested backup path is outside the Octant data directory.",
    );
  }
  if (!existsSync(input.backupPath)) {
    throw new OfflineStoreRestoreError("unreadable", "The store backup file is missing.");
  }
  assertNotSymlinkIfPresent(input.backupPath, "path-confined");

  const open = input.openInspector ?? openRuntimeInspector;
  let inspector: ReadOnlySqliteInspector | undefined;
  try {
    inspector = await open(input.backupPath);
    if (inspector.integrityCheck() !== "ok") {
      throw new OfflineStoreRestoreError(
        "integrity-check-failed",
        "The store backup failed SQLite integrity verification.",
      );
    }
    const tables = inspector.userTables();
    if (!tables.includes("event_journal")) {
      const onlyBaseline = tables.every((name) => name === "schema_migrations");
      const appliedCount = tables.includes("schema_migrations")
        ? inspector.appliedMigrationCount()
        : 0;
      if (onlyBaseline && appliedCount === 0) {
        return { migrationVersion: 0, journalHead: 0 };
      }
      throw new OfflineStoreRestoreError(
        "not-an-octant-store",
        "The backup file is not a valid Octant store.",
      );
    }
    return {
      migrationVersion: inspector.maxMigrationVersion(),
      journalHead: inspector.maxJournalHead(),
    };
  } catch (error) {
    if (error instanceof OfflineStoreRestoreError) throw error;
    throw new OfflineStoreRestoreError("unreadable", "The store backup could not be opened.");
  } finally {
    inspector?.close();
  }
}

export async function restoreOfflineStoreBackup(
  input: RestoreOfflineStoreBackupInput,
): Promise<OfflineStoreBackupReceipt> {
  const databasePath = input.databasePath ?? join(input.dataDirectory, "octant.sqlite3");
  if (
    !isPathWithinDirectory(input.dataDirectory, databasePath) ||
    !isPathWithinDirectory(input.dataDirectory, input.backupPath)
  ) {
    throw new OfflineStoreRestoreError(
      "path-confined",
      "The store or backup path is outside the Octant data directory.",
    );
  }
  const verification = await verifyOfflineStoreBackup({
    dataDirectory: input.dataDirectory,
    backupPath: input.backupPath,
    ...(input.openInspector === undefined ? {} : { openInspector: input.openInspector }),
  });

  assertNotSymlinkIfPresent(databasePath, "path-confined");
  const temporaryPath = `${databasePath}.restore-${process.pid}.tmp`;
  try {
    rmSync(temporaryPath, { force: true });
    copyFileSync(input.backupPath, temporaryPath);
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (error instanceof OfflineStoreRestoreError) throw error;
    throw new OfflineStoreRestoreError(
      "swap-failed",
      "Octant could not atomically replace the store from the verified backup.",
    );
  }

  let byteLength = 0;
  try {
    byteLength = statSync(databasePath).size;
  } catch {
    byteLength = 0;
  }
  return {
    migrationVersion: verification.migrationVersion,
    journalHead: verification.journalHead,
    byteLength,
  };
}
