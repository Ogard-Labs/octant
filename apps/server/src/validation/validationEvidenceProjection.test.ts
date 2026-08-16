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
  readValidationEvidenceSequence,
  readValidationEvidenceSnapshot,
  ValidationEvidenceProjection,
} from "./validationEvidenceProjection";
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
  const directory = mkdtempSync(join(tmpdir(), "octant-validation-projection-"));
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
  plan: "00000000-0000-4000-8000-000000000001" as never,
  supersedingPlan: "00000000-0000-4000-8000-000000000002" as never,
  evidence: "00000000-0000-4000-8000-000000000010" as never,
  evidence2: "00000000-0000-4000-8000-000000000011" as never,
  causation: "00000000-0000-4000-8000-000000000012" as never,
  actor: "77777777-7777-4777-8777-777777777777" as never,
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: ids.actor,
});

function makePlan(
  auth: ToolActionAuthority = authority,
  planId: string = ids.plan,
): ValidationPlan {
  return Schema.decodeUnknownSync(ValidationPlanCreated)({
    plan: {
      planId,
      authority: auth,
      steps: [
        { stepId: "s1", description: "Run unit tests", sources: [] },
        { stepId: "s2", description: "Lint check", sources: [] },
      ],
      createdAt: now,
    },
  }).plan;
}

function makeEvidence(
  overrides: Partial<ValidationEvidenceRecord> & { planId?: string } = {},
): ValidationEvidenceRecord {
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
      ...overrides,
    },
  }).evidence;
}

function makeReport(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return Schema.decodeUnknownSync(ValidationReportCompleted)({
    report: {
      planId: ids.plan,
      authority,
      evidence: [],
      overallOutcome: "passed",
      completedAt: now,
      stepResults: [
        { stepId: "s1", outcome: "passed", evidenceCount: 1 },
        { stepId: "s2", outcome: "skipped", evidenceCount: 0 },
      ],
      ...overrides,
    },
  }).report;
}

function createStore(): {
  store: ValidationEventStore;
  connection: SqliteConnection;
} {
  const connection = openConnection();
  const registry = new EventRegistry()
    .register("validation.plan-created@1", 1, ValidationPlanCreated)
    .register("validation.evidence-recorded@1", 1, ValidationEvidenceRecorded)
    .register("validation.report-completed@1", 1, ValidationReportCompleted);
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(new ValidationEvidenceProjection());
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  };
  const store = new ValidationEventStore({ journal, uuid, actor });
  return { store, connection };
}

