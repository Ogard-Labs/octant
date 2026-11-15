import {
  decodeCodeThread,
  decodeWindowId,
  type CodeCommand,
  type CodeSettings,
  type CodeThread,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
  type Project,
} from "@octant/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../persistence/migrations";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createCoordinatorCountStore } from "./coordinatorCountStore";
import { CoordinatorService, type CoordinatorServicePorts } from "./coordinatorService";
import type { CoordinatorCandidateFacts } from "./coordinatorWorkerFacts";

const now = "2026-11-15T12:00:00.000Z";
const PROJECT = "40000000-0000-4000-8000-000000000001";
const COORDINATOR = "20000000-0000-4000-8000-000000000001";
const EARLIER = "20000000-0000-4000-8000-000000000002";
const NEW_WORKER = "20000000-0000-4000-8000-0000000000aa";
const ANTHROPIC = "60000000-0000-4000-8000-000000000001";
const OPENAI = "60000000-0000-4000-8000-000000000002";
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const PROMPT = "Find and fix the flaky test in the payments package.";

function candidate(provider: string, modelId: string): NativeHarnessSlotCandidate {
  return {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    providerInstanceId: provider,
    modelId,
  } as never;
}
const sonnet = candidate(ANTHROPIC, "sonnet");
const opus = candidate(ANTHROPIC, "opus");
const haiku = candidate(ANTHROPIC, "haiku");
const astra = candidate(OPENAI, "astra");

function slot(
  id: string,
  candidates: ReadonlyArray<NativeHarnessSlotCandidate>,
  askBeforeUsing?: true,
): NativeHarnessSlot {
  return {
    id: id as never,
    candidates,
    ...(askBeforeUsing === undefined ? {} : { askBeforeUsing }),
  } as NativeHarnessSlot;
}

function codeThread(id: string, overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id,
    projectId: PROJECT,
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "A title an agent wrote",
    lifecycle: "active",
    providerInstanceId: ANTHROPIC,
    modelId: "coordinator-model",
    executionPolicy: "auto-accept-edits",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/coordinate",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

const directories: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function countStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-coordinator-choice-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite"));
  connections.push(connection);
  const migration = MIGRATIONS.find((entry) => entry.name === "create_coordinator_count_store");
  if (migration === undefined) throw new Error("The coordinator count migration is missing.");
  connection.exec(migration.sql);
  return createCoordinatorCountStore(connection);
}

