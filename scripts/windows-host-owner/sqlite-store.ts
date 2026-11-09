import { Database } from "bun:sqlite";
import { migrateStoreWithBackup } from "../../apps/server/src/persistence/migrationBackup";
import { MIGRATIONS } from "../../apps/server/src/persistence/migrations";
import {
  createStoreBackup,
  restoreStoreBackup,
} from "../../apps/server/src/persistence/storeBackup";
import { MigrationInterruptedRestored } from "../../apps/server/src/persistence/dataLifecycleErrors";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, linkSync, unlinkSync } from "node:fs";
import { win32 } from "node:path";
import {
  acquireWindowsHostProfileOwner,
  loadWindowsHostProfileNative,
} from "../../packages/host-runtime/src/windowsHostProfile";
import {
  createWindowsSqliteStores,
  type WindowsSqliteStoreAdmission,
} from "../../packages/host-runtime/src/windowsSqliteStore";
import {
  openAdmittedSqlite,
  openReadOnlySqlite,
} from "../../apps/server/src/persistence/sqlitePort";

const [binding, profile] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  !binding ||
  (profile !== "octant" && profile !== "nightly-test-data")
)
  throw Error("Supply the owned Windows SQLite fixture.");
const native = loadWindowsHostProfileNative(win32.resolve(binding));
if (native === undefined) throw Error("Owned native profile unavailable.");
const timeout = setTimeout(() => process.exit(2), 25000);
const held = await acquireWindowsHostProfileOwner({
  native,
  profile,
  env: {},
  instanceId: randomUUID(),
  serverVersion: "fixture",
  wireVersion: "1",
  serviceMode: "foreground",
});
if (held.status !== "ready" || held.ownership.kind !== "owner")
  throw Error("Owned native writer unavailable.");
