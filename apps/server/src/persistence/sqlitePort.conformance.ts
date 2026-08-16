import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteConnection } from "./sqlitePort.ts";

export type OpenSqlite = (path: string) => SqliteConnection;

export function assertSqliteConformance(openSqlite: OpenSqlite): void {
  const directory = mkdtempSync(join(tmpdir(), "octant-sqlite-port-"));
  const databasePath = join(directory, "octant.sqlite3");
  let connection: SqliteConnection | undefined;

  try {
    connection = openSqlite(databasePath);
    connection.exec("CREATE TABLE fixtures (value TEXT NOT NULL)");
    const insert = connection.prepare("INSERT INTO fixtures (value) VALUES (?)");
    connection.transaction(() => insert.run("portable"))();

    assert.deepEqual(connection.prepare("SELECT value FROM fixtures").get(), {
      value: "portable",
    });
    assert.equal(
      connection.prepare("SELECT value FROM fixtures WHERE value = ?").get("absent"),
      undefined,
    );
    assert.equal(connection.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  } finally {
    connection?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
