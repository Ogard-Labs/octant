import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeRoutineProposalDecisionResult,
  decodeRoutineProposalList,
  decodeWindowId,
  type ProviderExecutionPolicy,
  type WindowId,
} from "@octant/contracts";
import { AgentProfile } from "@octant/contracts/agent-profile";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { AutomationCommandService } from "./automationCommandService";
import { AutomationEventStore, registerAutomationEvents } from "./automationEventStore";
import { AutomationProjection, hydrateAutomationProjection } from "./automationProjection";
import { createAutomationRouteHandler } from "./automationRoutes";
import { RoutineProposalService, type RoutineProposalOutcome } from "./routineProposalService";
import { createRoutineProposalTools } from "./routineProposalTools";
import { buildThreadRoutineDraft, type RoutineSourceThread } from "./threadRoutineDraft";

const NOW = "2026-10-31T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const PROJECT = "bb000000-0000-4000-8000-000000000001";
const BINDING_REVISION = "bb000000-0000-4000-8000-000000000002";
const THREAD = "bb000000-0000-4000-8000-000000000003";
const PROFILE = "bb000000-0000-4000-8000-000000000004";
const REPOSITORY = `repo_${"5".repeat(64)}`;
const CHECKOUT = "bb000000-0000-4000-8000-000000000006";
const ACTOR = "bb000000-0000-4000-8000-000000000007";
const capability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const otherCapability = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";
const windowId = decodeWindowId("bb000000-0000-4000-8000-000000000101");
const otherWindowId = decodeWindowId("bb000000-0000-4000-8000-000000000102");

const directories: Array<string> = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

