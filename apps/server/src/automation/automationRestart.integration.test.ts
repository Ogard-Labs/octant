import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationCommand, AutomationId } from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import {
  catchUpProjection,
  ProjectionQuarantined,
  rebuildProjection,
} from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { AutomationCommandService } from "./automationCommandService";
import {
  AUTOMATION_RUN_AGGREGATE_TYPE,
  AUTOMATION_RUN_CREATED,
  AutomationEventStore,
} from "./automationEventStore";
import { hydrateAutomationProjection } from "./automationProjection";
import {
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
  automationDefinitionDraftFixture,
  automationLocalWindowPrincipal,
  automationRunFixture,
} from "./automationTestFixtures";

const directories: Array<string> = [];
const now = AUTOMATION_TEST_NOW;
const automationId = "ca000000-0000-4000-8000-000000000001" as AutomationId;
const principal = automationLocalWindowPrincipal();

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

let uuidCounter = 7_000;
function nextUuid(): string {
  uuidCounter += 1;
  return `ce000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Session {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly store: AutomationEventStore;
  readonly projection: ReturnType<typeof createPhase1RuntimeRegistries>["automationProjection"];
}

function openSession(path: string): Session {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  return { connection, journal, store, projection: runtime.automationProjection };
}

function storePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return join(directory, "octant.sqlite3");
}

describe("automation persistence restart", () => {
  it("restores definitions, runs, and cancellation receipts across a crash", () => {
    const path = storePath("octant-automation-restart-");
    const first = openSession(path);
    const service = new AutomationCommandService({
      store: first.store,
      projection: first.projection,
      hostId: "local",
      clock: () => now,
    });

    const created = service.execute({
      kind: "create-automation",
      automationId,
      expectedVersion: 0,
      principal,
      origin: { kind: "interactive" },
      definition: automationDefinitionDraftFixture(),
    } as unknown as AutomationCommand);
    if (created.kind !== "automation-created") throw new Error("expected creation");
    const accepted = service.execute({
      kind: "run-now-automation",
      automationId,
      expectedVersion: 1,
      principal,
      origin: { kind: "interactive" },
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as unknown as AutomationCommand);
    if (accepted.kind !== "automation-run-accepted") throw new Error("expected run");
    const cancelled = service.execute({
      kind: "cancel-current-automation-run",
      automationId,
      expectedVersion: 1,
      principal,
      origin: { kind: "interactive" },
      runId: accepted.run.id,
      cancelRunRequestId: AUTOMATION_TEST_IDS.cancelRequest,
      expectedRunVersion: 1,
    } as unknown as AutomationCommand);
    if (cancelled.kind !== "automation-run-cancelled") throw new Error("expected cancellation");

    const beforeSummaries = first.projection.listSummaries({
      hostId: created.automation.hostId,
      mode: "all",
      limit: 10,
    });
    const beforeRun = first.projection.getRun(accepted.run.id);
    // Crash: the process ends without any shutdown hook.
    first.connection.close();

    const second = openSession(path);
    // Startup order mirrors persistenceService: checkpointed catch-up first,
    // then in-memory hydration from the authoritative journal.
    for (const projection of [second.projection]) {
      catchUpProjection({
        connection: second.connection,
        journal: second.journal,
        projection,
        clock: () => now,
      });
    }
    expect(
      hydrateAutomationProjection({ store: second.store, projection: second.projection }),
    ).toBe("ok");

    expect(
      second.projection.listSummaries({
        hostId: created.automation.hostId,
        mode: "all",
        limit: 10,
      }),
    ).toEqual(beforeSummaries);
    const restoredRun = second.projection.getRun(accepted.run.id);
    expect(restoredRun).toEqual(beforeRun);
    expect(restoredRun?.lifecycle).toBe("cancelled");
    expect(restoredRun?.cancellationTombstone?.requestId).toBe(AUTOMATION_TEST_IDS.cancelRequest);

    // Retrying the cancel after restart returns the original receipt.
    const restartedService = new AutomationCommandService({
      store: second.store,
      projection: second.projection,
      hostId: "local",
      clock: () => now,
    });
    const retried = restartedService.execute({
      kind: "cancel-current-automation-run",
      automationId,
      expectedVersion: 1,
      principal,
      origin: { kind: "interactive" },
      runId: accepted.run.id,
      cancelRunRequestId: AUTOMATION_TEST_IDS.cancelRequest,
      expectedRunVersion: 1,
    } as unknown as AutomationCommand);
    expect(retried.kind).toBe("automation-run-cancelled");
    second.connection.close();
  });

  it("fails closed instead of hydrating from a misattributed hostile frame", () => {
    const path = storePath("octant-automation-hostile-");
    const session = openSession(path);
    // A hostile writer journals a run frame whose payload identity does not
    // match the aggregate it claims.
    session.journal.append({
      aggregate: {
        aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
        aggregateId: AUTOMATION_TEST_IDS.otherAutomation,
      },
      expectedVersion: 0,
      events: [
        {
          eventId: nextUuid() as never,
          eventName: AUTOMATION_RUN_CREATED,
          eventVersion: 1,
          correlationId: nextUuid() as never,
          actor,
          occurredAt: now as never,
          payload: { run: automationRunFixture() },
        },
      ],
    });

    const replay = session.store.replayAll();
    expect(replay).toEqual({ status: "snapshot-required", reason: "identity-mismatch" });
    const fresh = openSession(path);
    expect(hydrateAutomationProjection({ store: fresh.store, projection: fresh.projection })).toBe(
      "snapshot-required",
    );
    // Fail closed: nothing from the hostile stream is queryable.
    expect(fresh.projection.getRun(automationRunFixture().id)).toBeUndefined();
    session.connection.close();
    fresh.connection.close();
  });

  it("quarantines a corrupted automation payload during rebuild instead of applying it", () => {
    const path = storePath("octant-automation-corrupt-");
    const session = openSession(path);
    const service = new AutomationCommandService({
      store: session.store,
      projection: session.projection,
      hostId: "local",
      clock: () => now,
    });
    const created = service.execute({
      kind: "create-automation",
      automationId,
      expectedVersion: 0,
      principal,
      origin: { kind: "interactive" },
      definition: automationDefinitionDraftFixture(),
    } as unknown as AutomationCommand);
    expect(created.kind).toBe("automation-created");
    // Corruption after commit: the journaled payload bytes no longer decode.
    session.connection
      .prepare("UPDATE event_journal SET payload_json = ? WHERE event_name = ?")
      .run(
        JSON.stringify({ automation: { id: "not-a-definition" } }),
        "automation-definition-created@1",
      );
    session.connection.close();

    const reopened = openSession(path);
    expect(
      hydrateAutomationProjection({ store: reopened.store, projection: reopened.projection }),
    ).toBe("snapshot-required");
    expect(reopened.projection.getDefinition(automationId)).toBeUndefined();
    expect(() =>
      rebuildProjection({
        connection: reopened.connection,
        journal: reopened.journal,
        projection: reopened.projection,
        clock: () => now,
      }),
    ).toThrow(ProjectionQuarantined);
    const quarantined = reopened.connection
      .prepare("SELECT projection_name, reason FROM event_quarantine WHERE projection_name = ?")
      .all("automations") as Array<{ projection_name: string; reason: string }>;
    expect(quarantined).toHaveLength(1);
    reopened.connection.close();
  });
});
