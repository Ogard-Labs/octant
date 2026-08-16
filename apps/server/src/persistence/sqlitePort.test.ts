import { describe, expect, it } from "vitest";
import { assertSqliteConformance } from "./sqlitePort.conformance";
import { openSqlite, runtimeSqliteKind } from "./sqlitePort";

describe("openSqlite", () => {
  it("selects Node SQLite in Electron Node mode without evaluating a Bun global", () => {
    expect(runtimeSqliteKind({ electron: "43.1.0", node: "24.0.0" })).toBe("node");
    expect(runtimeSqliteKind({ bun: "1.3.14" })).toBe("bun");
  });

  it("satisfies the shared SQLite connection contract", () => {
    assertSqliteConformance(openSqlite);
  });
});
