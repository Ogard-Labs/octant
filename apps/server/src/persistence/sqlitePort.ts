import { instrumentSqlite } from "./slowStatementLog";

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...parameters: ReadonlyArray<unknown>): SqliteRunResult;
  /** Returns `undefined` when the query has no matching row. */
  get(...parameters: ReadonlyArray<unknown>): unknown;
  all(...parameters: ReadonlyArray<unknown>): ReadonlyArray<unknown>;
}

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
  transaction<A>(body: () => A): () => A;
  close(): void;
}

/**
 * A connection to a database another program owns. It opens read-only, sets
 * no pragmas, and never changes the file's mode, so reading it leaves the
 * owner's file exactly as it was.
 */
export interface ReadOnlySqliteConnection {
  all(sql: string): ReadonlyArray<unknown>;
  close(): void;
}

export function runtimeSqliteKind(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): "bun" | "node" {
  return versions.bun === undefined ? "node" : "bun";
}

const runtimeSqlite =
  runtimeSqliteKind() === "node"
    ? await import("./sqlitePort.node.ts").then((module) => ({
        open: module.openNodeSqlite,
        openReadOnly: module.openNodeSqliteReadOnly,
      }))
    : await import("./sqlitePort.bun.ts").then((module) => ({
        open: module.openBunSqlite,
        openReadOnly: module.openBunSqliteReadOnly,
      }));
const openRuntimeSqlite = runtimeSqlite.open;

export function openSqlite(path: string): SqliteConnection {
  return instrumentSqlite(openRuntimeSqlite(path));
}

export function openReadOnlySqlite(path: string): ReadOnlySqliteConnection {
  return runtimeSqlite.openReadOnly(path);
}
