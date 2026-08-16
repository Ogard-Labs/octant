import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort.ts";

export function openBunSqlite(path: string): SqliteConnection {
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
    prepare: (sql) => {
      const statement = database.prepare(sql) as unknown as SqliteStatement;
      return {
        run: (...parameters) => statement.run(...parameters),
        get: (...parameters) => {
          const row = statement.get(...parameters);
          return row === null ? undefined : row;
        },
        all: (...parameters) => statement.all(...parameters),
      };
    },
    pragma: (source, options) => {
      const rows = database.query<Record<string, unknown>, []>(`PRAGMA ${source}`).all();
      if (options?.simple) {
        const firstRow = rows[0];
        return firstRow === undefined ? undefined : Object.values(firstRow)[0];
      }
      return rows;
    },
    transaction: (body) => database.transaction(body),
    close: () => database.close(),
  };
}
