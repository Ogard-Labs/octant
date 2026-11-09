import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import {
  MOVED_HISTORY_HANDOFF_CHARACTERS,
  MovedThreadHistory,
  movedHistoryHandoff,
  registerMovedHistoryEvents,
} from "./movedThreadHistory";

const now = "2026-11-08T12:00:00.000Z";
const THREAD = "77777777-7777-4777-8777-777777777777";
const MOVE = "99999999-9999-4999-8999-999999999999";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

let counter = 0;
function history(): MovedThreadHistory {
  const folder = mkdtempSync(join(tmpdir(), "octant-moved-history-"));
  folders.push(folder);
  const connection = openSqlite(join(folder, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const journal = new Journal({
    connection,
    registry: registerMovedHistoryEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  return new MovedThreadHistory({
    journal,
    clock: () => now,
    uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`,
    actor: { kind: "system", actorId: "66666666-6666-4666-8666-666666666666" } as never,
  });
}

const entries = [
  { role: "person" as const, text: "Add a dark mode toggle", occurredAt: now as never },
  { role: "assistant" as const, text: "Added it to Settings.", occurredAt: now as never },
];

describe("a moved thread's earlier conversation", () => {
  it("hands the conversation to the first turn once, then never again", () => {
    const moved = history();
    moved.journalImported({ threadId: THREAD, moveId: MOVE, entries });

    const block = moved.peekFramedForFirstTurn(THREAD);
    expect(block?.section).toBe("conversation");
    expect(block?.text).toContain("moved here from another of the person's computers");
    expect(block?.text).toContain("Person: Add a dark mode toggle");
    expect(block?.text).toContain("Assistant: Added it to Settings.");

    moved.consumeFramedForFirstTurn(THREAD);
    expect(moved.peekFramedForFirstTurn(THREAD)).toBeUndefined();
    expect(moved.history(THREAD)).toHaveLength(2);
  });

  it("keeps the first import when a retried arrival imports again", () => {
    const moved = history();
    moved.journalImported({ threadId: THREAD, moveId: MOVE, entries });
    moved.journalImported({ threadId: THREAD, moveId: MOVE, entries: entries.slice(0, 1) });
    expect(moved.history(THREAD)).toHaveLength(2);
  });

  it("keeps the newest messages when the conversation is too long, and says how many were left out", () => {
    const long = Array.from({ length: 30 }, (_, index) => ({
      role: "person" as const,
      text: `${String(index)} ${"x".repeat(10_000)}`,
      occurredAt: now as never,
    }));
    const text = movedHistoryHandoff(long);
    expect(text.length).toBeLessThan(MOVED_HISTORY_HANDOFF_CHARACTERS + 1_000);
    expect(text).toContain("earlier messages are left out for length");
    expect(text).toContain("Person: 29 ");
    expect(text).not.toContain("Person: 0 ");
  });
});
