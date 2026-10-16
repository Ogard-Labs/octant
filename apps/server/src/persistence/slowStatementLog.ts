import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

/** Statements slower than this are logged unless `OCTANT_SLOW_STATEMENT_MS` says otherwise. */
export const DEFAULT_SLOW_STATEMENT_MS = 20;
const MAX_SHAPE_LENGTH = 200;

export interface SlowStatementCounters {
  readonly count: number;
  readonly worstMs: number;
}

export interface SlowStatementOptions {
  readonly thresholdMs: number;
  /** Receives one line per slow statement; `undefined` counts without logging. */
  readonly log: ((line: string) => void) | undefined;
  readonly now?: () => number;
}

/**
 * Process-wide tally since start. The diagnostics export reads it; it carries
 * no SQL text, so it is safe to export.
 */
class SlowStatementTally {
  #count = 0;
  #worstMs = 0;

  record(durationMs: number): void {
    this.#count += 1;
    if (durationMs > this.#worstMs) this.#worstMs = durationMs;
  }

  read(): SlowStatementCounters {
    return { count: this.#count, worstMs: Math.round(this.#worstMs) };
  }
}

export const slowStatementTally = new SlowStatementTally();

export function createSlowStatementTally(): SlowStatementTally {
  return new SlowStatementTally();
}

/**
 * Reads the threshold and whether to log. Logging is off under tests (Vitest
 * sets `VITEST`) unless the variable is set explicitly, so test output stays
 * quiet; an unusable value falls back to the default.
 */
export function slowStatementOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SlowStatementOptions {
  const raw = environment.OCTANT_SLOW_STATEMENT_MS;
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  const explicit = Number.isFinite(parsed) && parsed >= 0;
  const underTest = environment.VITEST !== undefined || environment.NODE_ENV === "test";
  return {
    thresholdMs: explicit ? parsed : DEFAULT_SLOW_STATEMENT_MS,
    log: underTest && !explicit ? undefined : (line) => console.warn(line),
  };
}

/**
 * Reduces SQL to a shape that cannot carry a bound value: prepared SQL holds
 * placeholders already, but `exec` text may embed literals, so quoted strings,
 * blobs, and numbers are replaced and the whole is bounded.
 */
export function statementShape(sql: string): string {
  const shape = sql
    .replace(/\bx'[0-9a-fA-F]*'/gi, "?")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  return shape.length > MAX_SHAPE_LENGTH ? `${shape.slice(0, MAX_SHAPE_LENGTH)}...` : shape;
}

/**
 * Wraps a connection so each statement execution is timed with one clock pair.
 * Sits above both SQLite backends so they behave the same.
 */
export function instrumentSqlite(
  connection: SqliteConnection,
  options: SlowStatementOptions = slowStatementOptionsFromEnvironment(),
  tally: Pick<SlowStatementTally, "record"> = slowStatementTally,
): SqliteConnection {
  const now = options.now ?? (() => performance.now());
  const time = <A>(sql: string, run: () => A): A => {
    const start = now();
    try {
      return run();
    } finally {
      const durationMs = now() - start;
      if (durationMs > options.thresholdMs) {
        tally.record(durationMs);
        options.log?.(
          `[slow-statement] ${Math.round(durationMs)} ms over ${options.thresholdMs} ms: ${statementShape(sql)}`,
        );
      }
    }
  };
  return {
    exec: (sql) => time(sql, () => connection.exec(sql)),
    prepare: (sql) => {
      const statement = connection.prepare(sql);
      const timed: SqliteStatement = {
        run: (...parameters) => time(sql, () => statement.run(...parameters)),
        get: (...parameters) => time(sql, () => statement.get(...parameters)),
        all: (...parameters) => time(sql, () => statement.all(...parameters)),
      };
      return timed;
    },
    pragma: (source, pragmaOptions) => connection.pragma(source, pragmaOptions),
    transaction: (body) => connection.transaction(body),
    close: () => connection.close(),
  };
}
