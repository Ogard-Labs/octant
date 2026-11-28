import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  automationThreadFinishedTurnPrompt,
  decodeAutomationCommand,
  decodeAutomationId,
  decodeAutomationRunNowRequestId,
  decodeAutomationThreadId,
  decodeRoutineProposalDecisionResult,
  decodeRoutineProposalList,
  decodeWindowId,
  LOCAL_HOST_ID,
  MAX_AUTOMATION_FINISH_WAITS_PER_HOST,
  MAX_AUTOMATION_FINISH_WAITS_PER_THREAD,
  type AutomationCommandResult,
  type AutomationFinishWaitRecord,
  type AutomationMode,
  type AutomationRun,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import { AgentProfile } from "@octant/contracts/agent-profile";
import { EventActor } from "@octant/contracts/events";
import type { ThreadFinishTargetFacts } from "@octant/domain";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { AGENT_ACCESS_ORIGIN, type ClientPrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { AutomationCommandService } from "./automationCommandService";
import { AutomationDispatchService } from "./automationDispatchService";
import { AutomationEventStore, registerAutomationEvents } from "./automationEventStore";
import { AutomationProjection, hydrateAutomationProjection } from "./automationProjection";
import { createAutomationRouteHandler } from "./automationRoutes";
import { AutomationThreadFinishWatcher } from "./automationThreadFinishWatcher";
import { RoutineProposalService } from "./routineProposalService";
import { createRoutineProposalTools } from "./routineProposalTools";
import {
  buildThreadRoutineDraft,
  type RoutineSourceThread,
  type ThreadRoutineDraftInput,
} from "./threadRoutineDraft";
import { AUTOMATION_TEST_IDS, automationDefinitionDraftFixture } from "./automationTestFixtures";

const NOW = "2026-11-28T12:00:00.000Z" as UtcTimestamp;
const PROJECT = AUTOMATION_TEST_IDS.project;
const TARGET_PROJECT = "bb000000-0000-4000-8000-000000000002";
const BINDING_REVISION = "bb000000-0000-4000-8000-000000000003";
const ORIGIN_THREAD = "bb000000-0000-4000-8000-000000000010";
const TARGET_THREAD = "bb000000-0000-4000-8000-000000000020";
const CHILD_THREAD = "bb000000-0000-4000-8000-000000000021";
const PROFILE = "bb000000-0000-4000-8000-000000000004";
const PROVIDER = "cc000000-0000-4000-8000-0000000000aa";
const ACTOR = "bb000000-0000-4000-8000-000000000007";
const WINDOW_CAPABILITY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const WINDOW_ID = decodeWindowId("bb000000-0000-4000-8000-000000000101");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function presentTarget(
  overrides: Partial<Extract<ThreadFinishTargetFacts, { readonly kind: "present" }>> = {},
): Extract<ThreadFinishTargetFacts, { readonly kind: "present" }> {
  return {
    kind: "present",
    threadId: TARGET_THREAD,
    mode: "code",
    projectId: TARGET_PROJECT,
    working: false,
    hasOpenRequest: false,
    hasPendingDecision: false,
    hasQueuedMessage: false,
    done: false,
    ...overrides,
  };
}

function createHarness(options?: {
  readonly mode?: AutomationMode;
  readonly principalOverride?: ClientPrincipal;
  readonly targetFacts?: Map<string, ThreadFinishTargetFacts>;
  readonly childThreads?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly authorAuthorized?: () => boolean;
  readonly coordinatorLimit?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "octant-finish-wait-"));
  const connection = openSqlite(join(dir, "octant.sqlite"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  cleanups.push(() => {
    connection.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let clockIso: UtcTimestamp = NOW;
  let counter = 0;
  const uuid = () => {
    counter += 1;
    return `ee000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };

  const registry = registerAutomationEvents(new EventRegistry());
  const projection = new AutomationProjection();
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(projection),
    clock: () => clockIso,
  });
  const actor = Schema.decodeUnknownSync(EventActor)({ kind: "system", actorId: ACTOR });
  const store = new AutomationEventStore({ journal, actor, uuid });

  const mode = options?.mode ?? "work";
  const targetFacts =
    options?.targetFacts ??
    new Map<string, ThreadFinishTargetFacts>([[TARGET_THREAD, presentTarget({ working: true })]]);

  const commands = new AutomationCommandService({
    store,
    projection,
    hostId: String(LOCAL_HOST_ID),
    clock: () => clockIso,
    isTargetThreadAvailable: (target) =>
      targetFacts.get(String(target.threadId))?.kind === "present",
    isChildThreadOf: (parentId, candidateId) =>
      options?.childThreads?.get(parentId)?.has(candidateId) === true,
  });

  const dispatched: Array<{ readonly runId: string; readonly prompt: string }> = [];
  const startedRuns: Array<AutomationRun> = [];
  const pendingDispatches: Array<Promise<void>> = [];
  let wakes = 0;
  const coordinatorLimit = options?.coordinatorLimit ?? 10;

  const dispatchService = new AutomationDispatchService({
    store,
    projection,
    now: () => clockIso,
    schedule: (work) => {
      pendingDispatches.push(work());
    },
    resolveFacts: () => ({
      hostId: String(LOCAL_HOST_ID),
      project: {
        id: PROJECT as never,
        name: "Reports",
        type: mode,
        lifecycle: "active",
        pinned: false,
        rank: "0/1" as never,
        version: 1 as never,
        createdAt: NOW,
        updatedAt: NOW,
      } as never,
      providerInstance: {
        id: PROVIDER as never,
        driverId: "openai",
        displayName: "OpenAI",
        enabled: true,
        availability: "available",
        authKind: "api-key",
        lifecycle: "active",
        status: "configured",
        version: 1 as never,
        createdAt: NOW,
        updatedAt: NOW,
      } as never,
      providerSupportsModel: true,
      executionProfileMatches: true,
      authorityDigestMatches: true,
      extensionTrustMatches: true,
      codeBindingMatches: true,
      workBindingMatches: true,
      authorAuthorized: options?.authorAuthorized?.() ?? true,
    }),
    readFollowUpThread: ({ mode: targetMode }) => ({
      kind: "present",
      mode: targetMode,
      projectId: PROJECT,
      archived: false,
      done: false,
      busy: false,
      providerInstanceId: PROVIDER,
      modelId: "model-small",
      executionPolicy: "approval-gated",
    }),
    admitCoordinatorWake: () => {
      if (wakes >= coordinatorLimit) {
        return {
          allowed: false,
          message: "The coordinator reached its hourly wake bound, so the follow-up did not start.",
        };
      }
      wakes += 1;
      return { allowed: true };
    },
    capacity: {
      admit: () => ({ kind: "admitted", release: () => undefined }),
    },
    code: {
      createApprovalGatedThread: async ({ threadId }) => ({
        kind: "created",
        threadId: decodeAutomationThreadId(String(threadId)),
        createdAt: clockIso,
      }),
      startOrRecoverFirstTurn: async ({ run }) => {
        startedRuns.push(run);
        const prompt =
          run.occurrence.kind === "thread-finished"
            ? automationThreadFinishedTurnPrompt(
                run.definitionSnapshot.taskPrompt,
                String(run.occurrence.targetThreadId),
              )
            : run.definitionSnapshot.taskPrompt;
        dispatched.push({ runId: String(run.id), prompt });
        return { kind: "accepted", runtimeReceipt: "receipt-code", acceptedAt: clockIso };
      },
    },
    work: {
      available: true,
      unavailableReason: undefined,
      createThread: async ({ threadId }) => ({
        kind: "created",
        threadId: decodeAutomationThreadId(String(threadId)),
        createdAt: clockIso,
      }),
      startOrRecoverFirstTurn: async ({ run }) => {
        startedRuns.push(run);
        const prompt =
          run.occurrence.kind === "thread-finished"
            ? automationThreadFinishedTurnPrompt(
                run.definitionSnapshot.taskPrompt,
                String(run.occurrence.targetThreadId),
              )
            : run.definitionSnapshot.taskPrompt;
        dispatched.push({ runId: String(run.id), prompt });
        return { kind: "accepted", runtimeReceipt: "receipt-work", acceptedAt: clockIso };
      },
    },
  });

  const watcher = new AutomationThreadFinishWatcher({
    store,
    projection,
    dispatch: dispatchService,
    readTarget: (input) =>
      targetFacts.get(input.threadId) ?? { kind: "unavailable", reason: "missing" },
    now: () => clockIso,
  });

  const authority = new WindowAuthorityStore();
  authority.register({ windowId: WINDOW_ID, capability: WINDOW_CAPABILITY, now: Date.parse(NOW) });
  const proposals = new RoutineProposalService({ uuid, now: () => Date.parse(clockIso) });
  const profile = Schema.decodeUnknownSync(AgentProfile)({
    id: PROFILE,
    displayName: "Ask first",
    approvedSkillIds: [],
    toolConstraints: [],
    modelConstraints: [],
    defaultExecutionPolicy: "approval-gated",
    defaultPermissionPersistence: "project-default",
    compatibleModes: ["chat", "work", "code"],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const sourceThread: RoutineSourceThread = {
    projectId: PROJECT,
    active: true,
    providerInstanceId: PROVIDER,
    modelId: "model-small",
  };
  const draft = (input: ThreadRoutineDraftInput) =>
    buildThreadRoutineDraft(
      {
        hostId: String(LOCAL_HOST_ID),
        actorId: ACTOR,
        readThread: () => sourceThread,
        readProject: () => ({
          name: "Reports",
          mode,
          active: true,
          version: 1,
          bindingRevisionId: mode === "chat" ? undefined : BINDING_REVISION,
        }),
        checkoutAvailable: () => true,
        profiles: () => [profile],
        uuid,
        clock: () => clockIso,
      },
      input,
    );

  const handler = createAutomationRouteHandler({
    windowAuthorityStore: authority,
    commands,
    projection,
    projects: {
      bootstrap: async () => ({
        active: [
          {
            id: PROJECT,
            name: "Reports",
            type: mode,
            binding: null as never,
            bindingRevisionId: BINDING_REVISION as never,
            lifecycle: "active" as const,
            pinned: false,
            rank: "0/1" as never,
            version: 1 as never,
            createdAt: NOW as never,
            updatedAt: NOW as never,
          } as never,
          {
            id: TARGET_PROJECT,
            name: "Target Project",
            type: "code",
            binding: null as never,
            bindingRevisionId: BINDING_REVISION as never,
            lifecycle: "active" as const,
            pinned: false,
            rank: "0/2" as never,
            version: 1 as never,
            createdAt: NOW as never,
            updatedAt: NOW as never,
          } as never,
        ],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    hostId: String(LOCAL_HOST_ID),
    now: () => Date.parse(clockIso),
    uuid,
    proposals: { service: proposals, draft },
    listFinishWaitTargets: () => [
      {
        threadId: TARGET_THREAD,
        mode: "code",
        projectId: TARGET_PROJECT as never,
        projectName: "Target Project",
        title: "Secret title that must never enter prompts",
        status: "working",
        alreadyTurnFinished: false,
        alreadyDone: false,
        hostId: LOCAL_HOST_ID,
      },
    ],
  });

  const tools = (fullAccess = false) =>
    createRoutineProposalTools({
      windowId: WINDOW_ID as WindowId,
      thread: { id: ORIGIN_THREAD, mode, projectId: PROJECT },
      isAutomationOrigin: false,
      proposals,
      readPosture: () => (fullAccess ? "full-access" : "approval-gated"),
      startsActiveAtFullAccess: () => fullAccess,
      readStrict: () => false,
      readOutsideContent: () => false,
      now: () => Date.parse(clockIso),
    });

  async function requestJson(
    path: string,
    init: { readonly method?: "GET" | "POST"; readonly body?: unknown } = {},
  ) {
    const req = new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(options?.principalOverride === undefined
          ? { "x-octant-window-capability": WINDOW_CAPABILITY }
          : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (options?.principalOverride !== undefined) {
      bindPrincipalRouteContext(req, {
        principal: options.principalOverride,
        scopeId: WINDOW_ID,
      });
    }
    const response = await handler(req);
    return { status: response?.status ?? 0, body: (await response?.json()) as unknown };
  }

  async function flushDispatches() {
    while (pendingDispatches.length > 0) {
      const next = pendingDispatches.splice(0, pendingDispatches.length);
      await Promise.all(next);
    }
  }

  return {
    store,
    projection,
    commands,
    dispatchService,
    watcher,
    proposals,
    handler,
    tools,
    targetFacts,
    dispatched,
    startedRuns,
    requestJson,
    flushDispatches,
    setClock: (next: string) => {
      clockIso = next as UtcTimestamp;
    },
    uuid,
  };
}

function remotePrincipal(overrides: {
  readonly admittedBy?: "host-person" | "hub-roster";
  readonly accessLevel?: "approve-and-steer" | "read-only";
  readonly origin?: string;
}): ClientPrincipal {
  return {
    kind: "remote-device",
    hostId: LOCAL_HOST_ID as never,
    deviceId: "dd000000-0000-4000-8000-000000000001" as never,
    credentialGeneration: 1,
    origin: overrides.origin ?? "https://app.example.test",
    protocolVersion: 1,
    capabilityDigest: "digest-1",
    sessionId: "dd000000-0000-4000-8000-000000000002" as never,
    ...(overrides.admittedBy === undefined ? {} : { admittedBy: overrides.admittedBy }),
    ...(overrides.accessLevel === undefined ? {} : { accessLevel: overrides.accessLevel }),
  };
}

describe("thread-finished follow-ups and routine waits", () => {
  it("arms all three actions from a local window and refuses hub-introduced, narrower paired, and agent-grant principals", async () => {
    const h = createHarness();

    // Action 1: same-thread follow-up when target finishes.
    const sameThread = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Check the completed build.",
      },
    })) as { readonly status: number; readonly body: AutomationCommandResult };
    expect(sameThread.status).toBe(200);
    expect(sameThread.body.kind).toBe("automation-created");

    // Action 2: start a new thread in this Project when target is marked done.
    const newThread = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "new-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "done",
        taskPrompt: "Open a fresh follow-up thread.",
      },
    })) as { readonly status: number; readonly body: AutomationCommandResult };
    expect(newThread.status).toBe(200);
    expect(newThread.body.kind).toBe("automation-created");

    // Action 3: attach a one-shot finish wait to an existing scheduled routine.
    const existingId = decodeAutomationId(h.uuid());
    const scheduled = h.commands.execute(
      decodeAutomationCommand({
        kind: "create-automation",
        automationId: existingId,
        expectedVersion: 0,
        principal: { kind: "local-window", windowId: String(WINDOW_ID), capabilityGeneration: 0 },
        origin: { kind: "interactive" },
        definition: automationDefinitionDraftFixture({
          projectId: PROJECT as never,
          trigger: { kind: "once", scheduledAt: "2026-12-01T09:00:00.000Z" as UtcTimestamp },
        }),
      }),
    );
    expect(scheduled.kind).toBe("automation-created");

    const attached = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-routine-finish-wait",
        automationId: existingId,
        expectedVersion: 1,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
      },
    })) as { readonly status: number; readonly body: AutomationCommandResult };
    expect(attached.status).toBe(200);
    expect(attached.body.kind).toBe("automation-updated");
    expect(h.projection.getFinishWait(existingId)?.state).toBe("armed");

    // Hub-introduced device, narrower paired device, and agent grant are all refused.
    const refusedPrincipals: ReadonlyArray<ClientPrincipal> = [
      remotePrincipal({ admittedBy: "hub-roster" }),
      remotePrincipal({ admittedBy: "host-person", accessLevel: "approve-and-steer" }),
      remotePrincipal({ admittedBy: "host-person", accessLevel: "read-only" }),
      remotePrincipal({ origin: AGENT_ACCESS_ORIGIN }),
    ];
    for (const principal of refusedPrincipals) {
      const restricted = createHarness({ principalOverride: principal });
      const res = (await restricted.requestJson("/api/automations/follow-ups", {
        method: "POST",
        body: {
          kind: "arm-thread-finish-follow-up",
          action: "same-thread",
          threadId: ORIGIN_THREAD,
          mode: "work",
          projectId: PROJECT,
          targetThreadId: TARGET_THREAD,
          targetMode: "code",
          targetProjectId: TARGET_PROJECT,
          condition: "turn-finished",
          taskPrompt: "Should be refused.",
        },
      })) as { readonly body: AutomationCommandResult };
      expect(res.body.kind).toBe("automation-command-failed");
    }

    // Full-access person-paired device is allowed.
    const fullPaired = createHarness({
      principalOverride: remotePrincipal({ admittedBy: "host-person" }),
    });
    const allowed = (await fullPaired.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Paired owner phone wait.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(allowed.body.kind).toBe("automation-created");
  });

  it("refuses self-waits, child-run waits, and waits beyond the per-thread and per-host bounds", async () => {
    const targetFacts = new Map<string, ThreadFinishTargetFacts>([
      [
        ORIGIN_THREAD,
        presentTarget({ threadId: ORIGIN_THREAD, mode: "work", projectId: PROJECT, working: true }),
      ],
      [CHILD_THREAD, presentTarget({ threadId: CHILD_THREAD, working: true })],
      [TARGET_THREAD, presentTarget({ working: true })],
    ]);
    const h = createHarness({
      targetFacts,
      childThreads: new Map([[ORIGIN_THREAD, new Set([CHILD_THREAD])]]),
    });

    const selfWait = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: ORIGIN_THREAD,
        targetMode: "work",
        targetProjectId: PROJECT,
        condition: "turn-finished",
        taskPrompt: "Wait on self.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(selfWait.body.kind).toBe("automation-command-failed");

    const childWait = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: CHILD_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Wait on child.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(childWait.body.kind).toBe("automation-command-failed");

    // 8 waits on one thread succeed; the 9th is refused.
    for (let i = 0; i < MAX_AUTOMATION_FINISH_WAITS_PER_THREAD; i += 1) {
      const ok = (await h.requestJson("/api/automations/follow-ups", {
        method: "POST",
        body: {
          kind: "arm-thread-finish-follow-up",
          action: "same-thread",
          threadId: ORIGIN_THREAD,
          mode: "work",
          projectId: PROJECT,
          targetThreadId: TARGET_THREAD,
          targetMode: "code",
          targetProjectId: TARGET_PROJECT,
          condition: "turn-finished",
          taskPrompt: `Wait ${String(i + 1)}`,
        },
      })) as { readonly body: AutomationCommandResult };
      expect(ok.body.kind).toBe("automation-created");
    }
    const ninth = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Wait 9",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(ninth.body.kind).toBe("automation-command-failed");

    // Across distinct origin threads, the host caps armed waits at 32.
    const hostCap = createHarness({ targetFacts });
    for (let i = 0; i < MAX_AUTOMATION_FINISH_WAITS_PER_HOST; i += 1) {
      const res = hostCap.commands.execute(
        decodeAutomationCommand({
          kind: "create-automation",
          automationId: decodeAutomationId(hostCap.uuid()),
          expectedVersion: 0,
          principal: { kind: "local-window", windowId: String(WINDOW_ID), capabilityGeneration: 0 },
          origin: { kind: "interactive" },
          definition: automationDefinitionDraftFixture({
            projectId: PROJECT as never,
            trigger: {
              kind: "thread-finished",
              targetThreadId: decodeAutomationThreadId(TARGET_THREAD),
              targetMode: "code",
              targetProjectId: TARGET_PROJECT as never,
              condition: "turn-finished",
              armedAt: NOW,
              expiresAt: "2026-12-05T12:00:00.000Z" as UtcTimestamp,
            },
            missedRunPolicy: "run-once",
          }),
        }),
        {
          originThreadId: decodeAutomationThreadId(
            `dd000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          ),
        },
      );
      expect(res.kind).toBe("automation-created");
    }
    const thirtyThird = hostCap.commands.execute(
      decodeAutomationCommand({
        kind: "create-automation",
        automationId: decodeAutomationId(hostCap.uuid()),
        expectedVersion: 0,
        principal: { kind: "local-window", windowId: String(WINDOW_ID), capabilityGeneration: 0 },
        origin: { kind: "interactive" },
        definition: automationDefinitionDraftFixture({
          projectId: PROJECT as never,
          trigger: {
            kind: "thread-finished",
            targetThreadId: decodeAutomationThreadId(TARGET_THREAD),
            targetMode: "code",
            targetProjectId: TARGET_PROJECT as never,
            condition: "turn-finished",
            armedAt: NOW,
            expiresAt: "2026-12-05T12:00:00.000Z" as UtcTimestamp,
          },
          missedRunPolicy: "run-once",
        }),
      }),
      { originThreadId: decodeAutomationThreadId("dd000000-0000-4000-8000-000000000999") },
    );
    expect(thirtyThird.kind).toBe("automation-command-failed");
  });

  it("holds agent-proposed thread-finished waits on the person's card even at Full access and arms only on confirm", async () => {
    const h = createHarness();
    const agentTools = h.tools(true);
    const pendingCall = agentTools.execute({
      name: "octant_propose_routine",
      inputJson: JSON.stringify({
        name: "Follow up after build",
        trigger: "thread-finished",
        action: "same-thread",
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        prompt: "Inspect the test report.",
        requestedByPerson: true,
      }),
    });

    // Older clients without ?reads=thread-finished do not see the finish-wait proposal.
    const hidden = await h.requestJson("/api/automations/proposals");
    expect(decodeRoutineProposalList(hidden.body).proposals).toEqual([]);

    // Newer clients passing ?reads=thread-finished see the proposal waiting on the card.
    const listed = await h.requestJson("/api/automations/proposals?reads=thread-finished");
    const proposals = decodeRoutineProposalList(listed.body).proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "routine-finish-wait-proposal",
      targetThreadId: TARGET_THREAD,
      condition: "turn-finished",
    });
    expect(h.projection.listArmedFinishWaits()).toHaveLength(0);

    // Confirming arms the wait and resolves the tool call.
    const decision = await h.requestJson("/api/automations/proposals/decide", {
      method: "POST",
      body: { proposalId: proposals[0]?.proposalId, decision: "confirm" },
    });
    expect(decodeRoutineProposalDecisionResult(decision.body).kind).toBe(
      "routine-proposal-confirmed",
    );
    const toolResult = await pendingCall;
    expect(toolResult.isError).toBeFalsy();
    expect(h.projection.listArmedFinishWaits()).toHaveLength(1);
  });

  it("fires once on completion, survives duplicate facts and replay, and leaks no target title or reply", async () => {
    const h = createHarness();
    const armed = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Continue the review.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(armed.body.kind).toBe("automation-created");
    if (armed.body.kind !== "automation-created") return;
    const automationId = armed.body.automation.id;

    // Still working, open request, pending decision, queued message, or pre-arming baseline turns never fire.
    const nonFiringStates: ReadonlyArray<ThreadFinishTargetFacts> = [
      presentTarget({ working: true }),
      presentTarget({
        hasOpenRequest: true,
        latestCompletedTurn: {
          turnId: "turn-1",
          completedAt: "2026-11-28T12:05:00.000Z" as UtcTimestamp,
        },
      }),
      presentTarget({
        hasPendingDecision: true,
        latestCompletedTurn: {
          turnId: "turn-1",
          completedAt: "2026-11-28T12:05:00.000Z" as UtcTimestamp,
        },
      }),
      presentTarget({
        hasQueuedMessage: true,
        latestCompletedTurn: {
          turnId: "turn-1",
          completedAt: "2026-11-28T12:05:00.000Z" as UtcTimestamp,
        },
      }),
      presentTarget({
        latestCompletedTurn: {
          turnId: "turn-0",
          completedAt: "2026-11-28T11:55:00.000Z" as UtcTimestamp,
        },
      }),
    ];
    for (const facts of nonFiringStates) {
      h.targetFacts.set(TARGET_THREAD, facts);
      const summary = h.watcher.reconcile();
      expect(summary.firedRunIds).toEqual([]);
    }
    await h.flushDispatches();
    expect(h.dispatched).toHaveLength(0);

    // Target completes a post-arming turn cleanly -> fires once.
    h.setClock("2026-11-28T12:06:00.000Z");
    h.targetFacts.set(
      TARGET_THREAD,
      presentTarget({
        latestCompletedTurn: {
          turnId: "turn-post-arm",
          completedAt: "2026-11-28T12:06:00.000Z" as UtcTimestamp,
        },
      }),
    );
    const fired = h.watcher.reconcile();
    await h.flushDispatches();
    expect(fired.firedRunIds).toHaveLength(1);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.prompt).toContain(TARGET_THREAD);
    expect(h.dispatched[0]?.prompt).toContain("Continue the review.");
    expect(h.dispatched[0]?.prompt).not.toContain("Secret title");

    // Re-running reconcile and replaying into a fresh projection never fires a second run.
    const secondPass = h.watcher.reconcile();
    expect(secondPass.firedRunIds).toEqual([]);
    const replayed = new AutomationProjection();
    hydrateAutomationProjection({ store: h.store, projection: replayed });
    expect(replayed.getFinishWait(automationId)?.state).toBe("fired");
    expect(replayed.listRuns({ automationId, limit: 10 }).runs).toHaveLength(1);
  });

  it("handles missed waits with Run now, expiry, unavailable targets, revoked arming devices, coordinator wake bounds, and older-client filtering", async () => {
    // 1. Late finish transitions to missed; does not auto-fire; Run now runs once.
    const h = createHarness();
    const armed = (await h.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Late check.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(armed.body.kind).toBe("automation-created");
    if (armed.body.kind !== "automation-created") return;
    const automationId = armed.body.automation.id;

    // Older clients without ?reads=thread-finished do not see this routine.
    const oldList = (await h.requestJson("/api/automations/list?mode=all")) as {
      readonly body: { readonly items: ReadonlyArray<unknown> };
    };
    expect(oldList.body.items).toHaveLength(0);
    const newList = (await h.requestJson(
      "/api/automations/list?mode=all&reads=thread-finished",
    )) as {
      readonly body: {
        readonly items: ReadonlyArray<{ readonly finishWait?: AutomationFinishWaitRecord }>;
      };
    };
    expect(newList.body.items).toHaveLength(1);
    expect(newList.body.items[0]?.finishWait?.state).toBe("armed");

    // Finish occurred 25 hours before host noticed it -> missed, no auto-dispatch.
    h.setClock("2026-11-30T14:00:00.000Z");
    h.targetFacts.set(
      TARGET_THREAD,
      presentTarget({
        latestCompletedTurn: {
          turnId: "turn-late",
          completedAt: "2026-11-29T12:00:00.000Z" as UtcTimestamp,
        },
      }),
    );
    const missed = h.watcher.reconcile();
    await h.flushDispatches();
    expect(missed.missedAutomationIds).toEqual([automationId]);
    expect(h.dispatched).toHaveLength(0);
    const wait = h.projection.getFinishWait(automationId);
    expect(wait?.state).toBe("missed");

    // Person chooses Run now on the missed wait -> dispatches once.
    const runMissed = h.commands.execute(
      decodeAutomationCommand({
        kind: "run-missed-finish-wait",
        automationId,
        expectedVersion: h.projection.getDefinition(automationId)!.version,
        waitId: wait!.waitId,
        runNowRequestId: decodeAutomationRunNowRequestId(h.uuid()),
        principal: { kind: "local-window", windowId: String(WINDOW_ID), capabilityGeneration: 0 },
        origin: { kind: "interactive" },
      }),
    );
    expect(runMissed.kind).toBe("automation-run-accepted");
    if (runMissed.kind === "automation-run-accepted") {
      await h.dispatchService.dispatchNow(automationId, runMissed.run.id);
      expect(h.dispatched).toHaveLength(1);
    }

    // 2. Expired wait transitions to expired after 7 days and never fires.
    const hExpired = createHarness();
    const expRes = (await hExpired.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Expires in 7 days.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(expRes.body.kind).toBe("automation-created");
    hExpired.setClock("2026-12-06T12:00:00.000Z");
    const expiredSummary = hExpired.watcher.reconcile();
    await hExpired.flushDispatches();
    expect(expiredSummary.expiredAutomationIds).toHaveLength(1);
    expect(hExpired.dispatched).toHaveLength(0);

    // 3. Missing/archived target transitions to unavailable and never fires.
    const hMissing = createHarness();
    await hMissing.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Missing target.",
      },
    });
    hMissing.targetFacts.set(TARGET_THREAD, { kind: "unavailable", reason: "archived" });
    const missingSummary = hMissing.watcher.reconcile();
    await hMissing.flushDispatches();
    expect(missingSummary.unavailableAutomationIds).toHaveLength(1);
    expect(hMissing.dispatched).toHaveLength(0);

    // 4. Revoked arming paired device fails authority revalidation and does not dispatch.
    let deviceStillValid = true;
    const hRevoked = createHarness({
      principalOverride: remotePrincipal({ admittedBy: "host-person" }),
      authorAuthorized: () => deviceStillValid,
    });
    const revRes = (await hRevoked.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Paired wait.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(revRes.body.kind).toBe("automation-created");
    deviceStillValid = false;
    hRevoked.setClock("2026-11-28T12:10:00.000Z");
    hRevoked.targetFacts.set(
      TARGET_THREAD,
      presentTarget({
        latestCompletedTurn: {
          turnId: "turn-after-revoke",
          completedAt: "2026-11-28T12:10:00.000Z" as UtcTimestamp,
        },
      }),
    );
    hRevoked.watcher.reconcile();
    await hRevoked.flushDispatches();
    expect(hRevoked.dispatched).toHaveLength(0);
    if (revRes.body.kind === "automation-created") {
      const runs = hRevoked.projection.listRuns({
        automationId: revRes.body.automation.id,
        limit: 10,
      }).runs;
      expect(runs[0]?.lifecycle).toBe("failed");
      expect(runs[0]?.failure?.reason).toBe("authority-mismatch");
    }

    // 5. Coordinator wake bound blocks same-thread dispatch when the hourly wake bound is hit.
    const hCoord = createHarness({ coordinatorLimit: 0 });
    const coordRes = (await hCoord.requestJson("/api/automations/follow-ups", {
      method: "POST",
      body: {
        kind: "arm-thread-finish-follow-up",
        action: "same-thread",
        threadId: ORIGIN_THREAD,
        mode: "work",
        projectId: PROJECT,
        targetThreadId: TARGET_THREAD,
        targetMode: "code",
        targetProjectId: TARGET_PROJECT,
        condition: "turn-finished",
        taskPrompt: "Wake coordinator.",
      },
    })) as { readonly body: AutomationCommandResult };
    expect(coordRes.body.kind).toBe("automation-created");
    hCoord.setClock("2026-11-28T12:10:00.000Z");
    hCoord.targetFacts.set(
      TARGET_THREAD,
      presentTarget({
        latestCompletedTurn: {
          turnId: "turn-coord",
          completedAt: "2026-11-28T12:10:00.000Z" as UtcTimestamp,
        },
      }),
    );
    hCoord.watcher.reconcile();
    await hCoord.flushDispatches();
    expect(hCoord.dispatched).toHaveLength(0);
  });
});