console.log(JSON.stringify({ fixtureScope: held.paths.profileId }));
const checks: string[] = [];
function check(value: boolean, name: string) {
  if (!value) throw Error(`Owned SQLite proof failed: ${name}`);
  checks.push(name);
}
const stores = createWindowsSqliteStores(native, held.paths);
if (stores === undefined) throw Error("Owned SQLite native API unavailable.");
let database: Database | undefined;
let active: Extract<WindowsSqliteStoreAdmission, { status: "ready" }> | undefined;
try {
  let admitted = stores.main();
  if (admitted.status !== "ready") throw Error("Owned SQLite family refused.");
  active = admitted;
  const started = performance.now();
  database = new Database(admitted.databasePath);
  check(
    admitted.initialize(database).status === "ready",
    "the standard SQLite extension validates the actual guarded main handle",
  );
  check(
    database.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()?.locking_mode ===
      "normal",
    "native admission preserves SQLite normal coordination",
  );
  check(
    database.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get()?.journal_mode ===
      "wal",
    "the guarded database retains WAL mode",
  );
  database.exec(
    "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS proof(value TEXT NOT NULL); INSERT INTO proof VALUES('committed');",
  );
  const count = database
    .query<{ count: number }, []>("SELECT count(*) AS count FROM proof")
    .get()?.count;
  check(
    typeof count === "number" && count > 0,
    "the guarded runtime commits and reads the journal",
  );
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const concurrent = openReadOnlySqlite(admitted.databasePath);
  try {
    check(
      concurrent.all("SELECT value FROM proof").length === count,
      "an existing read-only consumer can read the live WAL store",
    );
  } finally {
    concurrent.close();
  }
  database.close();
  database = undefined;
  check(
    !existsSync(admitted.databasePath + "-wal"),
    "SQLite retains its ordinary clean-close sidecar cleanup",
  );
  check(
    admitted.close().status === "closed",
    "the native admission ends after the actual connection closes",
  );
  const originalPath = admitted.databasePath;
  renameSync(originalPath, originalPath + ".moved");
  renameSync(originalPath + ".moved", originalPath);
  admitted = stores.main();
  if (admitted.status !== "ready") throw Error("Reopened native store unavailable.");
  active = admitted;
  database = new Database(admitted.databasePath);
  check(
    admitted.initialize(database).status === "ready",
    "a new native admission initializes a reopened connection",
  );
  check(
    database.query<{ count: number }, []>("SELECT count(*) AS count FROM proof").get()?.count ===
      count,
    "a reopened connection retains committed rows",
  );
  const backup = win32.join(held.paths.dataDirectory, "sqlite-prototype-backup.sqlite3");
  if (existsSync(backup)) throw Error("Owned backup fixture already exists.");
  database.exec(`VACUUM main INTO '${backup.replace(/'/g, "''")}'`);
  const before = readFileSync(backup);
  const reading = openReadOnlySqlite(backup);
  try {
    check(
      reading.all("SELECT value FROM proof").length === count,
      "the existing foreign read-only adapter remains usable beside the live main connection",
    );
  } finally {
    reading.close();
  }
  check(
    before.equals(readFileSync(backup)),
    "the read-only adapter leaves its foreign snapshot bytes unchanged",
  );
  database.close();
  database = undefined;
  active.close();
  active = undefined;
  const portAdmission = stores.main();
  if (portAdmission.status !== "ready") throw Error("Server connection admission unavailable.");
  const connection = openAdmittedSqlite(portAdmission);
  try {
    check(
      connection.prepare("SELECT value FROM proof").all().length === count,
      "the production server adapter initializes and reads the admitted database",
    );
    connection.transaction(() =>
      connection.prepare("INSERT INTO proof VALUES (?)").run("server"),
    )();
  } finally {
    connection.close();
    connection.close();
  }
  renameSync(originalPath, originalPath + ".moved");
  renameSync(originalPath + ".moved", originalPath);
  checks.push("the production server adapter joins SQLite before releasing its native guard");
  const openOwned = (path: string) => {
    if (path !== originalPath) throw Error("Foreign primary file refused.");
    const next = stores.main();
    if (next.status !== "ready") throw Error("Owned primary file unavailable.");
    return openAdmittedSqlite(next);
  };
  const cleared = openOwned(originalPath);
  cleared.exec("DROP TABLE proof");
  cleared.close();
  const migrationInput = {
    dataDirectory: held.paths.dataDirectory,
    databasePath: originalPath,
    migrations: MIGRATIONS,
    clock: () => new Date().toISOString(),
    windowsFiles: stores,
    openConnection: openOwned,
  };
  const migrated = migrateStoreWithBackup(migrationInput);
  check(
    migrated.status.currentVersion === MIGRATIONS.at(-1)?.version,
    "the production migration boundary builds and verifies the complete journal schema",
  );
  const snapshot = originalPath + ".backup-native-proof";
  const receipt = createStoreBackup({
    connection: migrated.connection,
    dataDirectory: held.paths.dataDirectory,
    backupPath: snapshot,
    windowsFiles: stores,
  });
  check(
    receipt.byteLength > 0 && receipt.migrationVersion === migrated.status.currentVersion,
    "the production backup boundary admits and verifies a native snapshot",
  );
  migrated.connection.exec("CREATE TABLE after_snapshot(value TEXT)");
  migrated.connection.close();
  restoreStoreBackup({
    dataDirectory: held.paths.dataDirectory,
    databasePath: originalPath,
    backupPath: snapshot,
    windowsFiles: stores,
  });
  const restored = openOwned(originalPath);
  check(
    restored.prepare("SELECT name FROM sqlite_master WHERE name='after_snapshot'").get() ===
      undefined,
    "the production restore atomically replaces the store after closing its prior connection",
  );
  restored.close();
  let interrupted: unknown;
  try {
    migrateStoreWithBackup({
      ...migrationInput,
      migrations: [
        ...MIGRATIONS,
        {
          version: (MIGRATIONS.at(-1)?.version ?? 0) + 1,
          name: "native_failure_proof",
          sql: "CREATE TABLE partial_native_migration(value TEXT); INSERT INTO absent_native_proof VALUES (1)",
        },
      ],
    });
  } catch (error) {
    interrupted = error;
  }
  check(
    interrupted instanceof MigrationInterruptedRestored && interrupted.restored,
    "a failed production migration restores the verified native pre-migration snapshot",
  );
  const inspected = openOwned(originalPath);
  check(
    inspected
      .prepare("SELECT name FROM sqlite_master WHERE name='partial_native_migration'")
      .get() === undefined,
    "failed migration recovery leaves no partial schema",
  );
  inspected.close();
  for (const alias of [
    originalPath + ".backup-alias",
    originalPath + "-wal",
    originalPath + `.restore-${process.pid}.tmp`,
  ]) {
    linkSync(originalPath, alias);
    try {
      check(
        stores.inspect(alias.endsWith("-wal") ? originalPath : alias).status === "refused",
        "native lifecycle admission refuses an exposed backup, sidecar or restore-stage alias",
      );
    } finally {
      unlinkSync(alias);
    }
  }
  check(
    stores.backup("../outside").status === "refused",
    "backup labels never carry path authority",
  );

  console.log(
    JSON.stringify({
      profile,
      profileId: held.paths.profileId,
      runtime: process.versions,
      sqlitePrototypeChecks: checks,
      initializationMs: Math.round(performance.now() - started),
      startupAdmitted: false,
      workCodeEnabled: false,
    }),
  );
} finally {
  database?.close();
  active?.close();
  await held.ownership.release();
  native.close();
  clearTimeout(timeout);
}