let counter = 0;
function uuid(): string {
  counter += 1;
  return `cc000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

const profile = Schema.decodeUnknownSync(AgentProfile)({
  id: PROFILE,
  displayName: "Ask first",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "project-default",
  compatibleModes: ["work", "code"],
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

function harness(options: { readonly mode?: "work" | "code" } = {}) {
  const mode = options.mode ?? "work";
  const directory = mkdtempSync(join(tmpdir(), "octant-routine-proposal-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const registry = registerAutomationEvents(new EventRegistry());
  const projection = new AutomationProjection();
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(projection),
    clock: () => NOW,
  });
  const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ACTOR });
  const store = new AutomationEventStore({ journal, uuid, actor });
  const commands = new AutomationCommandService({
    store,
    projection,
    hostId: "local",
    clock: () => NOW,
  });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: 0 });
  authority.register({ windowId: otherWindowId, capability: otherCapability, now: 0 });
  const proposals = new RoutineProposalService({ uuid, now: () => NOW_MS });
  const thread: { current: RoutineSourceThread | undefined } = {
    current: {
      projectId: PROJECT,
      active: true,
      providerInstanceId: "cc000000-0000-4000-8000-0000000000aa",
      modelId: "model-small",
      ...(mode === "code"
        ? {
            executionPolicy: "auto-accept-edits" as ProviderExecutionPolicy,
            permissionPersistence: "current-session" as const,
            checkout: { repositoryId: REPOSITORY, checkoutId: CHECKOUT },
          }
        : {}),
    },
  };
  const handler = createAutomationRouteHandler({
    projection,
    commands,
    windowAuthorityStore: authority,
    projects: {
      bootstrap: async () => ({
        // The routes read only the id, type, and lifecycle of a Project.
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
        ],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    hostId: "local",
    now: () => 1,
    uuid,
    proposals: {
      service: proposals,
      draft: (proposal) =>
        buildThreadRoutineDraft(
          {
            hostId: "local",
            actorId: ACTOR,
            readThread: () => thread.current,
            readProject: () => ({
              name: "Reports",
              mode,
              active: true,
              version: 1,
              bindingRevisionId: BINDING_REVISION,
            }),
            checkoutAvailable: () => true,
            profiles: () => [profile],
            uuid,
            clock: () => NOW,
          },
          proposal,
        ),
    },
  });
  const tools = (scope: WindowId = windowId, isAutomationOrigin = false) =>
    createRoutineProposalTools({
      windowId: scope,
      thread: { id: THREAD, mode, projectId: PROJECT },
      isAutomationOrigin,
      proposals,
      now: () => NOW_MS,
    });
  return { handler, projection, proposals, thread, tools, journal, store };
}

const weeklyInput = JSON.stringify({
  name: "Monday report",
  prompt: "Summarize last week's changes in the reports folder.",
  trigger: "weekly",
  weekdays: [1],
  localTime: "09:00",
  timeZone: "Europe/Oslo",
});

async function listed(
  handler: (request: Request) => Promise<Response | undefined>,
  key = capability,
) {
  const response = await handler(
    new Request("http://127.0.0.1/api/automations/proposals", {
      headers: { "x-octant-window-capability": key },
    }),
  );
  return decodeRoutineProposalList(await response?.json()).proposals;
}

async function decide(
  handler: (request: Request) => Promise<Response | undefined>,
  proposalId: string,
  decision: "confirm" | "decline",
  key = capability,
) {
  const response = await handler(
    new Request("http://127.0.0.1/api/automations/proposals/decide", {
      method: "POST",
      headers: { "x-octant-window-capability": key, "content-type": "application/json" },
      body: JSON.stringify({ proposalId, decision }),
    }),
  );
  return decodeRoutineProposalDecisionResult(await response?.json());
}

/** Starts the tool call and waits until its proposal is listed for the window. */
async function propose(h: ReturnType<typeof harness>, input = weeklyInput) {
  const call = h.tools().execute({ name: "octant_propose_routine", inputJson: input });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const waiting = await listed(h.handler);
    const first = waiting[0];
    if (first !== undefined) return { call, proposal: first };
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The proposal never appeared.");
}

describe("routine proposals from a thread", () => {
  it("offers nothing to a Chat thread and refuses a call that names the tool anyway", async () => {
    const proposals = new RoutineProposalService({ uuid, now: () => NOW_MS });
    const chat = createRoutineProposalTools({
      windowId,
      thread: { id: THREAD, mode: "chat", projectId: PROJECT },
      isAutomationOrigin: false,
      proposals,
      now: () => NOW_MS,
    });
    expect(chat.definitions).toEqual([]);
    const outcome = await chat.execute({ name: "octant_propose_routine", inputJson: weeklyInput });
    expect(outcome).toMatchObject({ isError: true, result: { reason: "chat-has-no-routines" } });
    expect(proposals.list(windowId)).toEqual([]);
  });

  it("refuses a routine's own run with automation-recursion and shows the person nothing", async () => {
    const h = harness();
    const outcome = await h
      .tools(windowId, true)
      .execute({ name: "octant_propose_routine", inputJson: weeklyInput });
    expect(outcome).toMatchObject({ isError: true, result: { reason: "automation-recursion" } });
    expect(await listed(h.handler)).toEqual([]);
  });

  it("refuses a Code turn in Plan mode", async () => {
    const proposals = new RoutineProposalService({ uuid, now: () => NOW_MS });
    const plan = createRoutineProposalTools({
      windowId,
      thread: { id: THREAD, mode: "code", projectId: PROJECT },
      readPosture: () => "plan",
      isAutomationOrigin: false,
      proposals,
      now: () => NOW_MS,
    });
    const outcome = await plan.execute({ name: "octant_propose_routine", inputJson: weeklyInput });
    expect(outcome).toMatchObject({ isError: true, result: { reason: "plan-read-only" } });
  });

  it("creates nothing while the proposal waits, and shows it only to the window that raised it", async () => {
    const h = harness();
    const { proposal } = await propose(h);
    expect(proposal).toMatchObject({
      displayName: "Monday report",
      mode: "work",
      projectId: PROJECT,
      threadId: THREAD,
      trigger: { kind: "weekly-local", weekdays: [1], localTime: "09:00", timeZone: "Europe/Oslo" },
      missedRunPolicy: "skip",
      firstRunAt: "2026-11-02T08:00:00.000Z",
    });
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toEqual([]);
    expect(await listed(h.handler, otherCapability)).toEqual([]);
    expect(
      await decide(h.handler, String(proposal.proposalId), "confirm", otherCapability),
    ).toEqual({ kind: "routine-proposal-gone" });
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toEqual([]);
  });

  it("creates the routine on confirm, authored by the confirming window and linked to the thread", async () => {
    const h = harness();
    const { call, proposal } = await propose(h);
    const answer = await decide(h.handler, String(proposal.proposalId), "confirm");
    expect(answer.kind).toBe("routine-proposal-confirmed");
    const outcome = await call;
    if (answer.kind !== "routine-proposal-confirmed") throw new Error("not confirmed");
    const routine = answer.automation;
    expect(outcome.result).toMatchObject({
      status: "confirmed",
      routineId: String(routine.id),
    });
    expect(routine.createdBy).toEqual({
      kind: "local-window",
      windowId: String(windowId),
      capabilityGeneration: 0,
    });
    expect(routine.originThreadId).toBe(THREAD);
    expect(routine.lifecycle).toBe("enabled");
    expect(routine.authorityProfile.effective).toMatchObject({
      shell: true,
      git: true,
      network: false,
      subagents: false,
      executionPolicy: "approval-gated",
    });
    // A second answer finds nothing to act on.
    expect(await decide(h.handler, String(proposal.proposalId), "confirm")).toEqual({
      kind: "routine-proposal-gone",
    });
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toHaveLength(1);
  });

  it("keeps a confirmed Code routine asking first and session-only, like its thread", async () => {
    const h = harness({ mode: "code" });
    const { call, proposal } = await propose(h);
    const answer = await decide(h.handler, String(proposal.proposalId), "confirm");
    await call;
    if (answer.kind !== "routine-proposal-confirmed") throw new Error(JSON.stringify(answer));
    expect(answer.automation.binding).toMatchObject({
      kind: "code",
      repositoryId: REPOSITORY,
      checkoutId: CHECKOUT,
    });
    expect(answer.automation.authorityProfile.effective).toMatchObject({
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    });
    // Each run's thread is created from the execution profile, not the receipt.
    expect(answer.automation.executionProfile).toMatchObject({
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    });
  });

  it("creates nothing on decline and tells the agent it was declined", async () => {
    const h = harness();
    const { call, proposal } = await propose(h);
    expect(await decide(h.handler, String(proposal.proposalId), "decline")).toEqual({
      kind: "routine-proposal-declined",
    });
    expect((await call).result).toMatchObject({ status: "declined" });
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toEqual([]);
  });

  it("creates nothing when the thread left its Project before the person confirmed", async () => {
    const h = harness();
    const { call, proposal } = await propose(h);
    h.thread.current = undefined;
    const answer = await decide(h.handler, String(proposal.proposalId), "confirm");
    expect(answer).toMatchObject({ kind: "automation-command-failed", reason: "invalid" });
    expect((await call).result).toMatchObject({ status: "refused", reason: "not-created" });
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toEqual([]);
  });

  it("creates nothing when the proposal expires", async () => {
    const proposals = new RoutineProposalService({ uuid, now: () => NOW_MS, ttlMs: 1_000 });
    const outcome: Promise<RoutineProposalOutcome> = proposals.propose({
      windowId,
      proposal: {
        threadId: THREAD as never,
        mode: "work",
        projectId: PROJECT as never,
        displayName: "Soon",
        taskPrompt: "Check.",
        trigger: { kind: "once", scheduledAt: "2026-11-01T09:00:00.000Z" as never },
        missedRunPolicy: "skip",
        firstRunAt: "2026-11-01T09:00:00.000Z" as never,
      },
    });
    expect(await outcome).toEqual({ status: "expired" });
    expect(proposals.list(windowId)).toEqual([]);
  });

  it("rebuilds the link from the journal after a restart", async () => {
    const h = harness();
    const { call, proposal } = await propose(h);
    await decide(h.handler, String(proposal.proposalId), "confirm");
    await call;
    const rebuilt = new AutomationProjection();
    expect(hydrateAutomationProjection({ store: h.store, projection: rebuilt })).toBe("ok");
    expect(
      rebuilt.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items[0]
        ?.originThreadId,
    ).toBe(THREAD);
  });
});

const followUpInput = JSON.stringify({
  name: "Check for the reply",
  prompt: "Check whether the reply arrived and summarise it.",
  trigger: "follow-up",
  at: "2026-11-01T08:00:00Z",
});

async function followUps(
  handler: (request: Request) => Promise<Response | undefined>,
  body: unknown,
  key = capability,
) {
  const response = await handler(
    new Request("http://127.0.0.1/api/automations/follow-ups", {
      method: "POST",
      headers: { "x-octant-window-capability": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response?.status, body: await response?.json() };
}

describe("one-time follow-ups in the same thread", () => {
  it("proposes a follow-up that creates nothing until the person confirms it", async () => {
    const h = harness();
    const { call, proposal } = await propose(h, followUpInput);
    expect(proposal).toMatchObject({
      targetPolicy: "same-thread",
      trigger: { kind: "once", scheduledAt: "2026-11-01T08:00:00.000Z" },
      missedRunPolicy: "run-once",
    });
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toEqual([]);
    const answer = await decide(h.handler, String(proposal.proposalId), "confirm");
    await call;
    if (answer.kind !== "routine-proposal-confirmed") throw new Error(JSON.stringify(answer));
    expect(answer.automation).toMatchObject({
      targetPolicy: "same-thread",
      originThreadId: THREAD,
      authorityProfile: {
        effective: { shell: true, git: true, executionPolicy: "approval-gated" },
      },
    });
  });

  it("refuses a follow-up proposal from a routine's own turn", async () => {
    const h = harness();
    const outcome = await h
      .tools(windowId, true)
      .execute({ name: "octant_propose_routine", inputJson: followUpInput });
    expect(outcome).toMatchObject({ isError: true, result: { reason: "automation-recursion" } });
    expect(await listed(h.handler)).toEqual([]);
  });

  it("lets the person set one up from the thread, then move it, and never run it on demand", async () => {
    const h = harness();
    const created = await followUps(h.handler, {
      kind: "schedule-follow-up",
      threadId: THREAD,
      mode: "work",
      projectId: PROJECT,
      scheduledAt: "2026-11-01T08:00:00.000Z",
      taskPrompt: "See what changed and summarise it.",
    });
    expect(created.body).toMatchObject({
      kind: "automation-created",
      automation: {
        targetPolicy: "same-thread",
        originThreadId: THREAD,
        createdBy: { kind: "local-window", windowId: String(windowId) },
        trigger: { kind: "once", scheduledAt: "2026-11-01T08:00:00.000Z" },
      },
    });
    const automation = created.body.automation;
    const moved = await followUps(h.handler, {
      kind: "reschedule-follow-up",
      automationId: automation.id,
      expectedVersion: automation.version,
      scheduledAt: "2026-11-02T08:00:00.000Z",
    });
    expect(moved.body).toMatchObject({
      kind: "automation-updated",
      automation: { nextDueAt: "2026-11-02T08:00:00.000Z", targetPolicy: "same-thread" },
    });
    const runNow = await h.handler(
      new Request("http://127.0.0.1/api/automations/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "run-now-automation",
          automationId: automation.id,
          expectedVersion: moved.body.automation.version,
          runNowRequestId: uuid(),
        }),
      }),
    );
    expect(await runNow?.json()).toMatchObject({
      kind: "automation-command-failed",
      reason: "unsupported",
    });
  });

  it("refuses a follow-up for a Chat thread", async () => {
    const h = harness();
    const refused = await followUps(h.handler, {
      kind: "schedule-follow-up",
      threadId: THREAD,
      mode: "chat",
      projectId: PROJECT,
      scheduledAt: "2026-11-01T08:00:00.000Z",
      taskPrompt: "See what changed.",
    });
    expect(refused.status).toBe(400);
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toEqual([]);
  });

  it("refuses a routine created through the editor that claims to be a follow-up", async () => {
    const h = harness();
    const { call, proposal } = await propose(h);
    const answer = await decide(h.handler, String(proposal.proposalId), "confirm");
    await call;
    if (answer.kind !== "routine-proposal-confirmed") throw new Error(JSON.stringify(answer));
    const {
      id,
      version,
      lifecycle: _l,
      definitionRevision: _r,
      nextDueAt: _n,
      ...rest
    } = answer.automation;
    const draft = {
      displayName: rest.displayName,
      taskPrompt: rest.taskPrompt,
      hostId: rest.hostId,
      mode: rest.mode,
      projectId: rest.projectId,
      projectVersion: rest.projectVersion,
      binding: rest.binding,
      executionProfile: rest.executionProfile,
      authorityProfile: rest.authorityProfile,
      deliveryTarget: rest.deliveryTarget,
      trigger: { kind: "once", scheduledAt: "2026-11-01T08:00:00.000Z" },
      missedRunPolicy: "run-once",
      targetPolicy: "same-thread",
    };
    const send = async (body: unknown) =>
      (
        await h.handler(
          new Request("http://127.0.0.1/api/automations/commands", {
            method: "POST",
            headers: {
              "x-octant-window-capability": capability,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        )
      )?.json();
    expect(
      await send({
        kind: "update-automation",
        automationId: id,
        expectedVersion: version,
        definition: draft,
      }),
    ).toMatchObject({ kind: "automation-command-failed", reason: "invalid" });
    expect(
      await send({
        kind: "create-automation",
        automationId: uuid(),
        expectedVersion: 0,
        definition: draft,
      }),
    ).toMatchObject({ kind: "automation-command-failed" });
  });
});

async function threadRoutines(
  handler: (request: Request) => Promise<Response | undefined>,
  body: unknown,
  key = capability,
) {
  const response = await handler(
    new Request("http://127.0.0.1/api/automations/thread-routines", {
      method: "POST",
      headers: { "x-octant-window-capability": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response?.status, body: await response?.json() };
}

const manualRoutine = {
  kind: "create-thread-routine",
  threadId: THREAD,
  projectId: PROJECT,
  displayName: "Morning check",
  taskPrompt: "Summarise what changed overnight.",
  trigger: {
    kind: "weekly-local",
    weekdays: [1, 2, 3, 4, 5],
    localTime: "09:00",
    timeZone: "Europe/Oslo",
  },
  missedRunPolicy: "skip",
};

describe("routines a person creates from a thread's Environment", () => {
  it("creates a Work routine in the thread's Project and mode, authored by the window", async () => {
    const h = harness();
    const created = await threadRoutines(h.handler, { ...manualRoutine, mode: "work" });
    expect(created.body).toMatchObject({
      kind: "automation-created",
      automation: {
        mode: "work",
        projectId: PROJECT,
        binding: { kind: "work", projectId: PROJECT },
        originThreadId: THREAD,
        targetPolicy: "new-thread",
        missedRunPolicy: "skip",
        createdBy: { kind: "local-window", windowId: String(windowId) },
        authorityProfile: {
          effective: { shell: true, git: true, executionPolicy: "approval-gated" },
        },
      },
    });
  });

  it("creates a Code routine on the thread's checkout that asks before effects", async () => {
    const h = harness({ mode: "code" });
    const created = await threadRoutines(h.handler, { ...manualRoutine, mode: "code" });
    expect(created.body).toMatchObject({
      kind: "automation-created",
      automation: {
        mode: "code",
        binding: { kind: "code", repositoryId: REPOSITORY, checkoutId: CHECKOUT },
        executionProfile: { executionPolicy: "approval-gated" },
        originThreadId: THREAD,
      },
    });
  });

  it("refuses a routine for a Project the thread is not in, and for Chat", async () => {
    const h = harness();
    const elsewhere = await threadRoutines(h.handler, {
      ...manualRoutine,
      mode: "work",
      projectId: "bb000000-0000-4000-8000-0000000000ff",
    });
    expect(elsewhere.body).toMatchObject({ kind: "automation-command-failed" });
    const chat = await threadRoutines(h.handler, { ...manualRoutine, mode: "chat" });
    expect(chat.status).toBe(400);
    expect(
      h.projection.listSummaries({ hostId: "local" as never, mode: "all", limit: 10 }).items,
    ).toEqual([]);
  });
});