function harness(
  slots: ReadonlyArray<NativeHarnessSlot>,
  options: { readonly seesImagesAvailable?: () => boolean } = {},
) {
  const threads = new Map<string, CodeThread>([
    [COORDINATOR, codeThread(COORDINATOR, { coordinator: true, messageWake: true })],
  ]);
  const executed: Array<{ readonly command: CodeCommand; readonly context: unknown }> = [];
  const hostTurns: Array<{ readonly threadId: string; readonly prompt: string }> = [];
  const proposals: Array<{ readonly workerOptions: Record<string, unknown> }> = [];
  const downMarks: string[] = [];
  const moves: Array<{
    readonly workerId: string;
    readonly model: { readonly providerInstanceId: unknown; readonly modelId: unknown };
    readonly choice: unknown;
  }> = [];
  const facts = new Map<string, Partial<CoordinatorCandidateFacts>>();
  const failedFirstTurns = new Set<string>();
  const marked = new Set<string>();
  let turnCount = 0;
  const self = {
    slots,
    settings: undefined as CodeSettings | undefined,
    latest: new Map<string, string>(),
  };
  const ports: CoordinatorServicePorts = {
    readThread: (id) => threads.get(id),
    readThreads: () => [...threads.values()],
    readProject: () => ({ id: PROJECT, type: "code", lifecycle: "active" }) as never as Project,
    readSettings: () => self.settings,
    isDesignatedPlanner: () => false,
    isMarked: (id) => marked.has(id),
    threadState: () => "idle",
    latestTurnId: (id) => self.latest.get(id),
    providerKnown: () => true,
    executeCode: async (_window, command, context) => {
      executed.push({ command, context });
      if (command.kind === "prepare-code-project-checkout") {
        return {
          kind: "checkout-prepared",
          bindingRevisionId: "70000000-0000-4000-8000-000000000001",
        } as never;
      }
      if (command.kind === "create-managed-code-thread") {
        threads.set(
          String(command.threadId),
          codeThread(String(command.threadId), {
            coordinatorThreadId: COORDINATOR,
            providerInstanceId: command.providerInstanceId,
            modelId: command.modelId,
          }),
        );
        return { kind: "managed-thread-created" } as never;
      }
      throw new Error("unexpected command");
    },
    startHostTurn: async (threadId, prompt) => {
      turnCount += 1;
      hostTurns.push({ threadId: String(threadId), prompt });
      const operationId = `turn-${String(turnCount)}`;
      self.latest.set(String(threadId), operationId);
      return { status: "started", operationId };
    },
    propose: (_coordinator, _draft, workerOptions) => {
      proposals.push({ workerOptions: { ...workerOptions } });
      return { status: "proposed", proposalId: "proposal-1" };
    },
    readRoles: () => ({ host: { slots: self.slots, jobSlots: [] } }),
    candidateFacts: (_project, model) => ({
      label: `${String(model.modelId)} name`,
      providerKind: String(model.providerInstanceId) === OPENAI ? "codex" : "claude-code",
      providerName: String(model.providerInstanceId) === OPENAI ? "OpenAI" : "Anthropic",
      allowed: true,
      toolsVerified: true,
      readsImages: true,
      contextTokens: 200_000,
      ...facts.get(String(model.modelId)),
    }),
    ...(options.seesImagesAvailable === undefined
      ? {}
      : { seesImagesAvailable: options.seesImagesAvailable }),
    markProviderDown: (id) => downMarks.push(id),
    moveWorkerToModel: async (worker, model, choice) => {
      moves.push({ workerId: String(worker.id), model, choice });
      threads.set(String(worker.id), {
        ...worker,
        providerInstanceId: model.providerInstanceId,
        modelId: model.modelId,
        coordinatorChoice: choice,
      });
      return "moved";
    },
    firstTurnFailedBeforeWork: (_worker, operationId) => failedFirstTurns.has(operationId),
    counts: countStore(),
    uuid: () => NEW_WORKER,
    now: () => Date.parse(now),
  };
  return Object.assign(self, {
    service: new CoordinatorService(ports),
    threads,
    executed,
    hostTurns,
    proposals,
    downMarks,
    moves,
    facts,
    failedFirstTurns,
    marked,
  });
}

const standardRoles = [
  slot("quick", [haiku]),
  slot("default", [sonnet, astra]),
  slot("deep", [opus, astra]),
  slot("slow", [sonnet, astra]),
];

function start(fields: Record<string, unknown>) {
  return {
    callerThreadId: COORDINATOR,
    windowId,
    fields: { operation: "start", title: "Fix the flaky test", prompt: PROMPT, ...fields },
    profileAllowsStart: true,
  };
}

function created(h: ReturnType<typeof harness>) {
  return h.executed.find((entry) => entry.command.kind === "create-managed-code-thread");
}

