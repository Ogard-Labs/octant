import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import type { ReadOnlySqliteConnection, SqliteConnection, SqliteStatement } from "./sqlitePort.ts";

export function openNodeSqlite(path: string): SqliteConnection {
  const database = new Database(path);

  try {
    chmodSync(path, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => database.prepare(sql) as unknown as SqliteStatement,
    pragma: (source, options) => database.pragma(source, options),
    transaction: (body) => database.transaction(body),
    close: () => database.close(),
  };
}

export function openNodeSqliteReadOnly(path: string): ReadOnlySqliteConnection {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  return {
    all: (sql) => database.prepare(sql).all(),
    close: () => database.close(),
  };
}
