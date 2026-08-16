import { planMigrationBackup } from "@octant/domain";
import { existsSync, rmSync } from "node:fs";
import { MigrationDowngradeRefused, MigrationInterruptedRestored } from "./dataLifecycleErrors";
import {
  DatabaseVersionTooNew,
  MigrationChecksumMismatch,
  MigrationHistoryMismatch,
} from "./migrationErrors";
import {
  applyMigrations,
  assertMigrationsApplicable,
  type Migration,
  type MigrationStatus,
} from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { backupPathFor, createStoreBackup, restoreStoreBackup } from "./storeBackup";

// Atomic pre-migration backup and restore boundary for multi-step schema
// upgrades. A forward upgrade is protected by a verified backup taken before any
// migration runs; an interrupted (partial) upgrade is rolled back to the exact
// pre-migration store using that backup, never left partially migrated. A
// downgrade is refused without touching the source store.

export interface MigrateStoreWithBackupInput {
  readonly databasePath: string;
  readonly dataDirectory: string;
  readonly migrations: ReadonlyArray<Migration>;
  readonly clock: () => string;
  readonly openConnection?: (path: string) => SqliteConnection;
}

export interface MigrateStoreWithBackupResult {
  readonly connection: SqliteConnection;
  readonly status: MigrationStatus;
  readonly outcome: "up-to-date" | "upgraded";
  readonly backupProtected: boolean;
}

const PRE_MIGRATION_LABEL = "pre-migration";

export function migrateStoreWithBackup(
  input: MigrateStoreWithBackupInput,
): MigrateStoreWithBackupResult {
  const open = input.openConnection ?? openSqlite;
  const backupPath = backupPathFor(input.databasePath, PRE_MIGRATION_LABEL);

  // A pre-migration snapshot left beside the store means a previous upgrade was
  // interrupted before it could finish and retire its backup, so the live store
  // may be a partial migration. Recover the verified pre-migration state from
  // that snapshot before touching anything else: re-running the upgrade from the
  // exact pre-migration store is safe, whereas creating a fresh backup first
  // would overwrite the only good copy with the partial store. An unusable
  // snapshot is left in place (restoreStoreBackup verifies before any write) so
  // it can still be inspected manually. This runs before the connection is
  // opened because restoreStoreBackup requires the store to have no open
  // connections.
  recoverInterruptedMigration(input, backupPath);

  const connection = open(input.databasePath);

  const databaseVersion = readDatabaseVersion(connection);
  const plan = planMigrationBackup({
    databaseVersion,
    knownVersions: input.migrations.map((migration) => migration.version),
  });

  if (plan.kind === "downgrade-refused") {
    connection.close();
    throw new MigrationDowngradeRefused({
      databaseVersion: plan.databaseVersion,
      latestKnownVersion: plan.latestKnownVersion,
    });
  }

  // Refuse an incompatible history (changed checksum, unknown applied
  // migration) before taking any backup so a store that cannot be migrated is
  // left untouched rather than needlessly snapshotted.
  try {
    assertMigrationsApplicable(connection, input.migrations);
  } catch (error) {
    connection.close();
    throw error;
  }

  if (plan.kind === "up-to-date") {
    const status = applyMigrations(connection, input.migrations, input.clock);
    return { connection, status, outcome: "up-to-date", backupProtected: false };
  }

  try {
    // Backup files are always real on-disk SQLite databases, so their
    // verification uses the default opener rather than the injected primary
    // store opener (which callers use only to track the live connection).
    createStoreBackup({
      connection,
      dataDirectory: input.dataDirectory,
      backupPath,
    });
  } catch (error) {
    connection.close();
    removeQuietly(backupPath);
    throw error;
  }

  let status: MigrationStatus;
  try {
    status = applyMigrations(connection, input.migrations, input.clock);
  } catch (error) {
    connection.close();
    if (refusesWithoutModifying(error)) {
      // applyMigrations validates existing history before applying anything, so
      // an incompatible store is refused with the source left untouched.
      removeQuietly(backupPath);
      throw error;
    }
    // A migration failed mid-sequence: roll the store back to its verified
    // pre-migration snapshot so no partial schema survives.
    const restored = tryRestore(input, backupPath);
    // Only retire the snapshot once the store has been restored from it. If the
    // rollback itself failed, the verified pre-migration backup is the only copy
    // of the good store, so it is kept on disk for a later recovery attempt; the
    // next start will detect it and recover before migrating again.
    if (restored) removeQuietly(backupPath);
    throw new MigrationInterruptedRestored({
      fromVersion: plan.fromVersion,
      attemptedVersion: plan.toVersion,
      restored,
    });
  }

  removeQuietly(backupPath);
  return { connection, status, outcome: "upgraded", backupProtected: true };
}

function recoverInterruptedMigration(input: MigrateStoreWithBackupInput, backupPath: string): void {
  if (!existsSync(backupPath)) return;
  // restoreStoreBackup verifies the snapshot before any destructive write and
  // swaps it in atomically, then removes the store's stale WAL/SHM sidecars. On
  // success the live store is exactly the pre-migration state and the snapshot
  // has served its purpose, so it is retired before the upgrade re-runs. A
  // verification/restore failure is propagated with the snapshot left untouched.
  // The snapshot is a real on-disk SQLite file, so it is verified with the
  // default opener rather than the injected live-connection opener.
  restoreStoreBackup({
    dataDirectory: input.dataDirectory,
    databasePath: input.databasePath,
    backupPath,
  });
  removeQuietly(backupPath);
}

function tryRestore(input: MigrateStoreWithBackupInput, backupPath: string): boolean {
  try {
    restoreStoreBackup({
      dataDirectory: input.dataDirectory,
      databasePath: input.databasePath,
      backupPath,
    });
    return true;
  } catch {
    return false;
  }
}

function refusesWithoutModifying(error: unknown): boolean {
  return (
    error instanceof MigrationChecksumMismatch ||
    error instanceof MigrationHistoryMismatch ||
    error instanceof DatabaseVersionTooNew
  );
}

function readDatabaseVersion(connection: SqliteConnection): number {
  const hasHistory =
    connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined;
  if (!hasHistory) return 0;
  return (
    connection
      .prepare("SELECT coalesce(max(version), 0) AS value FROM schema_migrations")
      .get() as { readonly value: number }
  ).value;
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort; a leftover backup is retired on the next successful start
  }
}