describe("choosing a worker's model from the roles", () => {
  it("refuses raw provider and model ids once roles are set up, and creates nothing", async () => {
    const h = harness(standardRoles);
    const answer = await h.service.start(
      start({ task: "feature", size: "normal", providerInstanceId: OPENAI, modelId: "astra" }),
    );
    expect(answer.isError).toBe(true);
    expect(answer.result).toMatchObject({ status: "refused", reason: "policy" });
    expect(String((answer.result as { message: string }).message)).toContain("b1");
    expect(created(h)).toBeUndefined();
  });

  it("keeps today's rule with no roles: the worker runs on the coordinator's own model", async () => {
    const h = harness([slot("deep", [opus])]);
    const answer = await h.service.start(start({}));
    expect(answer.isError).toBe(false);
    expect(created(h)?.command).toMatchObject({
      providerInstanceId: ANTHROPIC,
      modelId: "coordinator-model",
    });
    expect(created(h)?.context).toEqual({ coordinatorThreadId: COORDINATOR });
  });

  it("asks for task and size once roles are set up", async () => {
    const h = harness(standardRoles);
    const answer = await h.service.start(start({}));
    expect(answer.result).toMatchObject({ status: "refused", reason: "policy" });
    expect(created(h)).toBeUndefined();
  });

  it("starts the role's main model and journals the choice on the worker, never the prompt", async () => {
    const h = harness(standardRoles);
    const answer = await h.service.start(start({ task: "feature", size: "normal" }));
    expect(answer.result).toMatchObject({
      status: "started",
      model: "sonnet name",
      role: "Builder",
    });
    expect(created(h)?.command).toMatchObject({ providerInstanceId: ANTHROPIC, modelId: "sonnet" });
    expect(created(h)?.context).toEqual({
      coordinatorThreadId: COORDINATOR,
      coordinatorChoice: { role: "default", rank: "main" },
    });
    expect(JSON.stringify(created(h)?.context)).not.toContain(PROMPT);
  });

  it("starts the fallback when the main model is at its usage limit and records why", async () => {
    const h = harness(standardRoles);
    h.facts.set("sonnet", { usageLimit: { until: "2026-11-15T14:00:00.000Z" } });
    await h.service.start(start({ task: "feature", size: "normal" }));
    expect(created(h)?.command).toMatchObject({ providerInstanceId: OPENAI, modelId: "astra" });
    expect(created(h)?.context).toMatchObject({
      coordinatorChoice: {
        role: "default",
        rank: { fallback: 1 },
        reason: "main sonnet name at usage limit until 14:00 UTC",
      },
    });
  });

  it("records the coordinator's why for an override", async () => {
    const h = harness(standardRoles);
    await h.service.start(
      start({
        task: "feature",
        size: "normal",
        role: "hard-problems",
        why: "touches three packages",
      }),
    );
    expect(created(h)?.context).toMatchObject({
      coordinatorChoice: { role: "deep", rank: "main", why: "touches three packages" },
    });
  });

  it("refuses with every model's reason and the role card when nothing is eligible", async () => {
    const h = harness(standardRoles);
    for (const id of ["sonnet", "astra", "opus"]) h.facts.set(id, { notReady: "provider-down" });
    const answer = await h.service.start(start({ task: "feature", size: "normal" }));
    expect(answer.result).toMatchObject({ status: "refused", reason: "no-eligible-model" });
    const message = String((answer.result as { message: string }).message);
    expect(message).toContain("sonnet name provider down");
    expect(message).toContain("Builder (builder): b1 sonnet name (Anthropic)");
    expect(created(h)).toBeUndefined();
  });

  it("refuses a named model that is not eligible, with its reason", async () => {
    const h = harness(standardRoles);
    h.facts.set("astra", { notReady: "not-signed-in" });
    const answer = await h.service.start(
      start({ task: "feature", size: "normal", model: "b2", why: "long context" }),
    );
    expect(answer.result).toMatchObject({ status: "refused", reason: "model-not-eligible" });
    expect(String((answer.result as { message: string }).message)).toContain(
      "astra name not signed in",
    );
  });

  it("turns a start in an ask-first role into a proposal even under Start without asking", async () => {
    const h = harness([slot("default", [sonnet]), slot("deep", [opus], true)]);
    const answer = await h.service.start(
      start({ task: "feature", size: "hard", why: "a race across two services" }),
    );
    expect(answer.result).toMatchObject({ status: "proposed" });
    expect(created(h)).toBeUndefined();
    expect(h.proposals[0]?.workerOptions).toMatchObject({
      providerInstanceId: ANTHROPIC,
      modelId: "opus",
      modelName: "opus name",
      choice: { role: "deep", rank: "main" },
    });
  });

  it("climbs one tier for a retry of an earlier worker", async () => {
    const h = harness(standardRoles);
    h.threads.set(
      EARLIER,
      codeThread(EARLIER, {
        coordinatorThreadId: COORDINATOR,
        coordinatorChoice: { role: "default", rank: "main" },
      }),
    );
    await h.service.start(start({ task: "feature", size: "normal", retries: EARLIER }));
    expect(created(h)?.context).toMatchObject({ coordinatorChoice: { role: "deep" } });
    const stranger = await h.service.start(
      start({ task: "feature", size: "normal", retries: "20000000-0000-4000-8000-0000000000ff" }),
    );
    expect(stranger.result).toMatchObject({ status: "refused", reason: "policy" });
  });

  it("starts a review on another provider than the reviewed worker", async () => {
    const h = harness(standardRoles);
    h.threads.set(
      EARLIER,
      codeThread(EARLIER, { coordinatorThreadId: COORDINATOR, modelId: "sonnet" }),
    );
    await h.service.start(start({ task: "review", size: "normal", reviews: EARLIER }));
    expect(created(h)?.command).toMatchObject({ providerInstanceId: OPENAI });
  });

  it("starts the same worker on the next model when its first request failed before any work", async () => {
    const h = harness(standardRoles);
    await h.service.start(start({ task: "feature", size: "normal" }));
    h.failedFirstTurns.add("turn-1");
    await h.service.sweep();
    expect(h.downMarks).toEqual([ANTHROPIC]);
    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]?.model).toMatchObject({ providerInstanceId: OPENAI, modelId: "astra" });
    expect(h.moves[0]?.choice).toMatchObject({ role: "default", rank: { fallback: 1 } });
    expect(JSON.stringify(h.moves[0]?.choice)).toContain(
      "first request on sonnet name failed before any work",
    );
    expect(h.hostTurns).toEqual([
      { threadId: NEW_WORKER, prompt: PROMPT },
      { threadId: NEW_WORKER, prompt: PROMPT },
    ]);
  });

  it("leaves a worker whose first turn did work on its model", async () => {
    const h = harness(standardRoles);
    await h.service.start(start({ task: "feature", size: "normal" }));
    await h.service.sweep();
    expect(h.moves).toEqual([]);
  });

  it("moves again when the next model's first request also fails, and stops when none is left", async () => {
    const h = harness(standardRoles);
    await h.service.start(start({ task: "feature", size: "normal" }));
    h.failedFirstTurns.add("turn-1");
    await h.service.sweep();
    h.failedFirstTurns.add("turn-2");
    await h.service.sweep();
    // Builder's list is spent, so the worker borrows Hard problems.
    expect(h.moves.map((move) => move.model.modelId)).toEqual(["astra", "opus"]);
    // Every model of the roles has failed once: the worker stays for the
    // coordinator and the person.
    h.failedFirstTurns.add("turn-3");
    await h.service.sweep();
    await h.service.sweep();
    expect(h.moves).toHaveLength(2);
    expect(h.hostTurns.filter((turn) => turn.threadId === NEW_WORKER)).toHaveLength(3);
  });

  it("leaves a worker whose model a person changed after its first request failed", async () => {
    const h = harness(standardRoles);
    await h.service.start(start({ task: "feature", size: "normal" }));
    const worker = h.threads.get(NEW_WORKER);
    if (worker === undefined) throw new Error("no worker");
    h.threads.set(NEW_WORKER, {
      ...worker,
      providerInstanceId: OPENAI as never,
      modelId: "astra" as never,
    });
    h.failedFirstTurns.add("turn-1");
    await h.service.sweep();
    expect(h.moves).toEqual([]);
    expect(h.downMarks).toEqual([]);
    expect(h.hostTurns.filter((turn) => turn.threadId === NEW_WORKER)).toHaveLength(1);
  });

  it("leaves a worker a person closed after its first request failed", async () => {
    const h = harness(standardRoles);
    await h.service.start(start({ task: "feature", size: "normal" }));
    const worker = h.threads.get(NEW_WORKER);
    if (worker === undefined) throw new Error("no worker");
    h.threads.set(NEW_WORKER, { ...worker, lifecycle: "archived" });
    h.failedFirstTurns.add("turn-1");
    await h.service.sweep();
    expect(h.moves).toEqual([]);
  });

  it("writes a role card of host facts after the roster, with no agent-written text", async () => {
    const h = harness(standardRoles);
    h.facts.set("haiku", { usageLimit: { until: "2026-11-15T14:00:00.000Z" } });
    await h.service.start(start({ task: "feature", size: "normal" }));
    const context = h.service.contextFor(COORDINATOR) ?? "";
    expect(context).toContain("Model roles, written by Octant from its own facts");
    expect(context).toContain(
      "Builder (builder): b1 sonnet name (Anthropic) 200k images:yes ready · fallback b2 astra name (OpenAI) 200k images:yes ready",
    );
    expect(context).toContain(
      "Quick edit (quick-edit): b3 haiku name (Anthropic) 200k images:yes at limit until 14:00 UTC",
    );
    expect(context).toContain(
      "Track record (this coordinator, last 20): b1 1 started, 0 Done, 0 closed without Done",
    );
    expect(context).not.toContain("A title an agent wrote");
    expect(context).not.toContain(PROMPT);
    expect(h.marked.size).toBe(0);
  });

  it("chooses again in the Builder role for Use Builder instead", () => {
    const h = harness([slot("default", [sonnet]), slot("deep", [opus], true)]);
    expect(h.service.rechooseAsBuilder(COORDINATOR)).toEqual({
      status: "chosen",
      resolved: {
        providerInstanceId: ANTHROPIC,
        modelId: "sonnet",
        choice: { role: "default", rank: "main" },
        modelName: "sonnet name",
      },
    });
  });

  it("keeps a review off the reviewed provider and images readable for Use Builder instead", () => {
    const h = harness([slot("default", [sonnet, astra]), slot("slow", [opus], true)]);
    expect(
      h.service.rechooseAsBuilder(COORDINATOR, { reviewedProviderKind: "claude-code" }),
    ).toMatchObject({ status: "chosen", resolved: { modelId: "astra" } });
    h.facts.set("sonnet", { readsImages: false });
    expect(h.service.rechooseAsBuilder(COORDINATOR, { needsImages: true })).toMatchObject({
      status: "chosen",
      resolved: { modelId: "astra" },
    });
  });

  it("lets image work reach a builder that cannot read images only while Sees images can describe one", () => {
    const able = harness([slot("default", [sonnet]), slot("vision", [haiku])], {
      seesImagesAvailable: () => true,
    });
    able.facts.set("sonnet", { readsImages: false });
    expect(able.service.rechooseAsBuilder(COORDINATOR, { needsImages: true })).toMatchObject({
      status: "chosen",
      resolved: { modelId: "sonnet" },
    });
    // The role lists a model, but the host cannot send it an image now.
    const unable = harness([slot("default", [sonnet]), slot("vision", [haiku])], {
      seesImagesAvailable: () => false,
    });
    unable.facts.set("sonnet", { readsImages: false });
    expect(unable.service.rechooseAsBuilder(COORDINATOR, { needsImages: true })).not.toMatchObject({
      status: "chosen",
    });
  });

  it("keeps the request's filters on an ask-first proposal", async () => {
    const h = harness([slot("default", [sonnet]), slot("slow", [astra], true)]);
    h.threads.set(EARLIER, codeThread(EARLIER, { coordinatorThreadId: COORDINATOR }));
    await h.service.start(
      start({ task: "review", size: "normal", reviews: EARLIER, needsImages: true }),
    );
    expect(h.proposals[0]?.workerOptions).toMatchObject({
      needsImages: true,
      reviewedProviderKind: "claude-code",
    });
  });
});
