import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  decodeAgentRunParentThreadId,
  decodeEventActor,
  decodeNativeHarnessRoutingSettings,
  decodeNativeHarnessSlotCandidate,
  decodeProviderInstanceId,
  decodeProviderRuntimeEvent,
  decodeProviderServiceLimits,
  decodeToolActionAuthority,
  decodeWindowId,
  type AgentRunAuthority,
  type AgentRunResultDeliveryMark,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import type {
  ProviderAcquireInput,
  ProviderDriver,
  ProviderSessionResume,
  ProviderSessionStart,
} from "@octant/provider-sdk/driver";
import { makeProviderCapacityScheduler } from "../context/contextRuntime";
import { createNativeHarnessDelegatePort } from "../harness/nativeHarnessDelegatePort";
import { createNativeHarnessConnection } from "../harness/nativeHarnessLoop";
import { NativeHarnessRouter } from "../harness/nativeHarnessRouter";
import { NativeHarnessSessionStore } from "../harness/nativeHarnessSessionStore";
import { createNativeHarnessTools } from "../harness/nativeHarnessTools";
import { MemoryNativeHarnessTranscriptStore } from "../harness/nativeHarnessTranscriptStore";
import type { NativeHarnessRequest } from "../harness/nativeHarnessTransport";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  AgentResultDeliveryService,
  type AgentResultDeliveryModePort,
} from "./agentResultDeliveryService";
import { agentResultDeliveryBatchPrompt } from "./agentResultDeliveryPrompt";
import { validateAgentResultDelivery } from "./agentResultDeliveryBatch";
import type { AgentRunControlAdmissionDependencies } from "./agentRunControlAdmission";
import { AgentRunEventStore } from "./agentRunEventStore";
import { AgentRunLiveConversationStore } from "./agentRunLiveConversationStore";
import { createAgentsManagedTools } from "./agentRunManagedTools";
import {
  AgentRunOrchestrationService,
  createInMemoryCapacityPort,
} from "./agentRunOrchestrationService";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProjection } from "./agentRunProjection";
import { createAgentRunRouteHandler } from "./agentRunRoutes";
import {
  createAgentRunSessionRuntime,
  createRecordedAgentRunContextSnapshotPort,
  type AgentRunSessionRuntimeOptions,
} from "./agentRunSessionRuntime";
import { AgentRunSessionStore } from "./agentRunSessionStore";
import { AgentRunSessionSupervisor } from "./agentRunSessionSupervisor";

const now = "2026-10-03T12:00:00.000Z";
const ids = {
  thread: decodeAgentRunParentThreadId("10000000-0000-4000-8000-000000000001"),
  foreignThread: decodeAgentRunParentThreadId("10000000-0000-4000-8000-000000000002"),
  window: decodeWindowId("10000000-0000-4000-8000-000000000003"),
  foreignWindow: decodeWindowId("10000000-0000-4000-8000-000000000004"),
  octant: decodeProviderInstanceId("10000000-0000-4000-8000-000000000005"),
  provider: decodeProviderInstanceId("10000000-0000-4000-8000-000000000006"),
};
type Harness = "Octant Harness" | "provider harness";
const candidates = {
  "Octant Harness": decodeNativeHarnessSlotCandidate({
    hostId: "local",
    providerInstanceId: ids.octant,
    modelId: "fixture-direct",
  }),
  "provider harness": decodeNativeHarnessSlotCandidate({
    hostId: "local",
    providerInstanceId: ids.provider,
    modelId: "fixture-provider",
  }),
};
const liveAuthority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: true,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

/**
 * Fixture transports only: no vendor process, credentials, or network. Direct
 * endpoint children use Octant's real loop; the provider-owned driver emits
 * normalized events at the SDK seam. Both hold their replies until released so
 * sibling admission and separate session identity are observable concurrently.
 */
