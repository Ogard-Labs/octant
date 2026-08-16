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

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-validation-loader-"));
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

const mismatchedAuthority: ToolActionAuthority = {
  hostId: "00000000-0000-0000-0000-000000000014" as never,
  mode: "code",
  projectId: "00000000-0000-0000-0000-000000000015" as never,
  providerInstanceId: "00000000-0000-0000-0000-000000000016" as never,
  extension: { kind: "core" },
};

const ids = {
  plan: "00000000-0000-4000-8000-000000000001",
  supersededPlan: "00000000-0000-4000-8000-000000000002",
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

function setup(): {
  load: ReturnType<typeof createValidationEvidenceLoader>;
  store: ValidationEventStore;
  connection: SqliteConnection;
  journal: Journal;
} {
  const connection = openConnection();
  const registry = new EventRegistry()
    .register("validation.plan-created@1", 1, ValidationPlanCreated)
    .register("validation.evidence-recorded@1", 1, ValidationEvidenceRecorded)
    .register("validation.report-completed@1", 1, ValidationReportCompleted);
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(new ValidationEvidenceProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  };
  const store = new ValidationEventStore({ journal, uuid, actor });
  const load = createValidationEvidenceLoader({
    connection,
    clock: () => now,
  });
  return { load, store, connection, journal };
}

describe("createValidationEvidenceLoader", () => {
  it("returns missing when no evidence exists for the authority", () => {
    const { load } = setup();
    const result = load({ authority });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.category).toBe("missing");
    }
  });

  it("returns missing without leaking that a mismatched authority has evidence", () => {
    const { load, store } = setup();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    const result = load({ authority: mismatchedAuthority });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.category).toBe("missing");
    }
  });

  it("returns a snapshot for an authorized authority", () => {
    const { load, store } = setup();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    store.appendReport({ report: makeReport(), expectedVersion: 2 });
    const result = load({ authority });
    expect(result.kind).toBe("snapshot");
    if (result.kind === "snapshot") {
      expect(result.snapshot.overallOutcome).toBe("passed");
      expect(result.snapshot.timeline).toHaveLength(1);
    }
  });

  it("returns stale when afterSequence is ahead of the scoped projection", () => {
    const { load, store } = setup();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    const result = load({ authority, afterSequence: 9999 as never });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.category).toBe("stale");
    }
  });

  it("returns superseded when reconnect targets an older plan", () => {
    const { load, store } = setup();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    const current = load({ authority });
    expect(current.kind).toBe("snapshot");
    if (current.kind === "snapshot") {
      const result = load({
        authority,
        planId: ids.supersededPlan,
        afterSequence: current.snapshot.sequence,
      } as never);
      expect(result.kind).toBe("failure");
      if (result.kind === "failure") expect(result.failure.category).toBe("superseded");
    }
  });

  it("returns a snapshot when afterSequence is within the journal head", () => {
    const { load, store, journal } = setup();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    const head = journal.headSequence();
    const result = load({ authority, afterSequence: head as never });
    expect(result.kind).toBe("snapshot");
  });

  it("never includes raw content in the snapshot JSON", () => {
    const { load, store } = setup();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({
      evidence: makeEvidence(),
      expectedVersion: 1,
    });
    const result = load({ authority });
    if (result.kind === "snapshot") {
      const json = JSON.stringify(result.snapshot);
      expect(json).not.toContain("/Users/");
      expect(json).not.toContain("\\");
      expect(json).not.toContain("password");
    }
  });
});
