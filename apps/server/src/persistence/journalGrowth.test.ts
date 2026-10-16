import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeJournalGrowth } from "@octant/contracts";
import { readJournalGrowth } from "./journalGrowth";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openJournal(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-journal-growth-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-16T12:00:00.000Z");
  return connection;
}

let sequence = 0;
function seed(connection: SqliteConnection, kind: string, occurredAt: string, count: number) {
  const insert = connection.prepare(`
    INSERT INTO event_journal (
      event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
      correlation_id, actor_kind, actor_id, occurred_at, payload_json
    ) VALUES (?, ?, ?, 1, 'seed.event@1', 1, 'correlation', 'system', 'actor', ?, ?)
  `);
  for (let index = 0; index < count; index += 1) {
    sequence += 1;
    insert.run(
      `event-${String(sequence)}`,
      kind,
      `secret-aggregate-${String(sequence)}`,
      occurredAt,
      JSON.stringify({ title: "Private thread name", token: "sk-do-not-leak" }),
    );
  }
}

const NOW = new Date("2026-10-16T09:30:00.000Z");

describe("journal growth", () => {
  it("counts events per kind per day over the last 14 days, newest day last", () => {
    const connection = openJournal();
    seed(connection, "chat-thread", "2026-10-16T01:00:00.000Z", 3);
    seed(connection, "chat-thread", "2026-10-15T23:59:59.000Z", 2);
    seed(connection, "chat-thread", "2026-10-03T00:00:00.000Z", 4);
    seed(connection, "automation", "2026-10-16T08:00:00.000Z", 1);
    // Day 15 back from today and a future-dated row are outside the window.
    seed(connection, "chat-thread", "2026-10-02T23:59:59.000Z", 7);
    seed(connection, "automation", "2026-10-17T00:00:01.000Z", 5);

    const growth = readJournalGrowth(connection, NOW);

    expect(growth.days).toHaveLength(14);
    expect(growth.days[0]).toBe("2026-10-03");
    expect(growth.days[13]).toBe("2026-10-16");
    expect(growth.kinds).toEqual([
      { kind: "chat-thread", counts: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3], total: 9 },
      { kind: "automation", counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], total: 1 },
    ]);
    expect(growth.totalRows).toBe(22);
    expect(growth.databaseBytes).toBeGreaterThan(0);
  });

  it("answers from the occurred-at index rather than scanning the journal", () => {
    const connection = openJournal();
    const plan = connection
      .prepare(
        `EXPLAIN QUERY PLAN SELECT aggregate_type, substr(occurred_at, 1, 10), count(*)
         FROM event_journal INDEXED BY event_journal_occurred_at
         WHERE occurred_at >= ? GROUP BY aggregate_type, 2`,
      )
      .all("2026-10-03") as ReadonlyArray<{ readonly detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain("event_journal_occurred_at");
  });

  it("carries kind names and counts only, never payloads or identifiers", () => {
    const connection = openJournal();
    seed(connection, "chat-thread", "2026-10-16T01:00:00.000Z", 2);

    const serialized = JSON.stringify(readJournalGrowth(connection, NOW));

    expect(serialized).not.toContain("Private thread name");
    expect(serialized).not.toContain("sk-do-not-leak");
    expect(serialized).not.toContain("secret-aggregate");
    expect(serialized).not.toContain("correlation");
  });

  it("reports an empty journal as zero rows and no kinds", () => {
    const growth = readJournalGrowth(openJournal(), NOW);
    expect(growth.kinds).toEqual([]);
    expect(growth.totalRows).toBe(0);
  });

  it("refuses a report that smuggles an extra field past the contract", () => {
    const growth = readJournalGrowth(openJournal(), NOW);
    expect(() => decodeJournalGrowth({ ...growth, payload: "x" })).toThrow();
  });
});