function fixtureDriver(harness: Harness, released: Promise<void>) {
  const acquired: ProviderAcquireInput[] = [];
  const started: ProviderSessionStart[] = [];
  const resumed: ProviderSessionResume[] = [];
  const requests: NativeHarnessRequest[] = [];
  const transcripts = new MemoryNativeHarnessTranscriptStore();
  const target = candidates[harness];
  const driver: ProviderDriver = {
    kind: harness === "Octant Harness" ? "openai-compatible" : "codex",
    conversationOwnership: harness === "Octant Harness" ? "host" : "provider",
    probe: () => Effect.die("Fixture readiness is supplied by the host; probing is unexpected."),
    acquire: (input) => {
      acquired.push(input);
      if (harness === "Octant Harness")
        return createNativeHarnessConnection({
          instanceId: input.instanceId,
          driverKind: "openai-compatible",
          projectRoot: input.projectRoot,
          mode: "chat",
          transcripts,
          admitTurn: () => undefined,
          clock: () => now,
          correlationId: randomUUID,
          transport: {
            open: async () => ({
              fits: () => true,
              send: async (request, stream) => {
                requests.push({
                  ...request,
                  history: request.history.map((message) => ({ ...message })),
                });
                await released;
                const text = `Fixture direct reply: ${request.history.at(-1)?.text}`;
                stream.onEvent({ kind: "text-delta", text });
                stream.onEvent({ kind: "usage", inputTokens: 20, outputTokens: 10 });
                return { text, toolCalls: [] };
              },
              release: () => undefined,
            }),
          },
        }).pipe(
          Effect.map((connection) => ({
            ...connection,
            start: (start: ProviderSessionStart) => {
              started.push(start);
              return connection.start(start);
            },
            resume: (input: ProviderSessionResume) => {
              resumed.push(input);
              return connection.resume(input);
            },
          })),
        );
      return Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        return {
          subscribe: Effect.succeed(Stream.fromQueue(queue)),
          start: (start: ProviderSessionStart) => {
            started.push(start);
            return Effect.succeed({
              sessionId: start.sessionId,
              resumeCursor: { driverKind: "codex" as const, value: "fixture-native-session" },
            });
          },
          resume: (input: ProviderSessionResume) => {
            resumed.push(input);
            return Effect.succeed({ sessionId: input.sessionId, resumeCursor: input.resumeCursor });
          },
          send: (turn) =>
            Effect.promise(() => released).pipe(
              Effect.flatMap(() =>
                Queue.offerAll(queue, [
                  decodeProviderRuntimeEvent({
                    kind: "text-delta",
                    instanceId: target.providerInstanceId,
                    sessionId: turn.sessionId,
                    sequence: 1,
                    correlationId: randomUUID(),
                    occurredAt: now,
                    text: `Fixture provider reply: ${turn.prompt}`,
                  }),
                  decodeProviderRuntimeEvent({
                    kind: "usage",
                    instanceId: target.providerInstanceId,
                    sessionId: turn.sessionId,
                    sequence: 2,
                    correlationId: randomUUID(),
                    occurredAt: now,
                    inputTokens: 20,
                    outputTokens: 10,
                  }),
                  decodeProviderRuntimeEvent({
                    kind: "completed",
                    instanceId: target.providerInstanceId,
                    sessionId: turn.sessionId,
                    sequence: 3,
                    correlationId: randomUUID(),
                    occurredAt: now,
                  }),
                ]),
              ),
              Effect.asVoid,
            ),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.die("No fixture approval is granted."),
          answerUserInput: () => Effect.die("No fixture answer is supplied."),
          answerTool: () => Effect.die("These fixture children do not invoke tools."),
        } satisfies import("@octant/provider-sdk/driver").ProviderConnection;
      });
    },
  };
  return { driver, acquired, started, resumed, requests };
}

