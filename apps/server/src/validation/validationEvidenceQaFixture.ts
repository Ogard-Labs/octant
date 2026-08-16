import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  ValidationEvidenceRecorded,
  ValidationPlanCreated,
  ValidationReportCompleted,
  type ToolActionAuthority,
  type ValidationEvidenceRecord,
  type ValidationPlan,
} from "@octant/contracts";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { createValidationEvidenceRouteHandler } from "../validationEvidenceRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { ValidationEventStore } from "./validationEventStore";
import { createValidationEvidenceLoader } from "./validationEvidenceLoader";
import { ValidationEvidenceProjection } from "./validationEvidenceProjection";

const PORT = 4176;
const CAPABILITY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WINDOW_ID = "00000000-0000-4000-8000-000000000010" as never;
const NOW = "2026-07-27T12:00:00.000Z";
const authority = {
  hostId: "00000000-0000-4000-8000-000000000001",
  mode: "code",
  projectId: "00000000-0000-4000-8000-000000000002",
  providerInstanceId: "00000000-0000-4000-8000-000000000003",
  extension: { kind: "core" },
} as ToolActionAuthority;
const ids = {
  firstPlan: "00000000-0000-4000-8000-000000000020",
  secondPlan: "00000000-0000-4000-8000-000000000021",
  actor: "00000000-0000-4000-8000-000000000022",
  action: "00000000-0000-4000-8000-000000000023",
  causation: "00000000-0000-4000-8000-000000000024",
} as const;

const directory = mkdtempSync(join(tmpdir(), "octant-validation-qa-"));
const connection = openSqlite(join(directory, "validation.sqlite3"));
applyMigrations(connection, MIGRATIONS, () => NOW);
const events = new EventRegistry()
  .register("validation.plan-created@1", 1, ValidationPlanCreated)
  .register("validation.evidence-recorded@1", 1, ValidationEvidenceRecorded)
  .register("validation.report-completed@1", 1, ValidationReportCompleted);
const projections = new ProjectionRegistry()
  .register(new AggregateHeadsProjection())
  .register(new ValidationEvidenceProjection());
const journal = new Journal({ connection, registry: events, projections, clock: () => NOW });
const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const store = new ValidationEventStore({ journal, uuid: randomUUID, actor });
const windowAuthorityStore = new WindowAuthorityStore();
windowAuthorityStore.register({ windowId: WINDOW_ID, capability: CAPABILITY, now: 0 });

function plan(planId: string, createdAt = NOW): ValidationPlan {
  return Schema.decodeUnknownSync(ValidationPlanCreated)({
    plan: {
      planId,
      authority,
      createdAt,
      steps: [
        { stepId: "tests", description: "Repository tests", sources: [] },
        { stepId: "artifact", description: "Artifact validation", sources: [] },
        { stepId: "browser", description: "Browser observation", sources: [] },
        { stepId: "computer", description: "Computer-use observation", sources: [] },
        { stepId: "apple", description: "Apple validation", sources: [] },
      ],
    },
  }).plan;
}

function evidence(input: {
  readonly evidenceId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly kind:
    | "repository-test"
    | "artifact-validation"
    | "browser-observation"
    | "computer-use-observation"
    | "apple-test";
  readonly outcome: "passed" | "failed" | "inconclusive" | "interrupted" | "unavailable";
  readonly reference: string;
  readonly redacted?: boolean;
}): ValidationEvidenceRecord {
  return Schema.decodeUnknownSync(ValidationEvidenceRecorded)({
    evidence: {
      evidenceId: input.evidenceId,
      planId: input.planId,
      stepId: input.stepId,
      source: {
        kind: input.kind,
        reference: input.reference,
        actionId: ids.action,
        correlationId: ids.causation,
      },
      outcome: input.outcome,
      authority,
      observedAt: NOW,
      detail: input.redacted ? "content that must not cross the route" : `${input.stepId} detail`,
      redacted: input.redacted ?? false,
    },
  }).evidence;
}

store.appendPlan({ plan: plan(ids.firstPlan), expectedVersion: 0 });
const fixtures = [
  ["00000000-0000-4000-8000-000000000030", "tests", "repository-test", "passed", "tests-a"],
  [
    "00000000-0000-4000-8000-000000000031",
    "artifact",
    "artifact-validation",
    "failed",
    "artifact-a",
  ],
  [
    "00000000-0000-4000-8000-000000000032",
    "browser",
    "browser-observation",
    "inconclusive",
    "browser-a",
  ],
  [
    "00000000-0000-4000-8000-000000000033",
    "computer",
    "computer-use-observation",
    "interrupted",
    "computer-a",
  ],
  ["00000000-0000-4000-8000-000000000034", "apple", "apple-test", "unavailable", "apple-a"],
] as const;
fixtures.forEach(([evidenceId, stepId, kind, outcome, reference], index) => {
  store.appendEvidence({
    evidence: evidence({
      evidenceId,
      planId: ids.firstPlan,
      stepId,
      kind,
      outcome,
      reference,
      redacted: stepId === "browser",
    }),
    expectedVersion: index + 1,
  });
});

const route = createValidationEvidenceRouteHandler({
  windowAuthorityStore,
  now: () => 1,
  authorize: (_windowId, requested) =>
    requested.hostId === authority.hostId &&
    requested.mode === authority.mode &&
    requested.projectId === authority.projectId,
  loadSnapshot: createValidationEvidenceLoader({ connection, clock: () => NOW }),
});

let superseded = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/control/supersede" && request.method === "POST") {
      if (!superseded) {
        store.appendPlan({
          plan: plan(ids.secondPlan, "2026-07-27T12:01:00.000Z"),
          expectedVersion: 0,
        });
        store.appendEvidence({
          evidence: evidence({
            evidenceId: "00000000-0000-4000-8000-000000000035",
            planId: ids.secondPlan,
            stepId: "tests",
            kind: "repository-test",
            outcome: "passed",
            reference: "tests-b",
          }),
          expectedVersion: 1,
        });
        superseded = true;
      }
      return Response.json({ superseded: true });
    }
    return (await route(request)) ?? new Response("Not Found", { status: 404 });
  },
});

const cleanup = () => {
  server.stop(true);
  connection.close();
  rmSync(directory, { recursive: true, force: true });
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
console.log(`Validation QA fixture ready on http://127.0.0.1:${PORT}`);
