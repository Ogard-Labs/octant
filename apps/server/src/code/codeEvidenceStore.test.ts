import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, applyMigrations } from "../persistence/migrations";
import { openSqlite } from "../persistence/sqlitePort";
import { CodeEvidenceCapacityExceeded, CodeEvidenceStore } from "./codeEvidenceStore";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("CodeEvidenceStore", () => {
  it("deduplicates identical evidence and enforces aggregate storage bounds", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-code-evidence-bounds-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => "2026-08-06T08:00:00.000Z");
    let id = 1;
    const store = new CodeEvidenceStore({
      connection,
      newContentId: () => `90000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
      maxStoredBytes: 5,
      maxEntries: 2,
    });

    const first = store.put("four");
    const duplicate = store.put("four", { truncated: true });
    expect(duplicate).toEqual({ ...first, truncated: true });
    expect(
      connection.prepare("SELECT COUNT(*) AS count FROM code_evidence_content_store").get(),
    ).toEqual({ count: 1 });
    expect(() => store.put("xx")).toThrow(CodeEvidenceCapacityExceeded);
    expect(
      connection.prepare("SELECT COUNT(*) AS count FROM code_evidence_content_store").get(),
    ).toEqual({ count: 1 });
    connection.close();
  });

  it("reads aggregate capacity once instead of rescanning the evidence table per chunk", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-code-evidence-counters-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => "2026-08-06T08:00:00.000Z");
    const prepare = vi.spyOn(connection, "prepare");
    const store = new CodeEvidenceStore({ connection });

    store.put("first");
    store.put("second");

    expect(
      prepare.mock.calls.filter(([sql]) => String(sql).includes("COALESCE(SUM(byte_length), 0)")),
    ).toHaveLength(1);
    connection.close();
  });

  it("restores verified conversation evidence after the server database reopens", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-code-evidence-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const clock = () => "2026-08-06T08:00:00.000Z";

    const firstConnection = openSqlite(path);
    applyMigrations(firstConnection, MIGRATIONS, clock);
    const first = new CodeEvidenceStore({
      connection: firstConnection,
      newContentId: () => "90000000-0000-4000-8000-000000000001",
    });
    const reference = first.put("A durable provider reply.");
    firstConnection.close();

    const reopenedConnection = openSqlite(path);
    applyMigrations(reopenedConnection, MIGRATIONS, clock);
    const reopened = new CodeEvidenceStore({ connection: reopenedConnection });
    expect(reopened.read(reference)).toBe("A durable provider reply.");

    reopenedConnection
      .prepare("UPDATE code_evidence_content_store SET body_text = ? WHERE content_id = ?")
      .run("tampered", reference.contentId);
    expect(reopened.read(reference)).toBeUndefined();
    reopenedConnection.close();
  });
});