function fixture(
  parentHarness: Harness,
  childHarness: Harness,
  spendCeiling?: AgentRunSessionRuntimeOptions["spendCeiling"],
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-cross-harness-"));
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => now,
  });
  const actor = decodeEventActor({ kind: "local-user", actorId: ids.window });
  const persistence = new AgentRunPersistenceService({
    store: new AgentRunEventStore({ journal, actor, uuid: randomUUID }),
    projection: new AgentRunProjection(),
    connection,
    uuid: randomUUID,
    clock: () => now,
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const direct = fixtureDriver("Octant Harness", released);
  const provider = fixtureDriver("provider harness", released);
  const sessionStore = new AgentRunSessionStore({
    connection,
    getById: (id) => persistence.getById(id),
  });
  const providerCapacity = makeProviderCapacityScheduler({
    now: () => Date.parse(now),
    random: () => 0.5,
    maxRetryJitterMs: 0,
    ambiguousReservationTtlMs: 60_000,
  });
  const runtime = createAgentRunSessionRuntime({
    resolveDriver: (id) =>
      String(id) === String(ids.octant)
        ? direct.driver
        : String(id) === String(ids.provider)
          ? provider.driver
          : undefined,
    sessionStore: sessionStore.sessions,
    supportsResume: (id) =>
      String(id) === String(ids.provider) || String(id) === String(ids.octant),
    ...(spendCeiling === undefined ? {} : { spendCeiling }),
    capacityScheduler: providerCapacity,
    context: createRecordedAgentRunContextSnapshotPort({
      getById: (id) => persistence.getById(id),
      readAdmittedContext: () => undefined,
    }),
    scratchRoot: () => directory,
    uuid: randomUUID,
    timeoutMs: 5_000,
    serviceLimits: ({ providerInstanceId }) =>
      decodeProviderServiceLimits({
        providerInstanceId,
        scope: "provider-instance",
        requests: { status: "unavailable" },
        tokens: { status: "unavailable" },
        concurrency: { status: "available", limit: 2, remaining: 2 },
        retry: { status: "inactive" },
        quota: "unknown",
        source: "runtime-reported",
        confidence: "medium",
        updatedAt: now,
      }),
  });
  const supervisor = new AgentRunSessionSupervisor({
    port: runtime,
    onSessionSettled: (input) => orchestration.onSessionSettled(input),
  });
  const orchestration = new AgentRunOrchestrationService({
    persistence,
    processes: supervisor,
    capacity: createInMemoryCapacityPort(),
    worktree: { isVerifiedIsolation: () => false, isParentCheckout: () => true },
    approvals: { isCurrent: () => true },
  });
  const parent = candidates[parentHarness];
  const target = candidates[childHarness];
  const authorizeCreation: AgentRunControlAdmissionDependencies["authorizeCreation"] = ({
    windowId,
    parentThreadId,
  }) =>
    windowId === String(ids.window) && String(parentThreadId) === String(ids.thread)
      ? {
          parentMode: "chat",
          parentAuthority: { ...liveAuthority, network: true },
          liveAuthority,
          workspaceParent: { threadId: String(ids.thread), mode: "chat" },
          parentRoute: { providerInstanceId: parent.providerInstanceId, modelId: parent.modelId },
        }
      : undefined;
  const admission: AgentRunControlAdmissionDependencies = {
    persistence,
    orchestration,
    uuid: randomUUID,
    authorizeCreation,
    settings: { current: () => ({ creationPosture: "automatic" }) },
    providerReadiness: {
      isReady: ({ providerInstanceId }) =>
        [String(ids.octant), String(ids.provider)].includes(String(providerInstanceId)),
    },
    nativeEvidence: () => ({
      claimedNativeSupport: "unsupported",
      workspace: false,
      authority: false,
      observability: false,
      cancellation: false,
      steering: false,
      recovery: false,
    }),
  };
  const settings = decodeNativeHarnessRoutingSettings({
    configuration: { slots: [{ id: "default", candidates: [parent] }], jobSlots: [] },
    version: 1,
    updatedAt: now,
  });
  const router = new NativeHarnessRouter({
    store: { host: () => settings, projectOverride: () => undefined },
    isReady: () => true,
  });
  const sessions = new NativeHarnessSessionStore({
    journal,
    actor,
    uuid: randomUUID,
    clock: () => now,
  });
  const common = {
    admission,
    orchestration,
    persistence,
    mode: "chat" as const,
    parentThreadId: String(ids.thread),
    windowId: String(ids.window),
    uuid: randomUUID,
    listTargets: () => [
      {
        providerInstanceId: String(ids.octant),
        modelIds: ["fixture-direct"],
        displayName: "Fixture direct",
        driverKind: "openai-compatible",
      },
      {
        providerInstanceId: String(ids.provider),
        modelIds: ["fixture-provider"],
        displayName: "Fixture provider",
        driverKind: "codex",
      },
    ],
  };
  const granted = decodeToolActionAuthority({
    hostId: "10000000-0000-4000-8000-000000000007",
    mode: "chat",
    providerInstanceId: parent.providerInstanceId,
    extension: { kind: "core" },
  });
  const tools =
    parentHarness === "Octant Harness"
      ? createNativeHarnessTools({
          threadId: String(ids.thread),
          mode: "chat",
          uuid: randomUUID,
          resolveAuthority: () => granted,
          authority: new ToolCallAuthorityService({
            resolveGrantedAuthority: () => granted,
            resolveLiveFacts: () => ({
              providerAppManagedTools: "supported",
              host: { computerUseEnabled: false },
              executionPolicy: "plan",
              approvalSatisfied: false,
              externalContentIngested: false,
            }),
          }),
          ports: {
            delegate: createNativeHarnessDelegatePort(
              { ...common, router, sessions },
              { ...common, lead: parent },
            ),
          },
        })
      : createAgentsManagedTools({
          ...common,
          isTainted: () => false,
          authorizeCancel: () => true,
        });

  // The parent admission port is a fixture sink. Actual mode turn admission,
  // journaled parent marks, crash recovery and dedup are covered by the mode
  // suites; this test follows real child execution through delivery settlement.
  const deliveries: Array<{
    readonly parent: string;
    readonly mark: AgentRunResultDeliveryMark;
    readonly prompt: string;
  }> = [];
  const deliveryPort: AgentResultDeliveryModePort = {
    inspect: async (run) =>
      String(run.parentThreadId) === String(ids.thread)
        ? { kind: "ready" }
        : { kind: "invalid", detail: "Foreign fixture parent" },
    dispatch: async (runs) => {
      const first = runs[0];
      if (first === undefined) throw new Error("Empty fixture delivery");
      const mark: AgentRunResultDeliveryMark = {
        kind: "agent-result",
        runId: first.id,
        runIds: runs.map((run) => run.id),
        runGenerations: runs.map((run) => ({ runId: run.id, generation: run.generation ?? 1 })),
      };
      const validated = validateAgentResultDelivery({
        delivery: mark,
        threadId: String(ids.thread),
        mode: "chat",
        getById: (id) => persistence.getById(id),
      });
      if (validated.kind !== "valid") throw new Error(validated.detail);
      deliveries.push({
        parent: String(ids.thread),
        mark,
        prompt: agentResultDeliveryBatchPrompt(runs, (id) => persistence.resultText(id)),
      });
      return {
        kind: "dispatched",
        runIds: mark.runIds ?? [mark.runId],
        runGenerations: mark.runGenerations,
      };
    },
  };
  const delivery = new AgentResultDeliveryService({
    journal,
    agentRuns: persistence,
    ports: { chat: deliveryPort, work: deliveryPort, code: deliveryPort },
    clock: () => new Date(now),
  });
  const windows = new WindowAuthorityStore();
  const tokens = {
    own: randomBytes(32).toString("base64url"),
    foreign: randomBytes(32).toString("base64url"),
  };
  windows.register({ windowId: ids.window, capability: tokens.own, now: Date.parse(now) });
  windows.register({
    windowId: ids.foreignWindow,
    capability: tokens.foreign,
    now: Date.parse(now),
  });
  const route = createAgentRunRouteHandler({
    listTargets: common.listTargets,
    windowAuthorityStore: windows,
    persistence,
    orchestration,
    liveConversations: new AgentRunLiveConversationStore(),
    authorizeCreation,
    authorizeCancellation: () => false,
    authorizeParentThread: ({ parentThreadId, windowId }) =>
      String(parentThreadId) === String(ids.thread) && windowId === String(ids.window),
    resolveCenterContext: () => ({ parentThreadTitle: "Fixture parent" }),
    now: () => Date.parse(now),
  });
  return {
    persistence,
    runtime,
    orchestration,
    providerCapacity,
    sessionStore,
    journalRows: () =>
      connection.prepare("SELECT * FROM event_journal ORDER BY global_sequence").all(),
    resume: (runId: string, expectedVersion: number, message: string) =>
      route(
        new Request("http://127.0.0.1/api/agent-runs/resume", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": tokens.own },
          body: JSON.stringify({ runId, expectedVersion, message }),
        }),
      ),
    direct,
    provider,
    deliveries,
    delivery,
    target,
    release,
    delegate: (task: string) =>
      tools.execute({
        name: parentHarness === "Octant Harness" ? "delegate" : "octant_agents",
        inputJson: JSON.stringify({
          operation: parentHarness === "Octant Harness" ? "start" : "delegate",
          role: "research",
          task,
          providerInstanceId: target.providerInstanceId,
          modelId: target.modelId,
        }),
      }),
    followUp: (runId: string, expectedVersion: number, message: string) =>
      tools.execute({
        name: parentHarness === "Octant Harness" ? "delegate" : "octant_agents",
        inputJson: JSON.stringify({ operation: "follow-up", runId, expectedVersion, message }),
      }),
    acknowledge: (runId: string, expectedVersion: number, foreign = false) =>
      route(
        new Request("http://127.0.0.1/api/agent-runs/acknowledge", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": foreign ? tokens.foreign : tokens.own,
          },
          body: JSON.stringify({ runId, expectedVersion, parentThreadId: ids.thread }),
        }),
      ),
    close: async () => {
      delivery.stop();
      release();
      for (const id of supervisor.activeRunIds()) await supervisor.stop(id);
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("cross-harness delegation with fixture provider transports", () => {
  it.each([
    ["Octant Harness", "Octant Harness"],
    ["Octant Harness", "provider harness"],
    ["provider harness", "Octant Harness"],
    ["provider harness", "provider harness"],
  ] as const)(
    "%s delegates independent children to %s and follows up in their saved sessions",
    async (parent, child) => {
      const subject = fixture(parent, child);
      try {
        for (const task of ["Check the first source", "Check the second source"]) {
          const result = await subject.delegate(task);
          expect(result).toMatchObject({
            result: {
              status: "accepted",
              target: {
                providerInstanceId: subject.target.providerInstanceId,
                modelId: subject.target.modelId,
              },
            },
          });
        }
        const runs = [...subject.persistence.snapshot().values()];
        expect(runs).toHaveLength(2);
        expect(new Set(runs.map((run) => String(run.id))).size).toBe(2);
        expect(new Set(runs.map((run) => String(run.requestId))).size).toBe(2);
        for (const run of runs) {
          expect(run.parentThreadId).toBe(ids.thread);
          expect(run.executionKind).toBe("octant-managed");
          expect(run.workspaceReceipt).toMatchObject({ kind: "chat-virtual", mode: "chat" });
          expect(run.authority).toMatchObject({
            filesystem: false,
            shell: false,
            git: false,
            network: false,
            executionPolicy: "plan",
            permissionPersistence: "current-session",
          });
          expect(run.routingReceipt).toMatchObject({
            selectedProviderInstanceId: subject.target.providerInstanceId,
            selectedModelId: subject.target.modelId,
          });
        }
        const selected = child === "Octant Harness" ? subject.direct : subject.provider;
        const unused = child === "Octant Harness" ? subject.provider : subject.direct;
        await expect.poll(() => selected.started.length).toBe(2);
        expect(unused.acquired).toHaveLength(0);
        expect(selected.acquired.map((input) => input.instanceId)).toEqual([
          subject.target.providerInstanceId,
          subject.target.providerInstanceId,
        ]);
        expect(selected.started.map((start) => start.modelId)).toEqual([
          subject.target.modelId,
          subject.target.modelId,
        ]);
        expect(selected.started.every((start) => start.executionPolicy === "plan")).toBe(true);
        expect(new Set(selected.started.map((start) => String(start.sessionId))).size).toBe(2);
        subject.release();
        await expect
          .poll(() =>
            [...subject.persistence.snapshot().values()].map((run) => ({
              status: run.lifecycleStatus,
              reason: run.recoveryReason,
            })),
          )
          .toEqual([
            { status: "completed", reason: undefined },
            { status: "completed", reason: undefined },
          ]);
        subject.delivery.start();
        await expect
          .poll(() =>
            [...subject.persistence.snapshot().values()].map((run) => run.resultDelivery?.outcome),
          )
          .toEqual(["delivered", "delivered"]);
        expect(subject.deliveries).toHaveLength(1);
        expect(subject.deliveries[0]?.parent).toBe(String(ids.thread));
        expect(new Set(subject.deliveries[0]?.mark.runIds)).toEqual(
          new Set(runs.map((run) => run.id)),
        );
        expect(subject.deliveries[0]?.prompt).toContain("Check the first source");
        expect(subject.deliveries[0]?.prompt).toContain("Check the second source");
        expect(subject.persistence.parentSummary(ids.foreignThread)).toEqual([]);
        for (const original of runs) {
          const run = subject.persistence.getById(original.id);
          if (run === undefined) throw new Error("Child missing after delivery");
          expect(subject.persistence.resultText(run.id)).toContain(
            child === "Octant Harness" ? "Fixture direct reply" : "Fixture provider reply",
          );
          expect(run.resultAcknowledgement).toMatchObject({ required: true, acknowledged: false });
          expect((await subject.acknowledge(run.id, run.version, true))?.status).toBe(403);
          expect(subject.persistence.getById(run.id)?.resultAcknowledgement.acknowledged).toBe(
            false,
          );
          expect((await subject.acknowledge(run.id, run.version))?.status).toBe(200);
        }
        subject.persistence.rebuildFromJournal();
        expect(
          subject.persistence
            .parentSummary(ids.thread)
            .map((run) => run.resultAcknowledgement.acknowledged),
        ).toEqual([true, true]);
        subject.delivery.start();
        await Promise.resolve();
        expect(subject.deliveries).toHaveLength(1);

        const original = runs[0];
        if (original === undefined) throw new Error("Expected first child");
        const completed = subject.persistence.getById(original.id);
        if (completed === undefined) throw new Error("Completed child missing after replay");
        const saved = subject.sessionStore.sessions.read(completed);
        if (saved?.resumeCursor === undefined) throw new Error("Completed child has no cursor");
        const firstReply = subject.persistence.resultText(completed.id);
        const message = "Compare the first result with this follow-up evidence";
        const followedUp = await subject.followUp(completed.id, completed.version, message);
        expect(followedUp, subject.persistence.getById(completed.id)?.recoveryReason).toMatchObject(
          {
            result: {
              status: "accepted",
              runId: completed.id,
              generation: 2,
              lifecycleStatus: "starting",
            },
          },
        );
        await expect
          .poll(() => subject.persistence.getById(completed.id))
          .toMatchObject({
            id: completed.id,
            requestId: completed.requestId,
            parentThreadId: completed.parentThreadId,
            lifecycleStatus: "completed",
            generation: 2,
            authority: completed.authority,
            routingReceipt: completed.routingReceipt,
            resultAcknowledgement: { required: true, acknowledged: false },
          });
        const continued = subject.persistence.getById(completed.id);
        if (continued === undefined) throw new Error("Continued child missing");
        expect(continued.resultDelivery).toBeUndefined();
        expect(subject.persistence.snapshot().size).toBe(2);
        expect(subject.sessionStore.sessions.read(continued)).toEqual(saved);
        expect(subject.persistence.resultText(continued.id)).toContain(message);
        expect(subject.persistence.resultText(continued.id)).not.toBe(firstReply);
        expect(selected.started).toHaveLength(2);
        expect(selected.resumed).toEqual([
          expect.objectContaining({
            sessionId: saved.sessionId,
            resumeCursor: saved.resumeCursor,
            modelId: subject.target.modelId,
            executionPolicy: "plan",
          }),
        ]);
        expect(selected.acquired).toHaveLength(3);
        expect(selected.acquired.at(-1)?.instanceId).toBe(subject.target.providerInstanceId);
        expect(unused.acquired).toHaveLength(0);
        if (child === "Octant Harness") {
          expect(selected.requests.at(-1)?.modelId).toBe(subject.target.modelId);
          expect(selected.requests.at(-1)?.history).toEqual([
            { role: "user", text: expect.stringContaining(original.task) },
            { role: "assistant", text: firstReply },
            { role: "user", text: message },
          ]);
        }
        subject.delivery.start();
        await expect
          .poll(() => subject.persistence.getById(continued.id))
          .toMatchObject({ generation: 2, resultDelivery: { outcome: "delivered" } });
        expect(subject.deliveries).toHaveLength(2);
        expect(subject.deliveries[1]).toMatchObject({
          parent: String(ids.thread),
          mark: {
            runId: continued.id,
            runIds: [continued.id],
            runGenerations: [{ runId: continued.id, generation: 2 }],
          },
          prompt: expect.stringContaining(message),
        });
        const delivered = subject.persistence.getById(continued.id);
        if (delivered === undefined) throw new Error("Follow-up delivery missing");
        expect((await subject.acknowledge(delivered.id, delivered.version, true))?.status).toBe(
          403,
        );
        expect(subject.persistence.getById(delivered.id)?.resultAcknowledgement.acknowledged).toBe(
          false,
        );
        expect((await subject.acknowledge(delivered.id, delivered.version))?.status).toBe(200);
        subject.persistence.rebuildFromJournal();
        expect(subject.persistence.getById(delivered.id)?.resultAcknowledgement.acknowledged).toBe(
          true,
        );
        expect(subject.persistence.parentSummary(ids.foreignThread)).toEqual([]);
        subject.delivery.start();
        await Promise.resolve();
        expect(subject.deliveries).toHaveLength(2);
      } finally {
        await subject.close();
      }
    },
  );
});

it("keeps a completed child's reply and generation when spend admission refuses its follow-up", async () => {
  const admit = vi
    .fn()
    .mockReturnValue({ status: "admitted", reservedTokens: 100, reservations: [] });
  const settle = vi.fn();
  const subject = fixture("provider harness", "provider harness", { admit, settle });
  try {
    await subject.delegate("Remember the original result");
    subject.release();
    await vi.waitFor(() =>
      expect([...subject.persistence.snapshot().values()][0]?.lifecycleStatus).toBe("completed"),
    );
    const completed = [...subject.persistence.snapshot().values()][0];
    if (completed === undefined) throw new Error("Expected completed child");
    const consumed = subject.persistence.applyCommand({
      kind: "settle-agent-run-result-delivery",
      runId: completed.id,
      expectedVersion: completed.version,
      generation: completed.generation ?? 1,
      outcome: "consumed",
    });
    if (consumed.kind !== "run-updated") throw new Error("Expected consumed result");
    expect(await subject.runtime.checkResume?.(consumed.run)).toEqual({ status: "ready" });
    const saved = subject.sessionStore.sessions.read(consumed.run);
    expect(saved?.resumeCursor?.value).toBe("fixture-native-session");
    const rows = subject.journalRows();
    const refusal = "This follow-up exceeds the current spend ceiling.";
    admit.mockReturnValue({ status: "refused", refusal: { message: refusal } });
    const message = "Continue with the second source";
    const response = await subject.resume(consumed.run.id, consumed.run.version, message);
    expect(await response?.json()).toMatchObject({ kind: "run-command-failed", message: refusal });
    expect(response?.status).toBe(409);
    expect(subject.persistence.getById(consumed.run.id)).toEqual(consumed.run);
    expect(subject.journalRows()).toEqual(rows);
    expect(subject.sessionStore.sessions.read(consumed.run)).toEqual(saved);
    expect(subject.provider.acquired).toHaveLength(1);
    expect(subject.persistence.resultText(consumed.run.id)).toContain(
      "Remember the original result",
    );
  } finally {
    await subject.close();
  }
});

it.each(["stale-version", "journal-failure"] as const)(
  "releases prepared continuation spend and capacity after %s without abandoning the reply",
  async (failure) => {
    const admit = vi
      .fn()
      .mockReturnValue({ status: "admitted", reservedTokens: 100, reservations: [] });
    const settle = vi.fn();
    const subject = fixture("provider harness", "provider harness", { admit, settle });
    try {
      await subject.delegate("Retain this first reply");
      subject.release();
      await vi.waitFor(() =>
        expect([...subject.persistence.snapshot().values()][0]?.lifecycleStatus).toBe("completed"),
      );
      const completed = [...subject.persistence.snapshot().values()][0];
      if (completed === undefined) throw new Error("Expected completed child");
      const consumed = subject.persistence.applyCommand({
        kind: "settle-agent-run-result-delivery",
        runId: completed.id,
        expectedVersion: completed.version,
        generation: completed.generation ?? 1,
        outcome: "consumed",
      });
      if (consumed.kind !== "run-updated") throw new Error("Expected consumed result");
      const rows = subject.journalRows();
      const capacity = subject.providerCapacity.snapshot(ids.provider);
      const beforeSettled = settle.mock.calls.length;
      const message = "Follow-up preserved for retry";
      vi.spyOn(subject.persistence, "applyCommand").mockImplementationOnce(() => {
        if (failure === "journal-failure") throw new Error("Journal unavailable");
        return {
          kind: "run-command-failed",
          reason: "stale-version",
          message: "Version changed before commit",
        };
      });
      const pending = subject.orchestration.resume(
        completed.id,
        consumed.run.version,
        liveAuthority,
        { message },
      );
      if (failure === "journal-failure")
        await expect(pending).rejects.toThrow("Journal unavailable");
      else
        expect(await pending).toMatchObject({
          kind: "run-command-failed",
          reason: "stale-version",
        });
      expect(subject.persistence.getById(completed.id)).toEqual(consumed.run);
      expect(subject.journalRows()).toEqual(rows);
      expect(subject.providerCapacity.snapshot(ids.provider)).toEqual(capacity);
      expect(settle).toHaveBeenCalledTimes(beforeSettled + 1);
      expect(subject.provider.acquired).toHaveLength(1);
      const response = await subject.resume(completed.id, consumed.run.version, message);
      expect(response?.status).toBe(200);
      await vi.waitFor(() =>
        expect(subject.persistence.getById(completed.id)).toMatchObject({
          lifecycleStatus: "completed",
          generation: 2,
        }),
      );
      expect(subject.persistence.resultText(completed.id)).toContain(message);
      expect(subject.provider.acquired).toHaveLength(2);
    } finally {
      await subject.close();
    }
  },
);
