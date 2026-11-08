import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
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
