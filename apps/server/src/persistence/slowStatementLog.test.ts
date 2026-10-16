import { describe, expect, it } from "vitest";
import {
  createSlowStatementTally,
  DEFAULT_SLOW_STATEMENT_MS,
  instrumentSqlite,
  slowStatementOptionsFromEnvironment,
  statementShape,
} from "./slowStatementLog";
import type { SqliteConnection } from "./sqlitePort";

function fakeConnection(): SqliteConnection {
  return {
    exec: () => undefined,
    prepare: () => ({
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
    }),
    pragma: () => undefined,
    transaction: (body) => body,
    close: () => undefined,
  };
}

function clockSteppingBy(stepMs: number): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

describe("slow statement log", () => {
  it("logs a statement over the threshold once and counts it", () => {
    const lines: Array<string> = [];
    const tally = createSlowStatementTally();
    const connection = instrumentSqlite(
      fakeConnection(),
      { thresholdMs: 20, log: (line) => lines.push(line), now: clockSteppingBy(50) },
      tally,
    );
    connection.prepare("SELECT * FROM t WHERE id = ?").get("secret-value");
    expect(lines).toHaveLength(1);
    expect(tally.read()).toEqual({ count: 1, worstMs: 50 });
  });

  it("stays quiet at or under the threshold", () => {
    const lines: Array<string> = [];
    const tally = createSlowStatementTally();
    const connection = instrumentSqlite(
      fakeConnection(),
      { thresholdMs: 20, log: (line) => lines.push(line), now: clockSteppingBy(20) },
      tally,
    );
    connection.prepare("SELECT 1").all();
    expect(lines).toEqual([]);
    expect(tally.read().count).toBe(0);
  });

  it("logs the SQL shape and never a bound value", () => {
    const lines: Array<string> = [];
    const connection = instrumentSqlite(
      fakeConnection(),
      { thresholdMs: 0, log: (line) => lines.push(line), now: clockSteppingBy(5) },
      createSlowStatementTally(),
    );
    connection.prepare("UPDATE t SET name = ? WHERE id = ?").run("hunter2-token", 42);
    connection.exec("INSERT INTO t VALUES ('literal-secret', 7)");
    const text = lines.join("\n");
    expect(text).toContain("UPDATE t SET name = ? WHERE id = ?");
    expect(text).not.toContain("hunter2-token");
    expect(text).not.toContain("literal-secret");
    expect(statementShape("INSERT INTO t VALUES ('a''b', 7)")).toBe("INSERT INTO t VALUES (?, ?)");
  });

  it("keeps the worst duration across statements", () => {
    const tally = createSlowStatementTally();
    tally.record(30);
    tally.record(90);
    tally.record(40);
    expect(tally.read()).toEqual({ count: 3, worstMs: 90 });
  });

  it("uses the default threshold, logs only when asked under tests, and honours the variable", () => {
    const underTest = slowStatementOptionsFromEnvironment({ VITEST: "true" });
    expect(underTest.thresholdMs).toBe(DEFAULT_SLOW_STATEMENT_MS);
    expect(underTest.log).toBeUndefined();
    const enabled = slowStatementOptionsFromEnvironment({
      VITEST: "true",
      OCTANT_SLOW_STATEMENT_MS: "5",
    });
    expect(enabled.thresholdMs).toBe(5);
    expect(enabled.log).toBeDefined();
    expect(slowStatementOptionsFromEnvironment({}).log).toBeDefined();
    expect(
      slowStatementOptionsFromEnvironment({ OCTANT_SLOW_STATEMENT_MS: "abc" }).thresholdMs,
    ).toBe(DEFAULT_SLOW_STATEMENT_MS);
  });
});
