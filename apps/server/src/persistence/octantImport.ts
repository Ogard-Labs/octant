import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  OCTANT_IMPORT_AGGREGATE_TYPE,
  OCTANT_IMPORT_RECORDED,
  type OctantImportConflict,
  type OctantImportCopy,
  type OctantImportOutcomeCounts,
} from "@octant/contracts";
import { classifySqliteFailure } from "./journalErrors";
import { Journal } from "./journal";
import { DatabaseVersionTooNew } from "./migrationErrors";
import { migrateStoreWithBackup } from "./migrationBackup";
import { applyMigrations, MIGRATIONS } from "./migrations";
import {
  copyOctantSideFiles,
  discardCopyReceipt,
  removeCopiedFiles,
  settleInterruptedCopies,
} from "./octantImportFiles";
import {
  mergeOctantSnapshot,
  type OctantImportKept,
  type OctantImportMergeResult,
} from "./octantImportMerge";
import { settleOctantInFlightWork } from "./octantImportSettle";
import { isExcludedOctantEvent } from "./octantImportTables";
import { rebuildAll, verifyDatabase } from "./recovery";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openReadOnlySqlite, openSqlite, type SqliteConnection } from "./sqlitePort";
import { backupPathFor, createStoreBackup, restoreStoreBackup } from "./storeBackup";
import { isPathWithinDirectory } from "./storePath";

export type OctantImportRefusal =
  | "octant-missing"
  | "octant-newer"
  | "busy"
  | "unsafe-folder"
  | "unreadable-event";

export type OctantImportStage =
  | "snapshot"
  | "migrate-snapshot"
  | "settle"
  | "open-nightly"
  | "backup"
  | "merge"
  | "rebuild"
  | "verify"
  | "files"
  | "swap";

export type OctantImportOutcome =
  | {
      readonly kind: "imported";
      readonly counts: OctantImportOutcomeCounts;
      /**
       * Threads both apps changed since the last import that arrived without
       * a copy (Code threads); Nightly's stayed as they were.
       */
      readonly conflicts: ReadonlyArray<OctantImportConflict>;
      /** Threads both apps changed that arrived as a second thread beside Nightly's. */
      readonly copies: ReadonlyArray<OctantImportCopy>;
      /** Settings, Projects and other records both changed; Nightly's value stayed. */
      readonly kept: ReadonlyArray<OctantImportKept>;
    }
  | { readonly kind: "refused"; readonly reason: OctantImportRefusal }
  | { readonly kind: "failed"; readonly stage: OctantImportStage };

const STORE_FILE = "octant.sqlite3";
const RECORDED_IMPORT_SQL = `SELECT 1 FROM event_journal
  WHERE aggregate_type = ? AND event_name = ? AND json_extract(payload_json, '$.importId') = ?
  LIMIT 1`;
const BACKUP_LABEL = "before-octant-import";
const SNAPSHOT_ATTEMPTS = 3;

class ImportStopped extends Error {
  constructor(readonly outcome: Exclude<OctantImportOutcome, { readonly kind: "imported" }>) {
    super("The import from Octant stopped.");
  }
}

const refuse = (reason: OctantImportRefusal) => new ImportStopped({ kind: "refused", reason });
const fail = (stage: OctantImportStage) => new ImportStopped({ kind: "failed", stage });

/**
 * Imports Octant's data into Nightly's own store, or merges what changed in
 * Octant since the last import (docs/design/nightly-app.md#importing-from-octant).
 *
 * The caller holds Nightly's owner lock with no connection open to Nightly's
 * store. Octant's store is only read: through a read-only connection while
 * its host may be writing, into a self-contained copy in Nightly's folder.
 * The merged store is built in another copy, rebuilt and verified, and swapped
 * in only at the end, after a backup of Nightly's store; every failure before
 * the swap leaves Nightly's store as it was.
 */
