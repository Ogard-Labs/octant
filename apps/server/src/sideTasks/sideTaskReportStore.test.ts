import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EventActor } from "@octant/contracts";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { registerSideTaskReportEvents, SideTaskReportStore } from "./sideTaskReportStore";

const now = "2026-11-24T12:00:00.000Z";
const parent = "00000000-0000-4000-8000-0000000000aa";
const child = "00000000-0000-4000-8000-0000000000bb";
const sibling = "00000000-0000-4000-8000-0000000000cc";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const directories: string[] = [];
let sequence = 0;

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-side-task-reports-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function storeOn(connection: SqliteConnection): SideTaskReportStore {
  const journal = new Journal({
    connection,
    registry: registerSideTaskReportEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  return new SideTaskReportStore({
    journal,
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    actor,
    clock: () => now,
  });
}

function completion(text: string | undefined = "The install docs are updated.") {
  return {
    parentThreadId: parent,
    parentMode: "chat" as const,
    title: "Fix stale install docs",
    outcome: "completed" as const,
    ...(text === undefined ? {} : { text }),
    endedAt: now,
  } as never;
}

describe("SideTaskReportStore", () => {
  it("keeps a report owed until its delivery lands, past a restart", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    expect(store.owe(child, completion())).toBe("owed");
    expect(store.undelivered()).toHaveLength(1);

    // A new store on the same journal is the host after a restart: the report
    // is still owed, and marking it delivered is what retires it.
    const restarted = storeOn(connection);
    expect(restarted.undelivered()).toHaveLength(1);
    const owed = restarted.undelivered()[0];
    restarted.markDelivered(child, [String(owed!.report.reportId)]);
    expect(restarted.undelivered()).toHaveLength(0);
    expect(storeOn(connection).undelivered()).toHaveLength(0);
  });

  it("gathers everything one parent is owed across children, oldest first within each", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    store.owe(child, completion("First"));
    store.owe(child, completion("Second"));
    store.owe(sibling, completion("Sibling"));

    const owed = store.undeliveredForParent(parent);
    expect(owed).toHaveLength(3);
    expect(owed.map((entry) => entry.report.text)).toEqual(["First", "Second", "Sibling"]);
    expect(owed[2]?.childThreadId).toBe(sibling);
    expect(store.undeliveredForParent("00000000-0000-4000-8000-0000000000dd")).toHaveLength(0);
  });

  it("owes nothing while reporting is stopped, and owes again once resumed", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    store.setReporting(child, false);
    expect(store.owe(child, completion())).toBe("stopped");
    expect(store.undelivered()).toHaveLength(0);

    // The stop is journaled: a restarted host still owes nothing for the child.
    const restarted = storeOn(connection);
    expect(restarted.reportingOn(child)).toBe(false);
    restarted.setReporting(child, true);
    expect(storeOn(connection).reportingOn(child)).toBe(true);
    expect(storeOn(connection).owe(child, completion())).toBe("owed");
  });

  it("does not deliver a report twice when the mark is replayed", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    store.owe(child, completion());
    const owed = store.undelivered()[0];
    store.markDelivered(child, [String(owed!.report.reportId)]);
    store.markDelivered(child, [String(owed!.report.reportId)]);
    expect(storeOn(connection).undelivered()).toHaveLength(0);
  });
});
