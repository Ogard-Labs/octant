import { describe, expect, it } from "vitest";
import { assertSqliteConformance } from "./sqlitePort.conformance";
import {
  cacheStatements,
  openSqlite,
  runtimeSqliteKind,
  type SqliteConnection,
  type SqliteStatement,
} from "./sqlitePort";

describe("openSqlite", () => {
  it("selects Node SQLite in Electron Node mode without evaluating a Bun global", () => {
    expect(runtimeSqliteKind({ electron: "43.1.0", node: "24.0.0" })).toBe("node");
    expect(runtimeSqliteKind({ bun: "1.3.14" })).toBe("bun");
  });

  it("satisfies the shared SQLite connection contract", () => {
    assertSqliteConformance(openSqlite);
  });
});

describe("cacheStatements", () => {
  function countingConnection() {
    const prepared: Array<string> = [];
    const statement: SqliteStatement = {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
    };
    const connection: SqliteConnection = {
      exec: () => undefined,
      prepare: (sql) => {
        prepared.push(sql);
        return statement;
      },
      pragma: () => undefined,
      transaction: (body) => body,
      close: () => undefined,
    };
    return { connection, prepared };
  }

  it("compiles a statement once however many times its SQL is prepared", () => {
    const { connection, prepared } = countingConnection();
    const cached = cacheStatements(connection);
    const first = cached.prepare("SELECT 1");
    const second = cached.prepare("SELECT 1");
    cached.prepare("SELECT 2");
    expect(first).toBe(second);
    expect(prepared).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("drops the statement used longest ago once the cap is reached", () => {
    const { connection, prepared } = countingConnection();
    const cached = cacheStatements(connection, 2);
    cached.prepare("SELECT 1");
    cached.prepare("SELECT 2");
    cached.prepare("SELECT 1");
    cached.prepare("SELECT 3");
    cached.prepare("SELECT 1");
    cached.prepare("SELECT 2");
    expect(prepared).toEqual(["SELECT 1", "SELECT 2", "SELECT 3", "SELECT 2"]);
  });
});
