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

const DEFAULT_STATEMENT_CACHE_CAPACITY = 1024;

export function openSqlite(path: string): SqliteConnection {
  return instrumentSqlite(cacheStatements(openRuntimeSqlite(path)));
}

/**
 * Keeps one compiled statement per SQL text, least recently used dropped
 * first past the cap. Every read and projection in this package prepares its
 * statement at the call, so a streamed Chat reply that re-indexed its turn
 * compiled the same few statements hundreds of times per delta; compiling
 * was 42% of the projection's time on a 775-delta reply. SQLite re-prepares
 * a cached statement itself when the schema changes under it. Statements
 * here never hold an open cursor (`get`, `all`, and `run` finish before they
 * return), so sharing one across callers is safe.
 */
export function cacheStatements(
  connection: SqliteConnection,
  capacity = DEFAULT_STATEMENT_CACHE_CAPACITY,
): SqliteConnection {
  const statements = new Map<string, SqliteStatement>();
  return {
    exec: (sql) => connection.exec(sql),
    prepare: (sql) => {
      const cached = statements.get(sql);
      if (cached !== undefined) {
        statements.delete(sql);
        statements.set(sql, cached);
        return cached;
      }
      const statement = connection.prepare(sql);
      if (statements.size >= capacity) {
        const oldest = statements.keys().next();
        if (!oldest.done) statements.delete(oldest.value);
      }
      statements.set(sql, statement);
      return statement;
    },
    pragma: (source, options) => connection.pragma(source, options),
    transaction: (body) => connection.transaction(body),
    close: () => {
      statements.clear();
      connection.close();
    },
  };
}

export function openReadOnlySqlite(path: string): ReadOnlySqliteConnection {
  return runtimeSqlite.openReadOnly(path);
}
