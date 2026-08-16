import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type AutomationRun,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { isAutomationMutationAllowed } from "@octant/domain";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { AutomationCommandService } from "./automationCommandService";
import {
  automationThreadIdForOccurrence,
  AutomationDispatchService,
} from "./automationDispatchService";
import { AutomationEventStore } from "./automationEventStore";
import { AutomationProjection } from "./automationProjection";
import { automationRunIdForOccurrence } from "./automationRunIdentity";
import { AutomationSchedulerService } from "./automationSchedulerService";
import type {
  AutomationCapacityAdmissionPort,
  AutomationCodeDispatchPort,
  AutomationWorkDispatchPort,
  AutomationDispatchWindowPort,
} from "./automationModeDispatchPorts";
import { unavailableAutomationWorkDispatchPort } from "./automationModeDispatchPorts";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionFixture,
  automationLocalWindowPrincipal,
  automationRunForDefinition,
} from "./automationTestFixtures";
import { buildAutomationAuthorityFactsFromHost } from "./automationDispatchService";

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

let uuidCounter = 71_000;
function nextUuid(): string {
  uuidCounter += 1;
  return `ab000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

interface Session {
  readonly connection: SqliteConnection;
  readonly store: AutomationEventStore;
  readonly projection: AutomationProjection;
}

function openSession(): Session {
  const directory = mkdtempSync(join(tmpdir(), "octant-automation-dispatch-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-08-10T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => "2026-08-10T12:00:00.000Z",
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  return { connection, store, projection: runtime.automationProjection };
}

const INTERVAL_ANCHOR = "2026-08-10T13:00:00.000Z";

function codeDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return automationDefinitionFixture({
    mode: "code",
    displayName: "Nightly build check",
    binding: {
      kind: "code",
      hostId: "local",
      projectId: AUTOMATION_TEST_IDS.project,
      projectVersion: 1,
      bindingRevisionId: AUTOMATION_TEST_IDS.bindingRevision,
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: "aa000000-0000-4000-8000-0000000000d1",
      worktreeReceiptId: "aa000000-0000-4000-8000-0000000000d2",
    },
    executionProfile: {
      profileId: AUTOMATION_TEST_IDS.executionProfile,
      profileVersion: 1,
      hostId: "local",
      mode: "code",
      projectId: AUTOMATION_TEST_IDS.project,
      providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
      modelId: "approved-model",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    authorityProfile: {
      profileId: AUTOMATION_TEST_IDS.authorityProfile,
      profileVersion: 1,
      requested: {
        filesystem: true,
        shell: true,
        git: true,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      },
      effective: {
        filesystem: true,
        shell: true,
        git: true,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      },
      effectiveAuthorityDigest: "automation-authority-digest",
    },
    deliveryTarget: {
      revisionId: AUTOMATION_TEST_IDS.deliveryTargetRevision,
      revision: 1,
      mode: "code",
      summary: "A green build report exists on the checkout.",
      confirmed: true,
      confirmedBy: AUTOMATION_TEST_IDS.actor,
      confirmedAt: "2026-08-10T12:00:00.000Z",
    },
    trigger: {
      kind: "interval",
      anchorAt: INTERVAL_ANCHOR,
      intervalMinutes: 60,
    },
    nextDueAt: INTERVAL_ANCHOR,
    ...overrides,
  } as never);
}

function workDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return automationDefinitionFixture({
    trigger: {
      kind: "interval",
      anchorAt: INTERVAL_ANCHOR,
      intervalMinutes: 60,
    } as never,
    nextDueAt: INTERVAL_ANCHOR as never,
    ...overrides,
  });
}

function matchingFacts(definition: AutomationDefinition) {
  return buildAutomationAuthorityFactsFromHost({
    hostId: "local",
    project: {
      id: definition.projectId,
      type: definition.mode,
      lifecycle: "active",
      version: definition.projectVersion,
      binding: { canonicalRoot: "/tmp/project" },
      bindingHistory: [
        {
          revisionId: AUTOMATION_TEST_IDS.bindingRevision,
          currentBinding: { canonicalRoot: "/tmp/project" },
        },
      ],
    } as never,
    providerInstance: {
      id: AUTOMATION_TEST_IDS.providerInstance,
      enabled: true,
    } as never,
    providerSupportsModel: true,
    executionProfileMatches: true,
    authorityDigestMatches: true,
    codeBindingMatches: true,
    workBindingMatches: true,
  });
}

function claimQueuedRun(session: Session, definition: AutomationDefinition): AutomationRun {
  session.store.appendDefinitionCreated({ automation: definition });
  const scheduler = new AutomationSchedulerService({
    store: session.store,
    projection: session.projection,
    dispatch: { offer: () => undefined },
    now: () => "2026-08-10T13:00:10.000Z" as UtcTimestamp,
  });
  const summary = scheduler.runPass();
  expect(summary.claimedRunIds).toHaveLength(1);
  const run = session.projection.getRun(summary.claimedRunIds[0] as never);
  if (run === undefined) throw new Error("expected claimed run");
  return run;
}

function createCodePort(overrides: Partial<AutomationCodeDispatchPort> = {}): {
  readonly port: AutomationCodeDispatchPort;
  readonly create: ReturnType<typeof vi.fn>;
  readonly launch: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (input: { readonly threadId: string }) => ({
    kind: "created" as const,
    threadId: input.threadId as never,
    createdAt: "2026-08-10T13:00:20.000Z" as UtcTimestamp,
  }));
  const launch = vi.fn(async () => ({
    kind: "accepted" as const,
    runtimeReceipt: "code-operation:test",
    acceptedAt: "2026-08-10T13:00:30.000Z" as UtcTimestamp,
  }));
  return {
    create,
    launch,
    port: {
      createApprovalGatedThread: create,
      startOrRecoverFirstTurn: launch,
      ...overrides,
    },
  };
}

function alwaysAdmit(): AutomationCapacityAdmissionPort {
  return {
    admit: () => ({ kind: "admitted", release: () => undefined }),
  };
}

function fixedWindow(): AutomationDispatchWindowPort {
  return {
    resolveWindowForProject: () => "aa000000-0000-4000-8000-0000000000f0" as WindowId,
  };
}

describe("AutomationDispatchService", () => {
  it("creates exactly one Code thread per occurrence and links the dispatch intent", async () => {
    const session = openSession();
    const definition = codeDefinition();
    const run = claimQueuedRun(session, definition);
    const code = createCodePort();
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: code.port,
      work: unavailableAutomationWorkDispatchPort(),
      windows: fixedWindow(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
      schedule: (work) => {
        void work();
      },
    });

    await dispatcher.dispatchNow(definition.id, run.id);
    await dispatcher.dispatchNow(definition.id, run.id);

    expect(code.create).toHaveBeenCalledTimes(1);
    expect(code.launch).toHaveBeenCalledTimes(1);
    const after = session.projection.getRun(run.id);
    expect(after?.lifecycle).toBe("running");
    expect(after?.threadId).toBe(automationThreadIdForOccurrence(String(run.occurrenceKey)));
    expect(after?.dispatchIntent?.threadId).toBe(after?.threadId);
    expect(after?.firstTurnAcceptance?.runtimeReceipt).toBe("code-operation:test");
    session.connection.close();
  });

  it("revalidates authority and blocks the definition on stale Project facts", async () => {
    const session = openSession();
    const definition = codeDefinition();
    const run = claimQueuedRun(session, definition);
    const code = createCodePort();
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: code.port,
      work: unavailableAutomationWorkDispatchPort(),
      windows: fixedWindow(),
      capacity: alwaysAdmit(),
      resolveFacts: () => ({
        ...matchingFacts(definition),
        project: undefined,
      }),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });

    await dispatcher.dispatchNow(definition.id, run.id);

    expect(code.create).not.toHaveBeenCalled();
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("failed");
    expect(session.projection.getRun(run.id)?.failure?.reason).toBe("project-mismatch");
    expect(session.projection.getDefinition(definition.id)?.lifecycle).toBe("paused");
    expect(session.projection.getDefinition(definition.id)?.blockedReason).toBe("project-mismatch");
    session.connection.close();
  });

  it("capability-gates Work when the first-turn runtime port is unavailable", async () => {
    const session = openSession();
    const definition = workDefinition();
    const run = claimQueuedRun(session, definition);
    const code = createCodePort();
    const work: AutomationWorkDispatchPort = unavailableAutomationWorkDispatchPort(
      "Work first-turn runtime is unavailable for this test.",
    );
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: code.port,
      work,
      windows: fixedWindow(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });

    await dispatcher.dispatchNow(definition.id, run.id);

    expect(code.create).not.toHaveBeenCalled();
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("failed");
    expect(session.projection.getRun(run.id)?.failure?.reason).toBe("unsupported-mode");
    expect(session.projection.getDefinition(definition.id)?.blockedReason).toBe("unsupported-mode");
    session.connection.close();
  });

  it("dispatches a Work run end-to-end through an available work port", async () => {
    const session = openSession();
    const definition = workDefinition();
    const run = claimQueuedRun(session, definition);
    const create = vi.fn(async (input: { readonly threadId: string }) => ({
      kind: "created" as const,
      threadId: input.threadId as never,
      createdAt: "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    }));
    const launch = vi.fn(async () => ({
      kind: "accepted" as const,
      runtimeReceipt: "work-turn:test",
      acceptedAt: "2026-08-10T13:00:30.000Z" as UtcTimestamp,
    }));
    const work: AutomationWorkDispatchPort = {
      available: true,
      unavailableReason: undefined,
      createThread: create,
      startOrRecoverFirstTurn: launch,
    };
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: createCodePort().port,
      work,
      windows: fixedWindow(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
      schedule: (work) => {
        void work();
      },
    });

    await dispatcher.dispatchNow(definition.id, run.id);

    expect(create).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    const after = session.projection.getRun(run.id);
    expect(after?.lifecycle).toBe("running");
    expect(after?.threadId).toBe(automationThreadIdForOccurrence(String(run.occurrenceKey)));
    expect(after?.firstTurnAcceptance?.runtimeReceipt).toBe("work-turn:test");
    session.connection.close();
  });

  it("waits on provider capacity without accepting a first turn", async () => {
    const session = openSession();
    const definition = codeDefinition();
    const run = claimQueuedRun(session, definition);
    const code = createCodePort();
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: code.port,
      work: unavailableAutomationWorkDispatchPort(),
      windows: fixedWindow(),
      capacity: {
        admit: () => ({ kind: "waiting", message: "Provider capacity exhausted." }),
      },
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });

    await dispatcher.dispatchNow(definition.id, run.id);

    expect(code.create).toHaveBeenCalledTimes(1);
    expect(code.launch).not.toHaveBeenCalled();
    const after = session.projection.getRun(run.id);
    expect(after?.lifecycle).toBe("dispatching");
    expect(after?.dispatchIntent).toBeDefined();
    expect(after?.firstTurnAcceptance).toBeUndefined();
    session.connection.close();
  });

  it("is idempotent across restart for the same occurrence thread receipt", async () => {
    const session = openSession();
    const definition = codeDefinition();
    const run = claimQueuedRun(session, definition);
    const code = createCodePort();
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: code.port,
      work: unavailableAutomationWorkDispatchPort(),
      windows: fixedWindow(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });
    await dispatcher.dispatchNow(definition.id, run.id);

    const rebuilt = new AutomationProjection();
    const hydrate = await import("./automationProjection").then((module) =>
      module.hydrateAutomationProjection({ store: session.store, projection: rebuilt }),
    );
    expect(hydrate).toBe("ok");
    code.create.mockClear();
    code.launch.mockClear();
    const restarted = new AutomationDispatchService({
      store: session.store,
      projection: rebuilt,
      code: code.port,
      work: unavailableAutomationWorkDispatchPort(),
      windows: fixedWindow(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:05:00.000Z" as UtcTimestamp,
    });
    await restarted.dispatchNow(definition.id, run.id);
    expect(code.create).not.toHaveBeenCalled();
    expect(code.launch).not.toHaveBeenCalled();
    expect(rebuilt.getRun(run.id)?.lifecycle).toBe("running");
    session.connection.close();
  });

  it("does not launch after a cancellation tombstone", async () => {
    const session = openSession();
    const definition = codeDefinition();
    const run = claimQueuedRun(session, definition);
    const currentDefinition = session.projection.getDefinition(definition.id);
    if (currentDefinition === undefined) throw new Error("expected definition");
    const commands = new AutomationCommandService({
      store: session.store,
      projection: session.projection,
      hostId: "local",
      clock: () => "2026-08-10T13:00:15.000Z",
    });
    // Move to dispatching with a thread receipt, then cancel before acceptance.
    session.store.appendRunStatusChanged({
      automationId: definition.id,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: "2026-08-10T13:00:12.000Z" as never,
    });
    const threadId = automationThreadIdForOccurrence(String(run.occurrenceKey));
    session.store.appendDispatchIntentRecorded({
      automationId: definition.id,
      runId: run.id,
      intent: {
        firstTurnRequestId: run.firstTurnRequestId,
        threadId,
        authoritySnapshot: run.authoritySnapshot,
        promptDigest: "a".repeat(64) as never,
        recordedAt: "2026-08-10T13:00:13.000Z" as never,
      },
      expectedVersion: 2,
    });
    const cancelled = commands.execute({
      kind: "cancel-current-automation-run",
      automationId: definition.id,
      expectedVersion: currentDefinition.version,
      principal: automationLocalWindowPrincipal(),
      origin: { kind: "interactive" },
      runId: run.id,
      expectedRunVersion: 3,
      cancelRunRequestId: AUTOMATION_TEST_IDS.cancelRequest,
    } as never);
    expect(cancelled.kind).toBe("automation-run-cancelled");

    const code = createCodePort();
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: code.port,
      work: unavailableAutomationWorkDispatchPort(),
      windows: fixedWindow(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });
    await dispatcher.dispatchNow(definition.id, run.id);
    expect(code.launch).not.toHaveBeenCalled();
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("cancelled");
    session.connection.close();
  });

  it("rejects automation-origin mutations of automations", () => {
    expect(
      isAutomationMutationAllowed({
        kind: "automation-run",
        automationId: AUTOMATION_TEST_IDS.automation as never,
        runId: AUTOMATION_TEST_IDS.run as never,
        occurrenceKey: "occurrence" as never,
      }),
    ).toBe(false);
    const session = openSession();
    const definition = codeDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const commands = new AutomationCommandService({
      store: session.store,
      projection: session.projection,
      hostId: "local",
      clock: () => "2026-08-10T13:00:00.000Z",
    });
    const result = commands.execute({
      kind: "pause-automation",
      automationId: definition.id,
      expectedVersion: definition.version,
      principal: automationLocalWindowPrincipal(),
      origin: {
        kind: "automation-run",
        automationId: definition.id,
        runId: AUTOMATION_TEST_IDS.run,
        occurrenceKey: "occurrence",
      },
    } as never);
    expect(result).toMatchObject({
      kind: "automation-command-failed",
      reason: "unauthorized",
    });
    session.connection.close();
  });

  it("re-offers post-intent launch recovery after an expired claim lease", async () => {
    const session = openSession();
    const definition = codeDefinition();
    const run = claimQueuedRun(session, definition);
    const offers: Array<{ readonly run: AutomationRun }> = [];
    const scheduler = new AutomationSchedulerService({
      store: session.store,
      projection: session.projection,
      dispatch: { offer: (offer) => offers.push(offer) },
      now: () => "2026-08-10T13:00:10.000Z" as UtcTimestamp,
      config: { leaseDurationMs: 60_000 },
    });
    session.store.appendRunStatusChanged({
      automationId: definition.id,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: "2026-08-10T13:00:12.000Z" as never,
    });
    const threadId = automationThreadIdForOccurrence(String(run.occurrenceKey));
    session.store.appendDispatchIntentRecorded({
      automationId: definition.id,
      runId: run.id,
      intent: {
        firstTurnRequestId: run.firstTurnRequestId,
        threadId,
        authoritySnapshot: run.authoritySnapshot,
        promptDigest: "b".repeat(64) as never,
        recordedAt: "2026-08-10T13:00:13.000Z" as never,
      },
      expectedVersion: 2,
    });
    session.store.appendFirstTurnRuntimeClaimed({
      automationId: definition.id,
      runId: run.id,
      claim: {
        firstTurnRequestId: run.firstTurnRequestId,
        generation: 1 as never,
        claimedAt: "2026-08-10T13:00:14.000Z" as never,
        leaseExpiresAt: "2026-08-10T13:01:14.000Z" as never,
      },
      expectedVersion: 3,
    });

    const early = new AutomationSchedulerService({
      store: session.store,
      projection: session.projection,
      dispatch: { offer: (offer) => offers.push(offer) },
      now: () => "2026-08-10T13:00:30.000Z" as UtcTimestamp,
      config: { leaseDurationMs: 60_000 },
    });
    early.runPass();
    expect(offers).toHaveLength(0);

    const late = new AutomationSchedulerService({
      store: session.store,
      projection: session.projection,
      dispatch: { offer: (offer) => offers.push(offer) },
      now: () => "2026-08-10T13:02:00.000Z" as UtcTimestamp,
      config: { leaseDurationMs: 60_000 },
    });
    late.runPass();
    expect(offers.map((offer) => offer.run.id)).toEqual([run.id]);
    void scheduler;
    void deriveAutomationOccurrenceKey;
    void automationRunIdForOccurrence;
    void automationRunForDefinition;
    session.connection.close();
  });
});
