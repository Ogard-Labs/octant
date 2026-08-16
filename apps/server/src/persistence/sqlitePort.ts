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

export function runtimeSqliteKind(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): "bun" | "node" {
  return versions.bun === undefined ? "node" : "bun";
}

const openRuntimeSqlite =
  runtimeSqliteKind() === "node"
    ? (await import("./sqlitePort.node.ts")).openNodeSqlite
    : (await import("./sqlitePort.bun.ts")).openBunSqlite;

export function openSqlite(path: string): SqliteConnection {
  return openRuntimeSqlite(path);
}
