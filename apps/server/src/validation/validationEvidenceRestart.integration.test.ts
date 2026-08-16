import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createValidationEvidenceLoader } from "./validationEvidenceLoader";
import { ValidationEventStore } from "./validationEventStore";
import { ValidationEvidenceProjection } from "./validationEvidenceProjection";
import {
  ValidationEvidenceRecorded,
  ValidationPlanCreated,
  ValidationReportCompleted,
  type ToolActionAuthority,
  type ValidationEvidenceRecord,
  type ValidationPlan,
  type ValidationReport,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";

const directories: Array<string> = [];
const now = "2026-07-24T08:00:00.000Z";

function openConnection(path: string): SqliteConnection {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const authority: ToolActionAuthority = {
  hostId: "00000000-0000-0000-0000-000000000004" as never,
  mode: "code",
  projectId: "00000000-0000-0000-0000-000000000005" as never,
  providerInstanceId: "00000000-0000-0000-0000-000000000006" as never,
  extension: { kind: "core" },
};

const ids = {
  plan: "00000000-0000-4000-8000-000000000001",
  evidence: "00000000-0000-4000-8000-000000000010",
  actor: "77777777-7777-4777-8777-777777777777",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });

function makePlan(): ValidationPlan {
  return Schema.decodeUnknownSync(ValidationPlanCreated)({
    plan: {
      planId: ids.plan,
      authority,
      steps: [{ stepId: "s1", description: "Run tests", sources: [] }],
      createdAt: now,
    },
  }).plan;
}

function makeEvidence(): ValidationEvidenceRecord {
  return Schema.decodeUnknownSync(ValidationEvidenceRecorded)({
    evidence: {
      evidenceId: ids.evidence,
      planId: ids.plan,
      stepId: "s1",
      source: { kind: "repository-test", reference: "opaque-token-abc" },
      outcome: "passed",
      authority,
      observedAt: now,
      redacted: false,
    },
  }).evidence;
}

function makeReport(): ValidationReport {
  return Schema.decodeUnknownSync(ValidationReportCompleted)({
    report: {
      planId: ids.plan,
      authority,
      evidence: [],
      overallOutcome: "passed",
      completedAt: now,
      stepResults: [{ stepId: "s1", outcome: "passed", evidenceCount: 1 }],
    },
  }).report;
}

function makeRegistries(): { events: EventRegistry; projections: ProjectionRegistry } {
  return {
    events: new EventRegistry()
      .register("validation.plan-created@1", 1, ValidationPlanCreated)
      .register("validation.evidence-recorded@1", 1, ValidationEvidenceRecorded)
      .register("validation.report-completed@1", 1, ValidationReportCompleted),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(new ValidationEvidenceProjection()),
  };
}

function makeUuid(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  };
}

describe("validation evidence restart replay", () => {
  it("restores the same evidence snapshot after server restart via catch-up replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-validation-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");

    // First boot: append validation events.
    const first = openConnection(path);
    const firstRegistries = makeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRegistries.events,
      projections: firstRegistries.projections,
      clock: () => now,
    });
    const firstStore = new ValidationEventStore({
      journal: firstJournal,
      uuid: makeUuid(),
      actor,
    });
    firstStore.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    firstStore.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    firstStore.appendReport({ report: makeReport(), expectedVersion: 2 });

    const firstSnapshot = createValidationEvidenceLoader({
      connection: first,
      clock: () => now,
    })({ authority });
    expect(firstSnapshot.kind).toBe("snapshot");
    first.close();

    // Second boot: reopen, catch up the projection from the journal, and
    // assert the same snapshot is restored without duplicate or stale evidence.
    const reopened = openConnection(path);
    const restartedRegistries = makeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRegistries.events,
      projections: restartedRegistries.projections,
      clock: () => now,
    });
    for (const projection of restartedRegistries.projections.all()) {
      catchUpProjection({
        connection: reopened,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }

    const restartedSnapshot = createValidationEvidenceLoader({
      connection: reopened,
      clock: () => now,
    })({ authority });

    expect(restartedSnapshot.kind).toBe("snapshot");
    if (restartedSnapshot.kind === "snapshot" && firstSnapshot.kind === "snapshot") {
      expect(restartedSnapshot.snapshot.overallOutcome).toBe(firstSnapshot.snapshot.overallOutcome);
      expect(restartedSnapshot.snapshot.timeline).toHaveLength(
        firstSnapshot.snapshot.timeline.length,
      );
      expect(restartedSnapshot.snapshot.sequence).toBe(firstSnapshot.snapshot.sequence);
      expect(restartedSnapshot.snapshot.report?.overallOutcome).toBe(
        firstSnapshot.snapshot.report?.overallOutcome,
      );
    }
    reopened.close();
  });

  it("reconnect replay with afterSequence produces the same snapshot without duplicates", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-validation-reconnect-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");

    const first = openConnection(path);
    const firstRegistries = makeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRegistries.events,
      projections: firstRegistries.projections,
      clock: () => now,
    });
    const firstStore = new ValidationEventStore({
      journal: firstJournal,
      uuid: makeUuid(),
      actor,
    });
    firstStore.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    firstStore.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });

    const loader = createValidationEvidenceLoader({
      connection: first,
      clock: () => now,
    });
    const initial = loader({ authority });
    expect(initial.kind).toBe("snapshot");

    // Reconnect with the last-known sequence: the snapshot is identical and
    // no duplicate or stale evidence is produced.
    if (initial.kind === "snapshot") {
      const reconnect = loader({ authority, afterSequence: initial.snapshot.sequence });
      expect(reconnect.kind).toBe("snapshot");
      if (reconnect.kind === "snapshot") {
        expect(reconnect.snapshot.timeline).toHaveLength(initial.snapshot.timeline.length);
        expect(reconnect.snapshot.sequence).toBe(initial.snapshot.sequence);
      }
    }
    first.close();
  });
});
