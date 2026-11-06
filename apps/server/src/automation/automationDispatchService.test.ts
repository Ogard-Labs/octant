import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveAutomationOccurrenceKey,
  decodeAutomationDefinition,
  decodeCodeThread,
  CodeConversationTurn,
  ReplayCursor,
  type AutomationDefinition,
  type AutomationRun,
  type UtcTimestamp,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { isAutomationMutationAllowed, type AutomationFollowUpThreadFacts } from "@octant/domain";
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
import { AutomationProjection, hydrateAutomationProjection } from "./automationProjection";
import { automationRunIdForOccurrence, automationCodeOperationId } from "./automationRunIdentity";
import { automationCodeEvidenceFromText } from "./automationCodeDispatchPort";
import { AutomationSchedulerService } from "./automationSchedulerService";
import type {
  AutomationCapacityAdmissionPort,
  AutomationCodeDispatchPort,
  AutomationWorkDispatchPort,
} from "./automationModeDispatchPorts";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionFixture,
  automationLocalWindowPrincipal,
  automationRunForDefinition,
  unavailableAutomationWorkDispatchPort,
} from "./automationTestFixtures";
import { buildAutomationAuthorityFactsFromHost } from "./automationDispatchService";
import {
  WorkTurnProjection,
  hydrateWorkTurnProjectionFromJournal,
} from "../work/workTurnProjection";
import { createAutomationWorkDispatchPort } from "./automationWorkDispatchPort";
import { decodeWorkThreadId } from "@octant/contracts";
import {
  decodeStartWorkThreadTurnCommand,
  decodeWorkTurnAccepted,
  decodeWorkTurnUpdated,
  decodeWorkTurnState,
  type WorkTurnUpdated,
  type WorkTurnFailure,
  WORK_TURN_CAPABILITIES,
} from "@octant/contracts/work-turns";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";

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
  readonly databasePath: string;
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly store: AutomationEventStore;
  readonly projection: AutomationProjection;
}

