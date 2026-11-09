import type { WindowsSqliteStoreAdmission } from "@octant/host-runtime";
import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import type { ReadOnlySqliteConnection, SqliteConnection, SqliteStatement } from "./sqlitePort.ts";

export function openNodeSqlite(
  path: string,
  admission?: Extract<WindowsSqliteStoreAdmission, { readonly status: "ready" }>,
): SqliteConnection {
  const database = new Database(path);

  try {
    if (admission !== undefined) {
      if (admission.databasePath !== path || admission.initialize(database).status !== "ready")
        throw new Error("The SQLite native admission was refused.");
    } else {
      chmodSync(path, 0o600);
    }
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      -- Streamed replies batch their deltas into one journal commit per burst, so FULL fsyncs a bounded ~10 times a second instead of once per token; the authoritative journal stays durable to the last committed burst.
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `);
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => database.prepare(sql) as unknown as SqliteStatement,
    pragma: (source, options) => database.pragma(source, options),
    transaction: (body) => database.transaction(body),
    close: () => {
      if (closed) return;
      database.close();
      closed = true;
      admission?.close();
    },
  };
}

export function openNodeSqliteReadOnly(path: string): ReadOnlySqliteConnection {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  return {
    all: (sql) => database.prepare(sql).all(),
    close: () => database.close(),
  };
}
