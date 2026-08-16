import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { ValidationEventStore } from "./validationEventStore";
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

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-validation-eventstore-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
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
      source: { kind: "repository-test", reference: "bun-test-suite-a" },
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

function createStore(): { store: ValidationEventStore; connection: SqliteConnection } {
  const connection = openConnection();
  const registry = new EventRegistry()
    .register("validation.plan-created@1", 1, ValidationPlanCreated)
    .register("validation.evidence-recorded@1", 1, ValidationEvidenceRecorded)
    .register("validation.report-completed@1", 1, ValidationReportCompleted);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  };
  const store = new ValidationEventStore({ journal, uuid, actor });
  return { store, connection };
}

describe("ValidationEventStore", () => {
  it("appends a plan-created event", () => {
    const { store } = createStore();
    const envelope = store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    expect(envelope.eventName).toBe("validation.plan-created@1");
    expect(envelope.aggregateVersion).toBe(1);
  });

  it("appends an evidence-recorded event after a plan", () => {
    const { store } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    const envelope = store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    expect(envelope.eventName).toBe("validation.evidence-recorded@1");
    expect(envelope.aggregateVersion).toBe(2);
  });

  it("appends a report-completed event after evidence", () => {
    const { store } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    const envelope = store.appendReport({ report: makeReport(), expectedVersion: 2 });
    expect(envelope.eventName).toBe("validation.report-completed@1");
    expect(envelope.aggregateVersion).toBe(3);
  });

  it("rejects evidence append with stale expected version", () => {
    const { store } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    expect(() => store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 0 })).toThrow();
  });

  it("replays all validation events in global sequence order", () => {
    const { store } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    store.appendReport({ report: makeReport(), expectedVersion: 2 });
    const events = store.replayAll();
    expect(events).toHaveLength(3);
    expect(events[0]!.eventName).toBe("validation.plan-created@1");
    expect(events[1]!.eventName).toBe("validation.evidence-recorded@1");
    expect(events[2]!.eventName).toBe("validation.report-completed@1");
    expect(events[2]!.globalSequence).toBeGreaterThan(events[0]!.globalSequence);
  });
});