export function importFromOctant(input: {
  readonly octantDataDirectory: string;
  readonly nightlyDataDirectory: string;
  readonly clock: () => string;
  readonly uuid?: () => string;
}): OctantImportOutcome {
  const uuid = input.uuid ?? randomUUID;
  const importId = uuid();
  const importDirectory = join(input.nightlyDataDirectory, "import", importId);
  try {
    const octantStore = admittedOctantStore(input.octantDataDirectory, input.nightlyDataDirectory);
    mkdirSync(importDirectory, { recursive: true, mode: 0o700 });
    const snapshotPath = join(importDirectory, STORE_FILE);
    const runtime = createPhase1RuntimeRegistries();

    snapshotOctantStore(octantStore, snapshotPath);
    const prepared = prepareSnapshot({
      snapshotPath,
      importId,
      registry: runtime.events,
      clock: input.clock,
      uuid,
    });

    const databasePath = join(input.nightlyDataDirectory, STORE_FILE);
    const mergePath = join(importDirectory, "merged.sqlite3");
    let nightly: SqliteConnection;
    try {
      nightly = migrateStoreWithBackup({
        databasePath,
        dataDirectory: input.nightlyDataDirectory,
        migrations: MIGRATIONS,
        clock: input.clock,
      }).connection;
    } catch {
      throw fail("open-nightly");
    }
    try {
      // Files an earlier import copied and never committed are taken back
      // first; they would otherwise look like Nightly's own.
      try {
        const recorded = nightly.prepare(RECORDED_IMPORT_SQL);
        settleInterruptedCopies({
          dataDirectory: input.nightlyDataDirectory,
          isCommitted: (earlier) =>
            recorded.get(OCTANT_IMPORT_AGGREGATE_TYPE, OCTANT_IMPORT_RECORDED, earlier) !==
            undefined,
        });
      } catch {
        // The leftovers stay for the next import; this one need not fail for them.
      }
      createStoreBackup({
        connection: nightly,
        dataDirectory: input.nightlyDataDirectory,
        backupPath: backupPathFor(databasePath, BACKUP_LABEL),
      });
      createStoreBackup({
        connection: nightly,
        dataDirectory: input.nightlyDataDirectory,
        backupPath: mergePath,
      });
    } catch {
      throw fail("backup");
    } finally {
      nightly.close();
    }

    const finalPath = join(importDirectory, "final.sqlite3");
    const build = (path: string, makeCopies: boolean) =>
      buildMergedStore({
        mergePath: path,
        snapshotPath,
        finalPath,
        dataDirectory: input.nightlyDataDirectory,
        octantHead: prepared.octantHead,
        settled: prepared.settled,
        importId,
        clock: input.clock,
        uuid,
        makeCopies,
      });
    let result: OctantImportMergeResult;
    try {
      result = build(mergePath, true);
    } catch (error) {
      // A copy of a conflicting thread the rebuild cannot take must not cost
      // the person the rest of the import: build again from Nightly's backup
      // with the conflicts held back, as they were before copies existed.
      if (!(error instanceof ImportStopped) || !isRebuildFailure(error.outcome)) throw error;
      const retryPath = join(importDirectory, "merged-without-copies.sqlite3");
      try {
        copyFileSync(backupPathFor(databasePath, BACKUP_LABEL), retryPath);
      } catch {
        throw error;
      }
      result = build(retryPath, false);
    }

    // The files go before the swap so a failure at any step can take them
    // back; the store is the only thing that makes the import count.
    let files: number;
    try {
      files = copyOctantSideFiles({
        octantDirectory: input.octantDataDirectory,
        nightlyDirectory: input.nightlyDataDirectory,
        importId,
        threads: result.threads,
        aggregates: result.aggregates,
        imageArtifacts: result.imageArtifacts,
        copies: result.copyFiles,
      });
    } catch {
      removeCopiedFiles(input.nightlyDataDirectory, importId);
      throw fail("files");
    }

    try {
      // Nightly's sidecars go before the rename, not after: once the merged
      // store is in place, a failure to remove them must not report the
      // import as failed, and ignoring it is no option either, because SQLite
      // would replay the old store's write-ahead log onto the merged one.
      // Every connection to the store is closed by now and closing
      // checkpointed the log into the store file, so the old store loses
      // nothing if the rename then fails.
      for (const suffix of ["-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
      restoreStoreBackup({
        dataDirectory: input.nightlyDataDirectory,
        databasePath,
        backupPath: finalPath,
      });
    } catch {
      removeCopiedFiles(input.nightlyDataDirectory, importId);
      throw fail("swap");
    }
    discardCopyReceipt(input.nightlyDataDirectory, importId);
    return {
      kind: "imported",
      counts: { ...result.counts, files },
      conflicts: result.conflicts,
      copies: result.copies,
      kept: result.kept,
    };
  } catch (error) {
    if (error instanceof ImportStopped) return error.outcome;
    throw error;
  } finally {
    rmSync(importDirectory, { recursive: true, force: true });
  }
}

/**
 * Octant's data folder must be a real folder apart from Nightly's: neither
 * may be, contain, or lie inside the other, and neither it nor its store may
 * be a link, so the copy reads exactly the store Octant's host writes.
 */
function admittedOctantStore(octantDirectory: string, nightlyDirectory: string): string {
  let folder;
  try {
    folder = lstatSync(octantDirectory);
  } catch {
    throw refuse("octant-missing");
  }
  if (!folder.isDirectory()) throw refuse("unsafe-folder");
  let octantReal: string;
  let nightlyReal: string;
  try {
    octantReal = realpathSync(octantDirectory);
    nightlyReal = realpathSync(nightlyDirectory);
  } catch {
    throw refuse("unsafe-folder");
  }
  if (
    isPathWithinDirectory(octantReal, nightlyReal) ||
    isPathWithinDirectory(nightlyReal, octantReal)
  ) {
    throw refuse("unsafe-folder");
  }
  const store = join(octantReal, STORE_FILE);
  let file;
  try {
    file = lstatSync(store);
  } catch {
    throw refuse("octant-missing");
  }
  if (!file.isFile()) throw refuse("unsafe-folder");
  return store;
}

/**
 * Writes a self-contained copy of Octant's store without changing any file
 * of Octant's but SQLite's shared-memory index. A store with a write-ahead
 * log is read through a read-only connection, which a running writer never
 * waits on. A store without one has no writer: a read-only connection could
 * not open it without creating that log (or, under Bun, at all), so its main
 * file, complete on its own, is copied instead, and copied again through a
 * read-only connection if a writer started meanwhile.
 */
function snapshotOctantStore(source: string, target: string): void {
  const log = `${source}-wal`;
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    removeStore(target);
    if (existsSync(log)) {
      let reader;
      try {
        reader = openReadOnlySqlite(source);
        reader.exec(`VACUUM main INTO '${escapeSqlPath(target)}'`);
        return;
      } catch (error) {
        if (classifySqliteFailure(error) === "write-race" || !existsSync(log)) continue;
        throw fail("snapshot");
      } finally {
        reader?.close();
      }
    }
    const raw = `${target}.raw`;
    try {
      const before = statSync(source);
      copyFileSync(source, raw);
      const after = statSync(source);
      if (existsSync(log) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        continue;
      }
      const copy = openSqlite(raw);
      try {
        copy.exec(`VACUUM main INTO '${escapeSqlPath(target)}'`);
      } finally {
        copy.close();
      }
      return;
    } catch {
      throw fail("snapshot");
    } finally {
      removeStore(raw);
    }
  }
  throw refuse("busy");
}

/**
 * Checks the copy, brings it to Nightly's schema, decodes every row the
 * import may bring with Nightly's registry, and settles Octant's in-flight
 * work in it. Returns Octant's own journal head, before any settling event.
 */
function prepareSnapshot(input: {
  readonly snapshotPath: string;
  readonly importId: string;
  readonly registry: ReturnType<typeof createPhase1RuntimeRegistries>["events"];
  readonly clock: () => string;
  readonly uuid: () => string;
}): { readonly octantHead: number; readonly settled: number } {
  let snapshot: SqliteConnection;
  try {
    snapshot = openSqlite(input.snapshotPath);
  } catch {
    throw fail("snapshot");
  }
  try {
    if (snapshot.pragma("integrity_check", { simple: true }) !== "ok") throw fail("snapshot");
    try {
      applyMigrations(snapshot, MIGRATIONS, input.clock);
    } catch (error) {
      if (error instanceof DatabaseVersionTooNew) throw refuse("octant-newer");
      throw fail("migrate-snapshot");
    }
    if (!everyKeptEventDecodes(snapshot, input.registry)) throw refuse("unreadable-event");
    const octantHead = (
      snapshot
        .prepare("SELECT coalesce(max(global_sequence), 0) AS head FROM event_journal")
        .get() as { readonly head: number }
    ).head;
    let settled: number;
    try {
      settled = settleOctantInFlightWork({
        connection: snapshot,
        registry: input.registry,
        importId: input.importId,
        clock: input.clock,
        uuid: input.uuid,
      });
    } catch {
      throw fail("settle");
    }
    return { octantHead, settled };
  } finally {
    snapshot.close();
  }
}

/**
 * Every event the import may bring decodes with Nightly's registry and was
 * written by Octant's local host. Excluded families are never read: they stay
 * behind whatever they hold.
 */
function everyKeptEventDecodes(
  connection: SqliteConnection,
  registry: ReturnType<typeof createPhase1RuntimeRegistries>["events"],
): boolean {
  const page = connection.prepare(`
    SELECT global_sequence, aggregate_type, event_name, event_version, host_id, payload_json
    FROM event_journal WHERE global_sequence > ? ORDER BY global_sequence LIMIT 500
  `);
  let after = 0;
  for (;;) {
    const rows = page.all(after) as ReadonlyArray<{
      readonly global_sequence: number;
      readonly aggregate_type: string;
      readonly event_name: string;
      readonly event_version: number;
      readonly host_id: string;
      readonly payload_json: string;
    }>;
    if (rows.length === 0) return true;
    for (const row of rows) {
      after = row.global_sequence;
      if (isExcludedOctantEvent(row.aggregate_type, row.event_name)) continue;
      if (row.host_id !== "local") return false;
      try {
        registry.decodePersisted(row.event_name, row.event_version, JSON.parse(row.payload_json));
      } catch {
        return false;
      }
    }
  }
}

function buildMergedStore(input: {
  readonly mergePath: string;
  readonly snapshotPath: string;
  readonly finalPath: string;
  readonly dataDirectory: string;
  readonly octantHead: number;
  readonly settled: number;
  readonly importId: string;
  readonly clock: () => string;
  readonly uuid: () => string;
  readonly makeCopies: boolean;
}): OctantImportMergeResult {
  const merged = openSqlite(input.mergePath);
  try {
    const runtime = createPhase1RuntimeRegistries();
    let result;
    try {
      merged.exec(`ATTACH DATABASE '${escapeSqlPath(input.snapshotPath)}' AS octant`);
      // Replacing a setting's stream deletes rows that aggregate heads and
      // quarantine rows still name; the rebuild below rewrites both, and the
      // foreign-key check after it proves nothing dangles.
      merged.exec("PRAGMA foreign_keys = OFF");
      result = merged.transaction(() =>
        mergeOctantSnapshot({
          connection: merged,
          registry: runtime.events,
          octantHead: input.octantHead,
          settled: input.settled,
          importId: input.importId,
          clock: input.clock,
          uuid: input.uuid,
          makeCopies: input.makeCopies,
        }),
      )();
      merged.exec("PRAGMA foreign_keys = ON");
      merged.exec("DETACH DATABASE octant");
    } catch {
      throw fail("merge");
    }

    const journal = new Journal({
      connection: merged,
      registry: runtime.events,
      projections: runtime.projections,
      clock: input.clock,
    });
    const recovery = {
      connection: merged,
      journal,
      projections: runtime.projections,
      clock: input.clock,
    };
    try {
      if (rebuildAll(recovery).held !== undefined) throw fail("rebuild");
    } catch {
      throw fail("rebuild");
    }
    try {
      const verification = verifyDatabase(recovery);
      if (!verification.valid || merged.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw fail("verify");
      }
      // A self-contained file for the swap: the merged store's own
      // write-ahead log never travels with it.
      createStoreBackup({
        connection: merged,
        dataDirectory: input.dataDirectory,
        backupPath: input.finalPath,
      });
    } catch {
      throw fail("verify");
    }
    return result;
  } finally {
    merged.close();
  }
}

function isRebuildFailure(outcome: OctantImportOutcome): boolean {
  return outcome.kind === "failed" && (outcome.stage === "rebuild" || outcome.stage === "verify");
}

function removeStore(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function escapeSqlPath(path: string): string {
  return path.replace(/'/g, "''");
}