function openSession(existingPath?: string): Session {
  const directory =
    existingPath === undefined
      ? mkdtempSync(join(tmpdir(), "octant-automation-dispatch-"))
      : dirname(existingPath);
  if (existingPath === undefined) directories.push(directory);
  const databasePath = existingPath ?? join(directory, "octant.sqlite3");
  const connection = openSqlite(databasePath);
  applyMigrations(connection, MIGRATIONS, () => "2026-08-10T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => "2026-08-10T12:00:00.000Z",
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  if (
    existingPath !== undefined &&
    hydrateAutomationProjection({ store, projection: runtime.automationProjection }) !== "ok"
  )
    throw new Error("Automation history did not rehydrate");
  return { databasePath, connection, journal, store, projection: runtime.automationProjection };
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

function chatDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  const authority = {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  } as const;
  return automationDefinitionFixture({
    mode: "chat",
    displayName: "Morning briefing",
    binding: {
      kind: "chat",
      hostId: "local",
      projectId: AUTOMATION_TEST_IDS.project,
      projectVersion: 1,
    },
    executionProfile: {
      profileId: AUTOMATION_TEST_IDS.executionProfile,
      profileVersion: 1,
      hostId: "local",
      mode: "chat",
      projectId: AUTOMATION_TEST_IDS.project,
      providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
      modelId: "approved-model",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    authorityProfile: {
      profileId: AUTOMATION_TEST_IDS.authorityProfile,
      profileVersion: 1,
      requested: authority,
      effective: authority,
      effectiveAuthorityDigest: "automation-authority-digest",
    },
    deliveryTarget: {
      revisionId: AUTOMATION_TEST_IDS.deliveryTargetRevision,
      revision: 1,
      mode: "chat",
      summary: "A short briefing is in the thread.",
      confirmed: true,
      confirmedBy: AUTOMATION_TEST_IDS.actor,
      confirmedAt: "2026-08-10T12:00:00.000Z",
    },
    trigger: { kind: "interval", anchorAt: INTERVAL_ANCHOR, intervalMinutes: 60 },
    nextDueAt: INTERVAL_ANCHOR,
    ...overrides,
  } as never);
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

async function persistedWorkRoutine(
  options: {
    readonly status?: WorkTurnUpdated["status"];
    readonly failure?: WorkTurnFailure;
    readonly receipt?: string;
  } = {},
) {
  const session = openSession();
  try {
    const definition = workDefinition();
    const run = claimQueuedRun(session, definition);
    const workTurns = new WorkTurnProjection();
    let starts = 0;
    const actualWork = createAutomationWorkDispatchPort({
      threads: {
        bootstrap: async () => ({ threads: [] }),
        execute: async (_scope, raw) => {
          if (typeof raw !== "object" || raw === null || !("threadId" in raw))
            throw new Error("Missing actual created thread identity");
          return { kind: "thread-created", thread: { id: decodeWorkThreadId(raw.threadId) } };
        },
      },
      turns: {
        startFirstTurn: async (_scope, raw) => {
          ++starts;
          const command = decodeStartWorkThreadTurnCommand(raw);
          const accepted = decodeWorkTurnAccepted({
            kind: "turn-accepted",
            requestId: command.requestId,
            threadId: command.threadId,
            turnId: command.turnId,
            projectId: definition.projectId,
            authority: command.authority,
            providerSessionId: run.firstTurnRequestId,
            prompt: command.prompt,
            capabilities: WORK_TURN_CAPABILITIES,
            acceptedAt: "2026-08-10T13:00:23.000Z",
          });
          const completed = decodeWorkTurnUpdated({
            kind: "turn-updated",
            requestId: command.requestId,
            threadId: command.threadId,
            turnId: command.turnId,
            status: options.status ?? "completed",
            ...(options.failure === undefined ? {} : { failure: options.failure }),
            response: "Controlled provider finished",
            updatedAt: "2026-08-10T13:00:23.000Z",
          });
          session.journal.append({
            aggregate: { aggregateType: "work-turn", aggregateId: command.requestId },
            expectedVersion: 0,
            events: [
              {
                eventId: nextUuid(),
                eventName: "work.turn-accepted@1",
                eventVersion: 1,
                correlationId: nextUuid(),
                actor,
                payload: accepted,
                occurredAt: accepted.acceptedAt,
              },
              {
                eventId: nextUuid(),
                eventName: "work.turn-updated@1",
                eventVersion: 1,
                correlationId: nextUuid(),
                actor,
                payload: completed,
                occurredAt: completed.updatedAt,
              },
            ],
          });
          workTurns.apply(accepted);
          workTurns.apply(completed);
          const persisted = workTurns.lookup(command.requestId);
          if (persisted === undefined) throw new Error("Missing journaled Work turn");
          return { kind: "accepted", turn: persisted };
        },
      },
      clock: () => "2026-08-10T13:00:23.000Z" as UtcTimestamp,
      uuid: nextUuid,
    });
    const work: AutomationWorkDispatchPort =
      options.receipt === undefined
        ? actualWork
        : {
            ...actualWork,
            startOrRecoverFirstTurn: async (input) => {
              const outcome = await actualWork.startOrRecoverFirstTurn(input);
              return outcome.kind === "accepted"
                ? { ...outcome, runtimeReceipt: options.receipt ?? outcome.runtimeReceipt }
                : outcome;
            },
          };
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: createCodePort().port,
      work,
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:23.000Z" as UtcTimestamp,
    });
    await dispatcher.dispatchNow(definition.id, run.id);
    return { session, definition, run, workTurns, startCount: () => starts };
  } catch (error) {
    session.connection.close();
    throw error;
  }
}

describe("AutomationDispatchService", () => {
  it("releases the routine slot after the persisted first Work turn has completed", async () => {
    const { session, definition, run, workTurns, startCount } = await persistedWorkRoutine();
    try {
      expect(session.projection.getRun(run.id)?.lifecycle).toBe("running");
      expect(workTurns.listForProject(definition.projectId)[0]?.status).toBe("completed");
      expect(session.projection.getRun(run.id)?.firstTurnAcceptance?.runtimeReceipt).toBe(
        `work-turn:${run.firstTurnRequestId}`,
      );
      const scheduler = new AutomationSchedulerService({
        store: session.store,
        projection: session.projection,
        dispatch: { offer: () => undefined },
        readWorkTurn: (requestId) => workTurns.lookup(requestId),
        now: () => "2026-08-10T14:00:10.000Z" as UtcTimestamp,
      });
      const next = scheduler.runPass();
      expect.soft(session.projection.getRun(run.id)?.lifecycle).toBe("completed");
      expect.soft(next.deferredAutomationIds).not.toContain(definition.id);
      expect.soft(next.claimedRunIds).toHaveLength(1);
      expect(startCount()).toBe(1);
    } finally {
      session.connection.close();
    }
  });
  it.each([
    "missing-reader",
    "missing-turn",
    "request",
    "thread",
    "project",
    "authority-project",
    "host",
    "binding",
    "provider",
    "model",
    "receipt",
  ] as const)("retains the active slot with %s evidence", async (variant) => {
    const fixture = await persistedWorkRoutine(
      variant === "receipt" ? { receipt: "work-turn:unrelated" } : {},
    );
    const { session, run, workTurns, startCount } = fixture;
    try {
      const other = "bb000000-0000-4000-8000-000000000010";
      const read: NonNullable<
        ConstructorParameters<typeof AutomationSchedulerService>[0]["readWorkTurn"]
      > = (requestId) => {
        const turn = workTurns.lookup(requestId);
        if (turn === undefined || variant === "missing-turn") return undefined;
        switch (variant) {
          case "request":
            return decodeWorkTurnState({ ...turn, requestId: other });
          case "thread":
            return decodeWorkTurnState({ ...turn, threadId: other });
          case "project":
            return decodeWorkTurnState({ ...turn, projectId: other });
          case "authority-project":
            return decodeWorkTurnState({
              ...turn,
              authority: { ...turn.authority, projectId: other },
            });
          case "host":
            return decodeWorkTurnState({
              ...turn,
              authority: { ...turn.authority, hostId: "other-host" },
            });
          case "binding":
            return decodeWorkTurnState({
              ...turn,
              authority: { ...turn.authority, bindingRevisionId: other },
            });
          case "provider":
            return decodeWorkTurnState({
              ...turn,
              authority: { ...turn.authority, providerInstanceId: other },
            });
          case "model":
            return decodeWorkTurnState({
              ...turn,
              authority: { ...turn.authority, modelId: "other-model" },
            });
          default:
            return turn;
        }
      };
      const scheduler = new AutomationSchedulerService({
        store: session.store,
        projection: session.projection,
        dispatch: { offer: () => undefined },
        ...(variant === "missing-reader" ? {} : { readWorkTurn: read }),
        now: () => "2026-08-10T14:00:10.000Z" as UtcTimestamp,
      });
      const result = scheduler.runPass();
      expect(result.errors).toEqual([]);
      expect(result.claimedRunIds).toEqual([]);
      expect(session.projection.getRun(run.id)?.lifecycle).toBe("running");
      expect(startCount()).toBe(1);
    } finally {
      session.connection.close();
    }
  });

  it.each(["cancelled", "failed", "waiting"] as const)(
    "records actual Work %s truth without replay",
    async (status) => {
      const { session, run, workTurns, startCount } = await persistedWorkRoutine({
        status,
      });
      try {
        const scheduler = new AutomationSchedulerService({
          store: session.store,
          projection: session.projection,
          dispatch: { offer: () => undefined },
          readWorkTurn: (id) => workTurns.lookup(id),
          now: () => "2026-08-10T14:00:10.000Z" as UtcTimestamp,
        });
        const result = scheduler.runPass();
        const after = session.projection.getRun(run.id);
        expect(result.errors).toEqual([]);
        expect(after?.lifecycle).toBe(status === "cancelled" ? "interrupted" : status);
        if (status === "failed") expect(after?.failure?.reason).toBe("runtime-failed");
        expect(result.claimedRunIds).toHaveLength(status === "waiting" ? 0 : 1);
        scheduler.runPass();
        expect(startCount()).toBe(1);
      } finally {
        session.connection.close();
      }
    },
  );

  it.each(["paused", "archived"] as const)(
    "settles an already accepted run while its definition is %s",
    async (lifecycle) => {
      const { session, definition, run, workTurns } = await persistedWorkRoutine();
      try {
        const current = session.projection.getDefinition(definition.id);
        if (current === undefined) throw new Error("Missing definition");
        session.store.appendDefinitionLifecycleChanged({
          automation: decodeAutomationDefinition({
            ...current,
            lifecycle,
            nextDueAt: null,
            version: Number(current.version) + 1,
            updatedAt: "2026-08-10T13:00:24.000Z",
          }),
          previousLifecycle: current.lifecycle,
          expectedVersion: current.version,
        });
        const scheduler = new AutomationSchedulerService({
          store: session.store,
          projection: session.projection,
          dispatch: { offer: () => undefined },
          readWorkTurn: (id) => workTurns.lookup(id),
          now: () => "2026-08-10T14:00:10.000Z" as UtcTimestamp,
        });
        expect(scheduler.runPass().claimedRunIds).toEqual([]);
        expect(session.projection.getRun(run.id)?.lifecycle).toBe("completed");
        expect(session.projection.getDefinition(definition.id)?.lifecycle).toBe(lifecycle);
      } finally {
        session.connection.close();
      }
    },
  );

  it("uses the run snapshot after the current definition is edited", async () => {
    const { session, definition, run, workTurns } = await persistedWorkRoutine();
    try {
      const current = session.projection.getDefinition(definition.id);
      if (current === undefined) throw new Error("Missing definition");
      session.store.appendDefinitionUpdated({
        automation: decodeAutomationDefinition({
          ...current,
          executionProfile: { ...current.executionProfile, modelId: "updated-model" },
          taskPrompt: "A later task",
          definitionRevision: Number(current.definitionRevision) + 1,
          version: Number(current.version) + 1,
          updatedAt: "2026-08-10T13:00:24.000Z",
        }),
        previousDefinitionRevision: current.definitionRevision,
        expectedVersion: current.version,
      });
      const scheduler = new AutomationSchedulerService({
        store: session.store,
        projection: session.projection,
        dispatch: { offer: () => undefined },
        readWorkTurn: (id) => workTurns.lookup(id),
        now: () => "2026-08-10T13:00:30.000Z" as UtcTimestamp,
      });
      expect(scheduler.runPass().errors).toEqual([]);
      expect(session.projection.getRun(run.id)?.lifecycle).toBe("completed");
      expect(session.projection.getRun(run.id)?.definitionSnapshot.executionProfile.modelId).toBe(
        definition.executionProfile.modelId,
      );
    } finally {
      session.connection.close();
    }
  });

  it("does not admit the next occurrence until terminal status is durably committed", async () => {
    const { session, run, workTurns, startCount } = await persistedWorkRoutine();
    try {
      const append = session.store.appendRunStatusChanged.bind(session.store);
      const failed = vi
        .spyOn(session.store, "appendRunStatusChanged")
        .mockImplementation((input) => {
          if (input.lifecycle === "completed") throw new Error("Synthetic storage failure");
          return append(input);
        });
      const scheduler = new AutomationSchedulerService({
        store: session.store,
        projection: session.projection,
        dispatch: { offer: () => undefined },
        readWorkTurn: (id) => workTurns.lookup(id),
        now: () => "2026-08-10T14:00:10.000Z" as UtcTimestamp,
      });
      const refused = scheduler.runPass();
      expect(refused.errors).toHaveLength(1);
      expect(refused.claimedRunIds).toEqual([]);
      expect(session.projection.getRun(run.id)?.lifecycle).toBe("running");
      failed.mockRestore();
      expect(scheduler.runPass().claimedRunIds).toHaveLength(1);
      expect(session.projection.getRun(run.id)?.lifecycle).toBe("completed");
      expect(startCount()).toBe(1);
    } finally {
      session.connection.close();
    }
  });

  it("replays a committed terminal status after a failed notification without replaying the provider", async () => {
    const fixture = await persistedWorkRoutine();
    const { session, definition, run, workTurns, startCount } = fixture;
    const notify = vi.fn(() => {
      throw new Error("Synthetic notification unavailable");
    });
    const first = new AutomationSchedulerService({
      store: session.store,
      projection: session.projection,
      dispatch: { offer: () => undefined },
      readWorkTurn: (id) => workTurns.lookup(id),
      onRunStatusChanged: notify,
      now: () => "2026-08-10T13:00:30.000Z" as UtcTimestamp,
    });
    try {
      expect(first.runPass().errors).toEqual([]);
      expect(session.projection.getRun(run.id)?.lifecycle).toBe("completed");
      expect(notify).toHaveBeenCalledOnce();
    } finally {
      session.connection.close();
    }
    const restarted = openSession(session.databasePath);
    try {
      const turns = new WorkTurnProjection();
      expect(
        hydrateWorkTurnProjectionFromJournal({
          projection: turns,
          replay: (cursor) =>
            restarted.journal.replayAggregateType({
              ...Schema.decodeUnknownSync(ReplayCursor)({
                afterSequence: cursor.afterSequence,
                limit: cursor.limit,
              }),
              aggregateType: cursor.aggregateType ?? "work-turn",
            }),
        }),
      ).toBe("ok");
      const offers: AutomationRun[] = [];
      const scheduler = new AutomationSchedulerService({
        store: restarted.store,
        projection: restarted.projection,
        dispatch: { offer: (input) => offers.push(input.run) },
        readWorkTurn: (id) => turns.lookup(id),
        onRunStatusChanged: notify,
        now: () => "2026-08-10T14:00:10.000Z" as UtcTimestamp,
      });
      expect(scheduler.runPass().claimedRunIds).toHaveLength(1);
      expect(scheduler.runPass().claimedRunIds).toEqual([]);
      expect(restarted.projection.getRun(run.id)?.lifecycle).toBe("completed");
      expect(
        restarted.projection.listRuns({ automationId: definition.id, limit: 20 }).runs,
      ).toHaveLength(2);
      expect(offers).toHaveLength(1);
      expect(notify).toHaveBeenCalledOnce();
      expect(startCount()).toBe(1);
    } finally {
      restarted.connection.close();
    }
  });

  it("records an interrupted Work failure as interruption", async () => {
    const { session, run, workTurns } = await persistedWorkRoutine({
      status: "failed",
      failure: { category: "interrupted", message: "Synthetic stopped provider" },
    });
    try {
      const scheduler = new AutomationSchedulerService({
        store: session.store,
        projection: session.projection,
        dispatch: { offer: () => undefined },
        readWorkTurn: (id) => workTurns.lookup(id),
        now: () => "2026-08-10T13:00:30.000Z" as UtcTimestamp,
      });
      expect(scheduler.runPass().errors).toEqual([]);
      expect(session.projection.getRun(run.id)?.lifecycle).toBe("interrupted");
    } finally {
      session.connection.close();
    }
  });

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

  it("observes the exact recorded Code turn and releases its run only on matching terminal evidence", async () => {
    const session = openSession();
    const definition = codeDefinition();
    const run = claimQueuedRun(session, definition);
    const operationId = automationCodeOperationId(run);
    const code = createCodePort({
      startOrRecoverFirstTurn: async () => ({
        kind: "accepted",
        runtimeReceipt: `code-operation:${operationId}`,
        acceptedAt: definition.createdAt,
      }),
    });
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: code.port,
      work: unavailableAutomationWorkDispatchPort(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });
    await dispatcher.dispatchNow(definition.id, run.id);
    const thread = decodeCodeThread({
      id: automationThreadIdForOccurrence(String(run.occurrenceKey)),
      projectId: definition.projectId,
      bindingRevisionId: AUTOMATION_TEST_IDS.bindingRevision,
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: "aa000000-0000-4000-8000-0000000000e3",
      title: "Routine",
      lifecycle: "active",
      providerInstanceId: definition.executionProfile.providerInstanceId,
      modelId: definition.executionProfile.modelId,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "automation/example",
        remoteName: "origin",
        proposedBaseRepository: "example/project",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: definition.createdAt,
      },
      version: 1,
      createdAt: definition.createdAt,
      updatedAt: definition.createdAt,
    });
    let turn = Schema.decodeUnknownSync(CodeConversationTurn)({
      operationId,
      providerInstanceId: thread.providerInstanceId,
      modelId: thread.modelId,
      sessionId: run.firstTurnRequestId,
      checkoutId: thread.checkoutId,
      prompt: automationCodeEvidenceFromText().put(definition.taskPrompt),
      assistant: [],
      status: "waiting",
      startedAt: definition.createdAt,
      updatedAt: definition.createdAt,
    });
    let prompt = "Different retained task";
    const scheduler = new AutomationSchedulerService({
      store: session.store,
      projection: session.projection,
      dispatch: { offer: () => undefined },
      now: () => "2026-08-10T13:00:30.000Z" as UtcTimestamp,
      readCodeTurn: () => ({ thread, turn, prompt }),
    });
    scheduler.runPass();
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("running");
    prompt = definition.taskPrompt;
    scheduler.runPass();
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("waiting");
    turn = { ...turn, status: "completed" };
    scheduler.runPass();
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("completed");
    expect(session.projection.activeRun(definition.id)).toBeUndefined();
    expect(code.create).toHaveBeenCalledOnce();
    expect(
      hydrateAutomationProjection({ store: session.store, projection: session.projection }),
    ).toBe("ok");
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("completed");
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

  it("dispatches a Chat run through the Chat port, and refuses it when none is wired", async () => {
    const session = openSession();
    const definition = chatDefinition();
    const run = claimQueuedRun(session, definition);
    const create = vi.fn(async (input: { readonly threadId: string }) => ({
      kind: "created" as const,
      threadId: input.threadId as never,
      createdAt: "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    }));
    const launch = vi.fn(async () => ({
      kind: "accepted" as const,
      runtimeReceipt: "chat-turn:test",
      acceptedAt: "2026-08-10T13:00:30.000Z" as UtcTimestamp,
    }));
    const common = {
      store: session.store,
      projection: session.projection,
      code: createCodePort().port,
      work: unavailableAutomationWorkDispatchPort(),
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    };

    await new AutomationDispatchService(common).dispatchNow(definition.id, run.id);
    expect(session.projection.getRun(run.id)?.failure?.reason).toBe("unsupported-mode");

    const second = openSession();
    const secondRun = claimQueuedRun(second, definition);
    await new AutomationDispatchService({
      ...common,
      store: second.store,
      projection: second.projection,
      chat: { createThread: create, startOrRecoverFirstTurn: launch },
    }).dispatchNow(definition.id, secondRun.id);

    expect(create).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    const after = second.projection.getRun(secondRun.id);
    expect(after?.lifecycle).toBe("running");
    expect(after?.threadId).toBe(automationThreadIdForOccurrence(String(secondRun.occurrenceKey)));
    expect(after?.firstTurnAcceptance?.runtimeReceipt).toBe("chat-turn:test");
    session.connection.close();
    second.connection.close();
  });

  it("leaves a Chat run's provider capacity to the ordinary Chat turn path", async () => {
    const session = openSession();
    const definition = chatDefinition();
    const run = claimQueuedRun(session, definition);
    const admit = vi.fn(() => ({ kind: "waiting" as const, message: "full" }));
    const launch = vi.fn(async () => ({
      kind: "accepted" as const,
      runtimeReceipt: "chat-turn:test",
      acceptedAt: "2026-08-10T13:00:30.000Z" as UtcTimestamp,
    }));

    await new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: createCodePort().port,
      work: unavailableAutomationWorkDispatchPort(),
      chat: {
        createThread: async (input) => ({
          kind: "created",
          threadId: input.threadId as never,
          createdAt: "2026-08-10T13:00:20.000Z" as UtcTimestamp,
        }),
        startOrRecoverFirstTurn: launch,
      },
      capacity: { admit },
      resolveFacts: () => matchingFacts(definition),
      now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    }).dispatchNow(definition.id, run.id);

    expect(admit).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    session.connection.close();
  });

  it("runs a due routine with no window open, acting as the host for Code and Work", async () => {
    // The dispatcher is given no window or window registry at all: a routine's
    // thread and first turn are the host's, so nothing about which windows are
    // open can stop the run or lend it an identity.
    for (const definition of [codeDefinition(), workDefinition()]) {
      const session = openSession();
      const run = claimQueuedRun(session, definition);
      const code = createCodePort();
      const workCreate = vi.fn(async (input: { readonly threadId: string }) => ({
        kind: "created" as const,
        threadId: input.threadId as never,
        createdAt: "2026-08-10T13:00:20.000Z" as UtcTimestamp,
      }));
      const workLaunch = vi.fn(async () => ({
        kind: "accepted" as const,
        runtimeReceipt: "work-turn:test",
        acceptedAt: "2026-08-10T13:00:30.000Z" as UtcTimestamp,
      }));
      const dispatcher = new AutomationDispatchService({
        store: session.store,
        projection: session.projection,
        code: code.port,
        work: {
          available: true,
          unavailableReason: undefined,
          createThread: workCreate,
          startOrRecoverFirstTurn: workLaunch,
        },
        capacity: alwaysAdmit(),
        resolveFacts: () => matchingFacts(definition),
        now: () => "2026-08-10T13:00:20.000Z" as UtcTimestamp,
      });

      await dispatcher.dispatchNow(definition.id, run.id);

      expect(session.projection.getRun(run.id)?.lifecycle).toBe("running");
      const [create, launch] =
        definition.mode === "code" ? [code.create, code.launch] : [workCreate, workLaunch];
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ scopeId: ROUTINE_HOST_SCOPE_ID }),
      );
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({ scopeId: ROUTINE_HOST_SCOPE_ID }),
      );
      session.connection.close();
    }
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

describe("one-time follow-ups into their own thread", () => {
  const ORIGIN = "aa000000-0000-4000-8000-0000000000f1";
  const AT = "2026-08-10T13:00:00.000Z";
  const idleThread = {
    kind: "present" as const,
    projectId: AUTOMATION_TEST_IDS.project,
    archived: false,
    done: false,
    busy: false,
    providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
    modelId: workDefinition().executionProfile.modelId,
  };

  function followUpDefinition(): AutomationDefinition {
    return workDefinition({
      trigger: { kind: "once", scheduledAt: AT } as never,
      nextDueAt: AT as never,
      missedRunPolicy: "run-once",
      targetPolicy: "same-thread",
      originThreadId: ORIGIN as never,
    });
  }

  function claim(session: Session, definition: AutomationDefinition, now: string): AutomationRun {
    session.store.appendDefinitionCreated({ automation: definition });
    const scheduler = new AutomationSchedulerService({
      store: session.store,
      projection: session.projection,
      dispatch: { offer: () => undefined },
      now: () => now as UtcTimestamp,
    });
    const claimed = scheduler.runPass().claimedRunIds[0];
    const run = claimed === undefined ? undefined : session.projection.getRun(claimed);
    if (run === undefined) throw new Error("expected a claimed follow-up");
    return run;
  }

  async function fire(input: {
    readonly thread: AutomationFollowUpThreadFacts;
    readonly now?: string;
  }) {
    const session = openSession();
    const definition = followUpDefinition();
    const now = input.now ?? "2026-08-10T13:00:10.000Z";
    const run = claim(session, definition, now);
    const create = vi.fn();
    const launch = vi.fn(async (_input: { readonly threadId: string }) => ({
      kind: "accepted" as const,
      runtimeReceipt: "work-turn:follow-up",
      acceptedAt: now as UtcTimestamp,
    }));
    const dispatcher = new AutomationDispatchService({
      store: session.store,
      projection: session.projection,
      code: createCodePort().port,
      work: {
        available: true,
        unavailableReason: undefined,
        createThread: create,
        startOrRecoverFirstTurn: launch,
      },
      capacity: alwaysAdmit(),
      resolveFacts: () => matchingFacts(definition),
      readFollowUpThread: () => input.thread,
      now: () => now as UtcTimestamp,
    });
    await dispatcher.dispatchNow(definition.id, run.id);
    // The next scheduler pass ends a once routine whose run is terminal.
    new AutomationSchedulerService({
      store: session.store,
      projection: session.projection,
      dispatch: { offer: () => undefined },
      now: () => now as UtcTimestamp,
    }).runPass();
    return { session, definition, run, create, launch };
  }

  it("sends one turn into the thread it came from and creates no thread", async () => {
    const { session, run, create, launch } = await fire({ thread: idleThread });
    expect(create).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ threadId: ORIGIN });
    const after = session.projection.getRun(run.id);
    expect(after?.lifecycle).toBe("running");
    expect(after?.dispatchIntent?.threadId).toBe(ORIGIN);
    session.connection.close();
  });

  it.each([
    ["archived", { ...idleThread, archived: true }, "thread-unavailable"],
    ["marked done", { ...idleThread, done: true }, "thread-done"],
    ["running a turn", { ...idleThread, busy: true }, "thread-busy"],
    ["on another model", { ...idleThread, modelId: "other-model" }, "execution-profile-mismatch"],
  ] as const)(
    "never runs when its thread is %s, records why, and ends itself",
    async (_label, thread, reason) => {
      const { session, definition, run, launch } = await fire({ thread });
      expect(launch).not.toHaveBeenCalled();
      expect(session.projection.getRun(run.id)).toMatchObject({
        lifecycle: "failed",
        failure: { reason },
      });
      expect(session.projection.getDefinition(definition.id)?.lifecycle).toBe("exhausted");
      session.connection.close();
    },
  );

  it("records a follow-up missed by more than a day instead of running it", async () => {
    const { session, definition, run, launch } = await fire({
      thread: idleThread,
      now: "2026-08-11T13:00:01.000Z",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(session.projection.getRun(run.id)?.failure?.reason).toBe("follow-up-missed");
    expect(session.projection.getDefinition(definition.id)?.lifecycle).toBe("exhausted");
    session.connection.close();
  });

  it("still runs a follow-up missed by less than a day", async () => {
    const { session, launch } = await fire({
      thread: idleThread,
      now: "2026-08-11T12:59:00.000Z",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    session.connection.close();
  });
});
