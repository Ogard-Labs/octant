import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { EventActor } from "@octant/contracts";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { registerSideTaskReportEvents, SideTaskReportStore } from "./sideTaskReportStore";
import {
  createSideTaskReportDetection,
  sideTaskCompletionReport,
  sideTaskFailureReport,
  sideTaskReportOutcomeForStop,
  type SideTaskReportDraft,
} from "./sideTaskReports";

const base = {
  parentThreadId: "00000000-0000-4000-8000-0000000000aa",
  parentMode: "chat" as const,
  title: "Fix stale install docs",
  endedAt: "2026-11-24T12:00:00.000Z",
};

describe("the report a child turn owes", () => {
  it("carries a completion's reply whole when it fits", () => {
    const report = sideTaskCompletionReport({ ...base, text: "Updated the docs." });
    expect(report).toMatchObject({ outcome: "completed", text: "Updated the docs." });
    expect(report.truncated).toBeUndefined();
  });

  it("cuts a long reply to what one report carries and admits the cut", () => {
    const report = sideTaskCompletionReport({ ...base, text: "x".repeat(5_000) });
    expect(report.text).toHaveLength(4_096);
    expect(report.truncated).toBe(true);
  });

  it("carries no text for a completion that produced none", () => {
    const report = sideTaskCompletionReport({ ...base, text: "   " });
    expect(report.text).toBeUndefined();
  });

  it("reads a cancellation as a cancellation and a failure as a failure", () => {
    expect(sideTaskReportOutcomeForStop("cancelled")).toBe("cancelled");
    expect(sideTaskReportOutcomeForStop("failed")).toBe("failed");
    expect(sideTaskReportOutcomeForStop("end-of-turn")).toBeUndefined();
    expect(sideTaskReportOutcomeForStop("max-tokens")).toBeUndefined();
  });

  it("carries no text for a failure", () => {
    const report = sideTaskFailureReport({ ...base, outcome: "failed" });
    expect(report).toMatchObject({ outcome: "failed" });
    expect("text" in report).toBe(false);
  });
});

describe("the detection that owes a report when a child turn ends", () => {
  const childThread = "00000000-0000-4000-8000-0000000000bb";
  const offering = "00000000-0000-4000-8000-0000000000aa";

  function detection(
    reports: { owe: (child: string, draft: SideTaskReportDraft) => "owed" | "stopped" },
    parentOf: (child: string) => string | undefined = () => offering,
  ) {
    return createSideTaskReportDetection({
      parentOf,
      offerFor: () => ({ title: "Fix stale install docs", mode: "chat" as const }),
      reports,
      now: () => "2026-11-24T12:00:00.000Z",
    });
  }

  it("owes nothing for a thread no side task offered", () => {
    const owe = vi.fn(() => "owed" as const);
    const detector = detection({ owe }, () => undefined);
    detector.turnCompleted({ threadId: childThread, text: "Done." });
    detector.turnEnded(childThread, { stopReason: "failed", endedAt: "2026-11-24T12:00:00.000Z" });
    expect(owe).not.toHaveBeenCalled();
  });

  it("owes exactly one report for a completed turn, not a second at its end", () => {
    const owed: SideTaskReportDraft[] = [];
    const detector = detection({
      owe: (_child, draft) => {
        owed.push(draft);
        return "owed";
      },
    });
    detector.turnCompleted({ threadId: childThread, text: "The docs are updated." });
    detector.turnEnded(childThread, {
      stopReason: "cancelled",
      endedAt: "2026-11-24T12:00:01.000Z",
    });
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ outcome: "completed", text: "The docs are updated." });
  });

  it("owes a cancelled turn's outcome alone, with no reply text", () => {
    const owed: SideTaskReportDraft[] = [];
    const detector = detection({
      owe: (_child, draft) => {
        owed.push(draft);
        return "owed";
      },
    });
    detector.turnCompleted({ threadId: childThread, text: "Earlier reply" });
    detector.turnStarted(childThread);
    owed.length = 0;
    detector.turnEnded(childThread, {
      stopReason: "cancelled",
      endedAt: "2026-11-24T12:00:01.000Z",
    });
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ outcome: "cancelled" });
    expect("text" in (owed[0] ?? {})).toBe(false);
  });
});

describe("a child whose reporting is stopped", () => {
  const directories: string[] = [];
  const actor = Schema.decodeUnknownSync(EventActor)({
    kind: "local-user",
    actorId: "77777777-7777-4777-8777-777777777777",
  });
  afterEach(() => {
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  it("owes nothing when its turn ends", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-side-task-detect-"));
    directories.push(directory);
    const connection: SqliteConnection = openSqlite(join(directory, "events.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => "2026-11-24T12:00:00.000Z");
    const journal = new Journal({
      connection,
      registry: registerSideTaskReportEvents(new EventRegistry()),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => "2026-11-24T12:00:00.000Z",
    });
    const reports = new SideTaskReportStore({
      journal,
      uuid: () => "00000000-0000-4000-8000-0000000000dd",
      actor,
      clock: () => "2026-11-24T12:00:00.000Z",
    });
    const child = "00000000-0000-4000-8000-0000000000bb";
    reports.setReporting(child, false);
    const detector = createSideTaskReportDetection({
      parentOf: () => "00000000-0000-4000-8000-0000000000aa",
      offerFor: () => ({ title: "Fix stale install docs", mode: "chat" as const }),
      reports,
      now: () => "2026-11-24T12:00:00.000Z",
    });
    detector.turnCompleted({ threadId: child, text: "Done." });
    detector.turnEnded(child, { stopReason: "failed", endedAt: "2026-11-24T12:00:01.000Z" });
    expect(reports.undelivered()).toHaveLength(0);
  });
});
