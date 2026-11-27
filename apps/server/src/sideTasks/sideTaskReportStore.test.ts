import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  EventActor,
  THREAD_RETENTION_EVENT_NAMES,
  THREAD_SIDE_TASK_REPORTS_AGGREGATE_TYPE,
  THREAD_SIDE_TASK_REPORT_EVENT_NAMES,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  ThreadRetentionThreadPurged,
} from "@octant/contracts";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { THREAD_RETENTION_AGGREGATE } from "../persistence/threadRetentionProjection";
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

function journalOn(connection: SqliteConnection): Journal {
  return new Journal({
    connection,
    registry: registerSideTaskReportEvents(new EventRegistry()).register(
      THREAD_RETENTION_EVENT_NAMES.threadPurged,
      1,
      ThreadRetentionThreadPurged,
    ),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
}

function storeOn(connection: SqliteConnection): SideTaskReportStore {
  return new SideTaskReportStore({
    journal: journalOn(connection),
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

  it("names the thread each report came from, past a restart", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    store.owe(child, completion("First"));
    store.owe(sibling, completion("Sibling"));

    expect(
      storeOn(connection)
        .undeliveredForParent(parent)
        .map((entry) => entry.report.childThreadId),
    ).toEqual([child, sibling]);
  });

  it("delivers a report journaled before reports named their thread with the thread it is filed under", () => {
    const connection = openConnection();
    journalOn(connection).append({
      aggregate: {
        aggregateType: THREAD_SIDE_TASK_REPORTS_AGGREGATE_TYPE,
        aggregateId: Schema.decodeUnknownSync(AggregateId)(child),
      },
      expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(0),
      events: [
        {
          eventId: Schema.decodeUnknownSync(EventId)("00000000-0000-4000-8000-00000000e001"),
          eventName: THREAD_SIDE_TASK_REPORT_EVENT_NAMES.owed,
          eventVersion: 1,
          correlationId: Schema.decodeUnknownSync(CorrelationId)(
            "00000000-0000-4000-8000-00000000e002",
          ),
          actor,
          occurredAt: now,
          payload: {
            reportId: "00000000-0000-4000-8000-00000000e003",
            parentThreadId: parent,
            parentMode: "chat",
            title: "Fix stale install docs",
            outcome: "failed",
            endedAt: now,
            owedAt: now,
          },
        },
      ],
    });

    const [entry] = storeOn(connection).undeliveredForParent(parent);
    expect(entry?.report.title).toBe("Fix stale install docs");
    expect(entry?.report.childThreadId).toBe(child);
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

  it("forgets what a purged child reported and owes nothing that names a purged thread", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    store.owe(child, completion("From the purged child"));
    store.owe(sibling, completion("From a sibling"));

    store.forgetPurgedThread(child);
    expect(store.undeliveredForParent(parent).map((entry) => entry.report.text)).toEqual([
      "From a sibling",
    ]);
    // A turn that was still winding down when its thread was purged.
    expect(store.owe(child, completion())).toBe("purged");
    // Its receipt still sits on the parent; the switch must not write it back.
    expect(store.setReporting(child, false)).toBe("purged");

    store.forgetPurgedThread(parent);
    expect(store.undelivered()).toHaveLength(0);
    expect(store.owe(sibling, completion())).toBe("purged");
  });

  it("remembers a purge past a restart, so a surviving receipt's switch writes nothing back", () => {
    const connection = openConnection();
    journalOn(connection).append({
      aggregate: {
        aggregateType: THREAD_RETENTION_AGGREGATE,
        aggregateId: "00000000-0000-4000-8000-0000000000f1",
      },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-0000000000f2",
          eventName: THREAD_RETENTION_EVENT_NAMES.threadPurged,
          eventVersion: 1,
          correlationId: "00000000-0000-4000-8000-0000000000f3",
          actor,
          occurredAt: now,
          payload: { kind: "thread-purged", mode: "chat", threadId: child, purgedAt: now },
        },
      ],
    } as never);

    const restarted = storeOn(connection);
    expect(restarted.setReporting(child, false)).toBe("purged");
    expect(restarted.owe(child, completion())).toBe("purged");
    expect(storeOn(connection).undelivered()).toHaveLength(0);
  });

  it("settles a deleted child's waiting reports for good", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    store.owe(child, completion());
    store.refuseOwedFrom(child, "The side task's thread was deleted.");
    expect(store.reportsForParent(parent)[0]?.state).toBe("refused");
    expect(storeOn(connection).undelivered()).toHaveLength(0);
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