describe("ValidationEvidenceProjection", () => {
  it("returns undefined when no evidence exists for the authority", () => {
    const { connection } = createStore();
    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot).toBeUndefined();
  });

  it("projects a plan with unavailable outcome and no evidence", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot).toBeDefined();
    expect(snapshot!.overallOutcome).toBe("unavailable");
    expect(snapshot!.timeline).toHaveLength(0);
    expect(snapshot!.steps).toHaveLength(2);
    expect(snapshot!.steps[0]!.outcome).toBe("unavailable");
    expect(snapshot!.plan).toBeDefined();
  });

  it("projects evidence records into the timeline and step summaries", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({
      evidence: makeEvidence({ evidenceId: ids.evidence, outcome: "passed" }),
      expectedVersion: 1,
    });
    store.appendEvidence({
      evidence: makeEvidence({
        evidenceId: ids.evidence2,
        stepId: "s2",
        outcome: "failed",
        source: { kind: "repository-test", reference: "lint-check" },
      }),
      expectedVersion: 2,
    });
    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot).toBeDefined();
    expect(snapshot!.timeline).toHaveLength(2);
    expect(snapshot!.overallOutcome).toBe("failed");
    expect(snapshot!.steps[0]!.outcome).toBe("passed");
    expect(snapshot!.steps[0]!.evidenceCount).toBe(1);
    expect(snapshot!.steps[1]!.outcome).toBe("failed");
    expect(snapshot!.steps[1]!.evidenceCount).toBe(1);
  });

  it("preserves journal ordering, correlation, and causation in timeline entries", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    const envelope = store.appendEvidence({
      evidence: makeEvidence({
        source: {
          kind: "browser-observation",
          reference: "browser-observation-a",
          correlationId: ids.causation,
        },
      }),
      expectedVersion: 1,
    });

    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot?.timeline[0]).toMatchObject({
      sequence: envelope.globalSequence,
      correlationId: envelope.correlationId,
      causationId: ids.causation,
    });
  });

  it("projects a completed report and uses its overall outcome", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    store.appendReport({ report: makeReport(), expectedVersion: 2 });
    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot).toBeDefined();
    expect(snapshot!.report).toBeDefined();
    expect(snapshot!.overallOutcome).toBe("passed");
  });

  it("does not let a delayed passed report overwrite interrupted evidence", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({
      evidence: makeEvidence({ outcome: "interrupted" }),
      expectedVersion: 1,
    });
    store.appendReport({ report: makeReport(), expectedVersion: 2 });

    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot?.overallOutcome).toBe("interrupted");
    expect(snapshot?.report).toBeUndefined();
  });

  it("does not let an inconclusive report mask failed evidence", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({
      evidence: makeEvidence({ outcome: "failed" }),
      expectedVersion: 1,
    });
    store.appendReport({
      report: makeReport({ overallOutcome: "inconclusive" }),
      expectedVersion: 2,
    });

    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot?.overallOutcome).toBe("failed");
    expect(snapshot?.report).toBeUndefined();
  });

  it("lets late interrupted evidence invalidate an earlier passed report", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    store.appendReport({ report: makeReport(), expectedVersion: 2 });
    store.appendEvidence({
      evidence: makeEvidence({
        evidenceId: ids.evidence2,
        outcome: "interrupted",
      }),
      expectedVersion: 3,
    });

    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot?.overallOutcome).toBe("interrupted");
    expect(snapshot?.report).toBeUndefined();
  });

  it("keeps a newer plan authoritative after delayed completion of an interrupted plan", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({
      evidence: makeEvidence({ outcome: "interrupted" }),
      expectedVersion: 1,
    });
    store.appendPlan({
      plan: makePlan(authority, ids.supersedingPlan),
      expectedVersion: 0,
    });
    store.appendEvidence({
      evidence: makeEvidence({
        evidenceId: ids.evidence2,
        planId: ids.supersedingPlan,
        outcome: "passed",
      }),
      expectedVersion: 1,
    });

    store.appendReport({
      report: makeReport({ planId: ids.plan, overallOutcome: "passed" }),
      expectedVersion: 2,
    });

    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot?.plan?.planId).toBe(ids.supersedingPlan);
    expect(snapshot?.overallOutcome).toBe("passed");
  });

  it("scopes evidence by authority and does not leak across authorities", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(authority), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    const mismatched = readValidationEvidenceSnapshot(connection, mismatchedAuthority, now);
    expect(mismatched).toBeUndefined();
  });

  it("strips detail from redacted evidence records", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({
      evidence: makeEvidence({ redacted: true, detail: "secret-raw-content" }),
      expectedVersion: 1,
    });
    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot).toBeDefined();
    expect(snapshot!.timeline[0]!.redacted).toBe(true);
    expect(snapshot!.timeline[0]!.detail).toBeUndefined();
  });

  it("never includes raw filesystem paths in source references", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({
      evidence: makeEvidence({
        source: { kind: "repository-test", reference: "opaque-token-abc" },
      }),
      expectedVersion: 1,
    });
    const snapshot = readValidationEvidenceSnapshot(connection, authority, now);
    expect(snapshot).toBeDefined();
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("/");
    expect(json).not.toContain("\\");
  });

  it("returns the latest sequence for an authority scope", () => {
    const { store, connection } = createStore();
    store.appendPlan({ plan: makePlan(), expectedVersion: 0 });
    store.appendEvidence({ evidence: makeEvidence(), expectedVersion: 1 });
    const sequence = readValidationEvidenceSequence(connection, authority);
    expect(sequence).toBeGreaterThan(0);
  });
});
