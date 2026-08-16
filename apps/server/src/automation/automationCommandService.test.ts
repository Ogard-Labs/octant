import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeAutomationCommandResult,
  type AutomationCommand,
  type AutomationDefinition,
  type AutomationId,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { AutomationCommandService } from "./automationCommandService";
import { AutomationEventStore, registerAutomationEvents } from "./automationEventStore";
import { AutomationProjection } from "./automationProjection";
import {
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
  automationDefinitionDraftFixture,
  automationLocalWindowPrincipal,
  automationRemoteDevicePrincipal,
} from "./automationTestFixtures";

const directories: Array<string> = [];
const now = AUTOMATION_TEST_NOW;

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

let uuidCounter = 5_000;
function nextUuid(): string {
  uuidCounter += 1;
  return `cd000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-automation-commands-"));
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

interface Harness {
  readonly projection: AutomationProjection;
  readonly service: AutomationCommandService;
}

function createHarness(): Harness {
  const connection = openConnection();
  const registry = registerAutomationEvents(new EventRegistry());
  const projection = new AutomationProjection();
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(projection),
    clock: () => now,
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  const service = new AutomationCommandService({
    store,
    projection,
    hostId: "local",
    clock: () => now,
  });
  return { projection, service };
}

const principal = automationLocalWindowPrincipal();
const interactive = { kind: "interactive" } as const;

function automationId(suffix: string): AutomationId {
  return `ba000000-0000-4000-8000-00000000${suffix}` as AutomationId;
}

function createCommand(id: AutomationId, overrides: Record<string, unknown> = {}) {
  return {
    kind: "create-automation",
    automationId: id,
    expectedVersion: 0,
    principal,
    origin: interactive,
    definition: automationDefinitionDraftFixture(),
    ...overrides,
  } as unknown as AutomationCommand;
}

function created(harness: Harness, id: AutomationId): AutomationDefinition {
  const result = harness.service.execute(createCommand(id));
  expect(result.kind).toBe("automation-created");
  if (result.kind !== "automation-created") throw new Error("expected creation");
  return result.automation;
}

describe("automation command service", () => {
  it("creates a definition with due state, strict receipts, and journal replayability", () => {
    const { service, projection } = createHarness();
    const result = service.execute(createCommand(automationId("3001")));
    expect(() => decodeAutomationCommandResult(result)).not.toThrow();
    expect(result.kind).toBe("automation-created");
    if (result.kind !== "automation-created") return;
    expect(result.automation).toMatchObject({
      id: automationId("3001"),
      lifecycle: "enabled",
      definitionRevision: 1,
      version: 1,
      createdBy: principal,
      updatedBy: principal,
    });
    // Once triggers keep their exact configured instant as the due state.
    const trigger = result.automation.trigger;
    if (trigger.kind !== "once") throw new Error("expected a once trigger");
    expect(result.automation.nextDueAt).toBe(trigger.scheduledAt);
    expect(projection.getDefinition(automationId("3001"))).toEqual(result.automation);

    // A duplicate create for the same id is a typed stale-version conflict.
    const duplicate = service.execute(createCommand(automationId("3001")));
    expect(duplicate).toMatchObject({
      kind: "automation-command-failed",
      reason: "stale-version",
    });
  });

  it("creates weekly-local definitions with durable resolution evidence", () => {
    const { service } = createHarness();
    const result = service.execute(
      createCommand(automationId("3011"), {
        definition: automationDefinitionDraftFixture({
          trigger: {
            kind: "weekly-local",
            weekdays: [1, 3],
            localTime: "09:30",
            timeZone: "Europe/Copenhagen",
          } as never,
        }),
      }),
    );
    expect(result.kind).toBe("automation-created");
    if (result.kind !== "automation-created") return;
    expect(result.automation.nextDueAt).not.toBeNull();
    expect(result.automation.nextDueResolution).toMatchObject({
      timeZone: "Europe/Copenhagen",
      resolvedLocalTime: "09:30",
    });
  });

  it("rejects automation-origin mutation before any side effect", () => {
    const { service, projection } = createHarness();
    const origin = {
      kind: "automation-run",
      automationId: AUTOMATION_TEST_IDS.otherAutomation,
      runId: AUTOMATION_TEST_IDS.run,
      occurrenceKey: "manual:recursion",
    } as const;
    const result = service.execute(createCommand(automationId("3021"), { origin }));
    expect(result).toMatchObject({
      kind: "automation-command-failed",
      reason: "unauthorized",
    });
    expect(projection.getDefinition(automationId("3021"))).toBeUndefined();
  });

  it("rejects a Full access execution profile draft as invalid", () => {
    const { service } = createHarness();
    const draft = automationDefinitionDraftFixture();
    const result = service.execute(
      createCommand(automationId("3031"), {
        definition: {
          ...draft,
          executionProfile: { ...draft.executionProfile, executionPolicy: "full-access" },
        },
      }),
    );
    expect(result).toMatchObject({ kind: "automation-command-failed", reason: "invalid" });
  });

  it("updates with expected version, bumps revision, and rejects stale versions", () => {
    const harness = createHarness();
    const { service } = harness;
    const definition = created(harness, automationId("3041"));

    const stale = service.execute({
      kind: "update-automation",
      automationId: definition.id,
      expectedVersion: 7,
      principal,
      origin: interactive,
      definition: automationDefinitionDraftFixture({ displayName: "Renamed" as never }),
    } as unknown as AutomationCommand);
    expect(stale).toMatchObject({ kind: "automation-command-failed", reason: "stale-version" });

    const updated = service.execute({
      kind: "update-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      definition: automationDefinitionDraftFixture({ displayName: "Renamed" as never }),
    } as unknown as AutomationCommand);
    expect(updated.kind).toBe("automation-updated");
    if (updated.kind !== "automation-updated") return;
    expect(updated.automation).toMatchObject({
      displayName: "Renamed",
      definitionRevision: 2,
      version: 2,
    });

    const missing = service.execute({
      kind: "update-automation",
      automationId: automationId("3049"),
      expectedVersion: 1,
      principal,
      origin: interactive,
      definition: automationDefinitionDraftFixture(),
    } as unknown as AutomationCommand);
    expect(missing).toMatchObject({ kind: "automation-command-failed", reason: "not-found" });
  });

  it("pauses, resumes, and archives without deleting history", () => {
    const harness = createHarness();
    const { service, projection } = harness;
    const definition = created(harness, automationId("3051"));

    const paused = service.execute({
      kind: "pause-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
    } as unknown as AutomationCommand);
    expect(paused.kind).toBe("automation-paused");
    if (paused.kind !== "automation-paused") return;
    expect(paused.automation).toMatchObject({ lifecycle: "paused", nextDueAt: null, version: 2 });

    const resumed = service.execute({
      kind: "resume-automation",
      automationId: definition.id,
      expectedVersion: 2,
      principal,
      origin: interactive,
    } as unknown as AutomationCommand);
    expect(resumed.kind).toBe("automation-resumed");
    if (resumed.kind !== "automation-resumed") return;
    expect(resumed.automation).toMatchObject({
      lifecycle: "enabled",
      nextDueAt: definition.nextDueAt,
      version: 3,
    });

    const archived = service.execute({
      kind: "archive-automation",
      automationId: definition.id,
      expectedVersion: 3,
      principal,
      origin: interactive,
    } as unknown as AutomationCommand);
    expect(archived.kind).toBe("automation-archived");
    if (archived.kind !== "automation-archived") return;
    expect(archived.automation).toMatchObject({
      lifecycle: "archived",
      nextDueAt: null,
      version: 4,
    });
    // Archived definitions stay queryable and reject further edits.
    expect(projection.getDefinition(definition.id)?.lifecycle).toBe("archived");
    const editAfterArchive = service.execute({
      kind: "update-automation",
      automationId: definition.id,
      expectedVersion: 4,
      principal,
      origin: interactive,
      definition: automationDefinitionDraftFixture(),
    } as unknown as AutomationCommand);
    expect(editAfterArchive).toMatchObject({
      kind: "automation-command-failed",
      reason: "terminal",
    });
  });

  it("accepts run-now idempotently and reports active conflicts deterministically", () => {
    const harness = createHarness();
    const { service, projection } = harness;
    const definition = created(harness, automationId("3061"));

    const accepted = service.execute({
      kind: "run-now-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as unknown as AutomationCommand);
    expect(() => decodeAutomationCommandResult(accepted)).not.toThrow();
    expect(accepted.kind).toBe("automation-run-accepted");
    if (accepted.kind !== "automation-run-accepted") return;
    expect(accepted.run).toMatchObject({
      automationId: definition.id,
      lifecycle: "queued",
      version: 1,
    });
    expect(accepted.run.definitionSnapshot.taskPrompt).toBe(definition.taskPrompt);

    // The same request id returns the original receipt without a second run.
    const retried = service.execute({
      kind: "run-now-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as unknown as AutomationCommand);
    expect(retried.kind).toBe("automation-run-accepted");
    if (retried.kind !== "automation-run-accepted") return;
    expect(retried.run.id).toBe(accepted.run.id);
    expect(projection.listRuns({ automationId: definition.id, limit: 10 }).runs).toHaveLength(1);

    // A different request id while a run is active is a typed conflict.
    const conflict = service.execute({
      kind: "run-now-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runNowRequestId: AUTOMATION_TEST_IDS.cancelRequest,
    } as unknown as AutomationCommand);
    expect(conflict).toMatchObject({
      kind: "automation-run-active-conflict",
      automationId: definition.id,
      runId: accepted.run.id,
      lifecycle: "queued",
    });
  });

  it("cancels the current run atomically, idempotently, and only once", () => {
    const harness = createHarness();
    const { service } = harness;
    const definition = created(harness, automationId("3071"));
    const accepted = service.execute({
      kind: "run-now-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as unknown as AutomationCommand);
    if (accepted.kind !== "automation-run-accepted") throw new Error("expected run");

    const cancelled = service.execute({
      kind: "cancel-current-automation-run",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runId: accepted.run.id,
      cancelRunRequestId: AUTOMATION_TEST_IDS.cancelRequest,
      expectedRunVersion: 1,
    } as unknown as AutomationCommand);
    expect(cancelled.kind).toBe("automation-run-cancelled");
    if (cancelled.kind !== "automation-run-cancelled") return;
    expect(cancelled.run).toMatchObject({ lifecycle: "cancelled", version: 3 });
    expect(cancelled.run.cancellationTombstone?.requestId).toBe(AUTOMATION_TEST_IDS.cancelRequest);

    // Retrying with the same request id returns the original receipt.
    const retried = service.execute({
      kind: "cancel-current-automation-run",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runId: accepted.run.id,
      cancelRunRequestId: AUTOMATION_TEST_IDS.cancelRequest,
      expectedRunVersion: 1,
    } as unknown as AutomationCommand);
    expect(retried.kind).toBe("automation-run-cancelled");

    // A different cancel request against a terminal run is a typed result.
    const terminal = service.execute({
      kind: "cancel-current-automation-run",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runId: accepted.run.id,
      cancelRunRequestId: AUTOMATION_TEST_IDS.firstTurnRequest,
      expectedRunVersion: 3,
    } as unknown as AutomationCommand);
    expect(terminal).toMatchObject({ kind: "automation-command-failed", reason: "terminal" });

    // A stale expected run version never mutates history.
    const stale = service.execute({
      kind: "cancel-current-automation-run",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runId: accepted.run.id,
      cancelRunRequestId: AUTOMATION_TEST_IDS.firstTurnRequest,
      expectedRunVersion: 9,
    } as unknown as AutomationCommand);
    expect(stale).toMatchObject({ kind: "automation-command-failed", reason: "stale-version" });

    // After the active run is terminal, a fresh run-now request is accepted.
    const next = service.execute({
      kind: "run-now-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
      runNowRequestId: AUTOMATION_TEST_IDS.firstTurnRequest,
    } as unknown as AutomationCommand);
    expect(next.kind).toBe("automation-run-accepted");
    if (next.kind !== "automation-run-accepted") return;
    expect(next.run.id).not.toBe(accepted.run.id);
  });

  it("allows a remote-device principal only on the owning host", () => {
    const harness = createHarness();
    const { service } = harness;
    const remote = automationRemoteDevicePrincipal();
    const result = service.execute(createCommand(automationId("3081"), { principal: remote }));
    expect(result.kind).toBe("automation-created");

    const foreign = { ...remote, hostId: "other-host" };
    const rejected = service.execute(createCommand(automationId("3082"), { principal: foreign }));
    expect(rejected).toMatchObject({ kind: "automation-command-failed", reason: "unauthorized" });
  });

  it("rejects run-now against an archived definition", () => {
    const harness = createHarness();
    const { service } = harness;
    const definition = created(harness, automationId("3091"));
    service.execute({
      kind: "archive-automation",
      automationId: definition.id,
      expectedVersion: 1,
      principal,
      origin: interactive,
    } as unknown as AutomationCommand);
    const result = service.execute({
      kind: "run-now-automation",
      automationId: definition.id,
      expectedVersion: 2,
      principal,
      origin: interactive,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as unknown as AutomationCommand);
    expect(result).toMatchObject({ kind: "automation-command-failed", reason: "terminal" });
  });
});
