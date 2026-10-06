import { decodeProviderRuntimeEvent } from "@octant/contracts";
import { AGENT_RUN_MAX_ACTIVE_GLOBAL } from "@octant/domain";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AgentRunPolicySettings,
  AgentRunRequested,
  AgentRunResultAcknowledged,
  AgentRunResultDeliverySettled,
  AgentRunStatusChanged,
  decodeAgentRunControlRequest,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  decodeMultiModelRoutingVendorId,
  decodeWindowId,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCommandResult,
  decodeAgentRunCanvasSnapshotResult,
  type AgentRunRoutingReceipt,
  type MultiModelPoolCandidate,
} from "@octant/contracts";
import type { MultiModelCandidateRuntimeFacts } from "@octant/domain/multi-model-pool-policy";
import { EventActor } from "@octant/contracts/events";
import { readAgentRunAdmittedContext } from "../persistence/agentRunContentStore";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { purgeThreadContent } from "../persistence/chatProjection";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_RESULT_DELIVERY_SETTLED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
} from "./agentRunEventStore";
import {
  AgentRunOrchestrationService,
  type AgentRunProcessSupervisorPort,
  createInMemoryCapacityPort,
} from "./agentRunOrchestrationService";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProjection } from "./agentRunProjection";
import { AgentRunSessionStore } from "./agentRunSessionStore";
import { AgentRunLiveConversationStore } from "./agentRunLiveConversationStore";
import { AgentRunSessionError } from "./agentRunSessionPort";
import { createAgentRunRouteHandler, type AgentRunRouteDependencies } from "./agentRunRoutes";
import {
  admitAgentRunControlRequest,
  type AgentRunControlAdmission,
  type AgentRunControlAdmissionDependencies,
} from "./agentRunControlAdmission";
import { AGENT_RUN_SETTINGS_UPDATED, AgentRunSettingsStore } from "./agentRunSettingsStore";
import { createNativeHarnessDelegatePort } from "../harness/nativeHarnessDelegatePort";

const directories: string[] = [];
const now = "2026-08-01T15:00:00.000Z";
afterEach(() => {
  while (directories.length) {
    const d = directories.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const capability = () => randomBytes(32).toString("base64url");
const ids = {
  run: decodeAgentRunId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  request: decodeAgentRunRequestId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  thread: decodeAgentRunParentThreadId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
  provider: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  providerB: "abababab-abab-4bab-8bab-abababababab",
  snapshot: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  actor: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};

const poolRequestedCandidate = {
  hostId: "local",
  providerInstanceId: ids.provider,
  modelId: "gpt-4o",
} as unknown as MultiModelPoolCandidate;
const poolFallbackCandidate = {
  hostId: "local",
  providerInstanceId: ids.providerB,
  modelId: "claude-x",
} as unknown as MultiModelPoolCandidate;

function candidateFacts(
  candidate: MultiModelPoolCandidate,
  overrides: Partial<MultiModelCandidateRuntimeFacts> = {},
): MultiModelCandidateRuntimeFacts {
  return {
    candidate,
    routingVendorId: decodeMultiModelRoutingVendorId("vendor-a"),
    configured: true,
    readiness: "ready",
    modelAvailable: true,
    compatibleModes: ["chat"],
    projectAllowed: true,
    profileAllowed: true,
    supportedCapabilities: [],
    authorityAllowed: true,
    ...overrides,
  };
}

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const authority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};
const routing: AgentRunRoutingReceipt = {
  executionResolution: {
    providerInstanceId: ids.provider as never,
    modelId: "gpt-4o" as never,
    hostId: "local" as never,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
    effectivePermissions: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
    },
    source: "project-default",
    fallbackChain: ["project-default"],
    downgradeReasons: [],
  },
  selectedExecutionKind: "octant-managed",
  attemptedExecutionKind: "provider-native",
  selectedProviderInstanceId: ids.provider as never,
  selectedModelId: "gpt-4o" as never,
  fallbackCandidates: [],
  capabilityDegradations: ["native-child-agents-unavailable"],
  contextSnapshotId: ids.snapshot as never,
  effectiveAuthorityDigest: "digest",
  usageQuality: "provider-reported",
  hostId: "local" as never,
  mode: "chat",
};

function createHandler(
  options: {
    readonly onExecutionAccepted?: AgentRunControlAdmissionDependencies["onExecutionAccepted"];
    readonly resume?: (run: AgentRun) => unknown;
    readonly listTargets?: AgentRunRouteDependencies["listTargets"];
    readonly reasoning?: string;
    readonly processes?: AgentRunProcessSupervisorPort;
    readonly authorizeCancellation?: (input: { readonly run: AgentRun }) => boolean;
    readonly authorizeCreation?: () => boolean;
    readonly authorizeParentThread?: (input: {
      readonly parentThreadId: unknown;
      readonly windowId: string;
    }) => boolean;
    readonly capacity?: ReturnType<typeof createInMemoryCapacityPort>;
    readonly poolRouting?: () =>
      | {
          readonly parentCandidate: MultiModelPoolCandidate;
          readonly runtimeFacts: ReadonlyArray<MultiModelCandidateRuntimeFacts>;
        }
      | undefined;
    readonly parentContext?: {
      readonly resolve: (input: {
        readonly parentThreadId: unknown;
        readonly mode: string;
      }) =>
        | ReadonlyArray<{ readonly kind: string; readonly text: string }>
        | { readonly unavailable: string }
        | undefined;
    };
    readonly parentMode?: "chat" | "work" | "code";
    readonly workspace?: AgentRunControlAdmissionDependencies["workspace"];
    readonly snapshotCanvas?: AgentRunRouteDependencies["snapshotCanvas"];
    readonly resolveCenterContext?: AgentRunRouteDependencies["resolveCenterContext"];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = new EventRegistry()
    .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
    .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
    .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged)
    .register(AGENT_RUN_RESULT_DELIVERY_SETTLED, 1, AgentRunResultDeliverySettled)
    .register(AGENT_RUN_SETTINGS_UPDATED, 1, AgentRunPolicySettings);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  const store = new AgentRunEventStore({
    journal,
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n === 1 ? ids.run : `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;
      };
    })(),
    actor,
  });
  const projection = new AgentRunProjection();
  let runCounter = 0;
  const persistence = new AgentRunPersistenceService({
    store,
    projection,
    uuid: () => {
      runCounter += 1;
      return runCounter === 1
        ? ids.run
        : `12121212-1212-4121-8121-${runCounter.toString(16).padStart(12, "0")}`;
    },
    clock: () => now,
    connection,
  });
  const windowAuthorityStore = new WindowAuthorityStore();
  const token = capability();
  windowAuthorityStore.register({ windowId, capability: token, now: 0 });
  const orchestration = new AgentRunOrchestrationService({
    persistence,
    capacity: options.capacity ?? createInMemoryCapacityPort(),
    worktree: { isVerifiedIsolation: () => false, isParentCheckout: () => true },
    approvals: { isCurrent: () => true },
    processes: options.processes ?? {
      start: () => undefined,
      stop: async () => undefined,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    },
  });
  const liveConversations = new AgentRunLiveConversationStore();
  let readyProviderId = ids.provider;
  // The real store, so a test sees the posture a host that never chose one gets.
  const settings = new AgentRunSettingsStore({
    journal,
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `dededede-dede-4ede-8ede-${n.toString(16).padStart(12, "0")}`;
      };
    })(),
    actor,
    clock: () => now,
  });
  const authorizeCreation: AgentRunControlAdmissionDependencies["authorizeCreation"] = () => {
    if (options.authorizeCreation?.() === false) return undefined;
    const parentMode = options.parentMode ?? "chat";
    const parentAuthority =
      parentMode === "work"
        ? {
            filesystem: true,
            shell: false,
            git: false,
            network: false,
            tools: true,
            subagents: true,
            executionPolicy: "approval-gated" as const,
            permissionPersistence: "current-session" as const,
          }
        : parentMode === "code"
          ? {
              filesystem: true,
              shell: true,
              git: true,
              network: true,
              tools: true,
              subagents: true,
              executionPolicy: "approval-gated" as const,
              permissionPersistence: "current-session" as const,
            }
          : {
              filesystem: false,
              shell: false,
              git: false,
              network: false,
              tools: true,
              subagents: true,
              executionPolicy: "plan" as const,
              permissionPersistence: "current-session" as const,
            };
    return {
      parentMode,
      parentAuthority,
      liveAuthority: parentAuthority,
      workspaceParent: {
        threadId: String(ids.thread),
        mode: parentMode,
        ...(parentMode === "chat"
          ? {}
          : {
              projectId: "77777777-7777-4777-8777-777777777777",
              bindingRevisionId: "88888888-8888-4888-8888-888888888888",
              canonicalRoot: "/projects/demo",
              checkoutRoot: "/repo",
            }),
      },
      parentRoute: {
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        providerInstanceId: ids.provider as never,
        modelId: "gpt-4o" as never,
        ...(parentMode === "chat" ? {} : { projectId: "77777777-7777-4777-8777-777777777777" }),
      },
    };
  };
  const admission: AgentRunControlAdmissionDependencies = {
    persistence,
    orchestration,
    settings,
    providerReadiness: {
      isReady: ({ providerInstanceId }) => providerInstanceId === readyProviderId,
    },
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `cccccccc-cccc-4ccc-8ccc-${n.toString(16).padStart(12, "0")}`;
      };
    })(),
    authorizeCreation,
    ...(options.onExecutionAccepted === undefined
      ? {}
      : { onExecutionAccepted: options.onExecutionAccepted }),
    nativeEvidence: () => ({
      claimedNativeSupport: "unsupported",
      workspace: false,
      authority: false,
      observability: false,
      cancellation: false,
      steering: false,
      recovery: false,
    }),
    ...(options.poolRouting === undefined ? {} : { poolRouting: options.poolRouting }),
    ...(options.parentContext === undefined
      ? {}
      : { parentContext: options.parentContext as never }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };
  const handler = createAgentRunRouteHandler({
    listTargets:
      options.listTargets ??
      (() => [
        {
          providerInstanceId: ids.provider,
          modelIds: ["gpt-4o"],
          displayName: "Fixture",
          driverKind: "openai",
        },
      ]),
    windowAuthorityStore,
    persistence,
    liveConversations,
    orchestration,
    authorizeCreation,
    ...(options.onExecutionAccepted === undefined
      ? {}
      : { onExecutionAccepted: options.onExecutionAccepted }),
    authorizeCancellation: ({ run }) => options.authorizeCancellation?.({ run }) ?? true,
    authorizeParentThread: (input) => options.authorizeParentThread?.(input) ?? true,
    resolveCenterContext:
      options.resolveCenterContext ??
      (({ parentThreadId }) => ({
        parentThreadTitle: `Thread ${String(parentThreadId).slice(0, 8)}`,
      })),
    ...(options.snapshotCanvas === undefined ? {} : { snapshotCanvas: options.snapshotCanvas }),
    now: () => 0,
  });
  /**
   * Admits a child from a control request and starts it, as the delegate
   * tool does, but with the request id, parent run, and pool a test chooses.
   */
  const create = async (
    body: Record<string, unknown>,
  ): Promise<Exclude<AgentRunControlAdmission, { kind: "admitted" }> | AgentRunCommandResult> => {
    const admitted = await admitAgentRunControlRequest(admission, {
      controlRequest: decodeAgentRunControlRequest(body),
      windowId: String(windowId),
      confirmed: false,
    });
    if (admitted.kind !== "admitted") return admitted;
    const accepted: AgentRunCommandResult =
      "kind" in admitted.result ? admitted.result : { kind: "run-accepted", run: admitted.result };
    if (
      accepted.kind === "run-accepted" &&
      accepted.run.lifecycleStatus === "queued" &&
      accepted.run.recoveryReason === undefined
    ) {
      return orchestration.start(accepted.run.id, accepted.run.version, admitted.liveAuthority);
    }
    return accepted;
  };
  const delegate = () =>
    createNativeHarnessDelegatePort(
      {
        admission,
        orchestration,
        persistence,
        router: {
          resolve: () =>
            ({
              kind: "primary",
              job: "researcher",
              slotId: "default",
              decidedAt: "2026-10-03T10:00:00.000Z",
              rejected: [],
              candidate: { hostId: "local", providerInstanceId: ids.provider, modelId: "gpt-4o" },
            }) as never,
        },
        sessions: {
          ensure: () => ({}) as never,
          recordRouteDecision: () => undefined,
          read: () => undefined,
        },
        uuid: () => String(ids.request),
        listTargets: () => [
          {
            providerInstanceId: String(ids.provider),
            modelIds: ["gpt-4o"],
            displayName: "Fixture",
            driverKind: "openai",
          },
        ],
      },
      {
        parentThreadId: String(ids.thread),
        windowId: String(windowId),
        mode: options.parentMode ?? "chat",
        lead: {
          hostId: "local",
          providerInstanceId: ids.provider,
          modelId: "gpt-4o",
        } as never,
      },
    );
  return {
    handler,
    windowAuthorityStore,
    persistence,
    liveConversations,
    orchestration,
    token,
    connection,
    setReadyProvider: (id: string) => {
      readyProviderId = id;
    },
    create,
    delegate,
    settings,
    admission,
  };
}

describe("agentRunRoutes", () => {
  it("streams an authenticated managed-child snapshot, deltas, and terminal state", async () => {
    const { handler, persistence, liveConversations, token } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Stream",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    liveConversations.begin(accepted.run.id);
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation/stream?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/x-ndjson");
    const reader = response?.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;
    const readFrame = async () => {
      const next = await reader.read();
      expect(next.done).toBe(false);
      return JSON.parse(new TextDecoder().decode(next.value).trim()) as Record<string, unknown>;
    };
    await expect(readFrame()).resolves.toMatchObject({ kind: "snapshot", status: "live" });
    liveConversations.appendText(accepted.run.id, "first", now as never);
    await expect(readFrame()).resolves.toMatchObject({
      kind: "delta",
      status: "live",
      entries: [{ sequence: 1, text: "first" }],
    });
    liveConversations.complete(accepted.run.id);
    await expect(readFrame()).resolves.toMatchObject({ kind: "delta", status: "complete" });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("re-reads durable terminal history for the final stream snapshot after reload", async () => {
    const { handler, persistence, liveConversations, token, connection } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Remember the conversation",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("admission failed");
    let current = accepted.run;
    for (const kind of [
      "start-agent-run",
      "mark-agent-run-running",
      "complete-agent-run",
    ] as const) {
      const identity = { runId: current.id, expectedVersion: current.version };
      const result = persistence.applyCommand(
        kind === "complete-agent-run"
          ? {
              ...identity,
              kind,
              result: { reference: `octant://agent-run/${current.id}/result`, truncated: false },
              resultText: "Final answer",
            }
          : { ...identity, kind },
      );
      if (result.kind !== "run-updated") throw new Error("transition failed");
      current = result.run;
    }
    const store = new AgentRunSessionStore({
      connection,
      getById: (id) => persistence.getById(id),
    });
    const writing = new AgentRunLiveConversationStore({ persistence: store.conversations });
    writing.begin(current.id);
    for (let i = 0; i < 160; i++) writing.appendText(current.id, `History ${i}`, now as never);
    writing.complete(current.id);
    const reloaded = new AgentRunLiveConversationStore({ persistence: store.conversations });
    const read = vi
      .spyOn(liveConversations, "read")
      .mockImplementation((input) => reloaded.read(input));
    vi.spyOn(liveConversations, "subscribe").mockImplementation((input) =>
      reloaded.subscribe(input),
    );
    const headers = { "x-octant-window-capability": token };
    const snapshot = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${current.id}`, { headers }),
    );
    const expected = await snapshot?.json();
    expect(expected).toMatchObject({ status: "complete", truncated: true });
    // The retained view becomes available between the initial live probe and final disclosure.
    read.mockReturnValueOnce(undefined);
    const stream = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation/stream?runId=${current.id}`, {
        headers,
      }),
    );
    const frame = JSON.parse((await stream?.text()) ?? "null");
    expect(frame).toMatchObject({ ...expected, kind: "snapshot" });
    expect(frame.entries.length).toBeGreaterThan(1);
    const ordinary = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation/stream?runId=${current.id}`, {
        headers,
      }),
    );
    expect(JSON.parse((await ordinary?.text()) ?? "null")).toMatchObject({
      ...expected,
      kind: "snapshot",
    });
  });

  it("authorizes conversation streams from the run parent before opening a listener", async () => {
    const authorizeParentThread = vi.fn(() => false);
    const { handler, persistence, liveConversations, token } = createHandler({
      authorizeParentThread,
    });
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Hidden stream",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    liveConversations.begin(accepted.run.id);
    const subscribe = vi.spyOn(liveConversations, "subscribe");
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation/stream?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(403);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("returns a bounded live managed-child conversation with a replay cursor", async () => {
    const { handler, persistence, liveConversations, token } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    liveConversations.begin(accepted.run.id);
    liveConversations.appendText(accepted.run.id, "partial reply", now as never);
    const response = await handler(
      new Request(
        `http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}&afterSequence=0`,
        { headers: { "x-octant-window-capability": token } },
      ),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      runId: accepted.run.id,
      parentThreadId: ids.thread,
      executionKind: "octant-managed",
      status: "live",
      entries: [{ sequence: 1, text: "partial reply" }],
      truncated: false,
    });
  });

  it("refuses live conversation reads before touching the transient store", async () => {
    const authorizeParentThread = vi.fn(() => false);
    const { handler, persistence, liveConversations, token } = createHandler({
      authorizeParentThread,
    });
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Hidden",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    liveConversations.begin(accepted.run.id);
    const read = vi.spyOn(liveConversations, "read");
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports an active managed child as stale after a host restart", async () => {
    const { handler, persistence, token } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Reconnect",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ status: "stale", entries: [] });
  });

  it("rejects malformed conversation cursors", async () => {
    const { handler, token } = createHandler();
    const response = await handler(
      new Request(
        `http://127.0.0.1/api/agent-runs/conversation?runId=${ids.run}&afterSequence=-1`,
        {
          headers: { "x-octant-window-capability": token },
        },
      ),
    );
    expect(response?.status).toBe(400);
  });

  it("does not leak a process-local transcript for a provider-native child", async () => {
    const { handler, persistence, liveConversations, token } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Native research",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: {
          ...routing,
          selectedExecutionKind: "provider-native",
          capabilityDegradations: [],
        },
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    liveConversations.begin(accepted.run.id);
    liveConversations.appendText(accepted.run.id, "native secret", now as never);
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      status: "unavailable",
      entries: [],
      staleReason: "Provider-native child transcript is not available through this host.",
    });
  });

  it("returns a retained native result after completion", async () => {
    const { handler, persistence, token } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Native research",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: {
          ...routing,
          selectedExecutionKind: "provider-native",
          capabilityDegradations: [],
        },
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version,
    });
    persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    const completed = persistence.applyCommand({
      kind: "complete-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      result: {
        reference: `octant://agent-run/${String(accepted.run.id)}/result`,
        truncated: false,
      },
      resultText: "Native findings.",
    });
    expect(completed.kind).toBe("run-updated");
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      status: "complete",
      entries: [{ text: "Native findings." }],
    });
  });

  it("marks a cancelled managed child stale and keeps live text out of the journal", async () => {
    const { handler, persistence, liveConversations, token, connection } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Cancel me",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    liveConversations.begin(accepted.run.id);
    liveConversations.appendText(accepted.run.id, "partial-before-cancel", now as never);
    liveConversations.markStale(
      accepted.run.id,
      "The child session ended before a complete transcript was retained.",
    );
    persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version,
    });
    persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    persistence.applyCommand({
      kind: "cancel-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      scope: "self",
    });
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      status: "stale",
      entries: [{ text: "partial-before-cancel" }],
    });
    const journalHits = (
      connection
        .prepare("SELECT COUNT(*) AS count FROM event_journal WHERE payload_json LIKE ?")
        .get("%partial-before-cancel%") as { readonly count: number }
    ).count;
    expect(journalHits).toBe(0);
  });

  it("serves retained text after live completion and reports purged history as unavailable", async () => {
    const { handler, persistence, liveConversations, token, connection } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Finish",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    liveConversations.begin(accepted.run.id);
    liveConversations.appendText(accepted.run.id, "working", now as never);
    liveConversations.complete(accepted.run.id);
    persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version,
    });
    persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    const completed = persistence.applyCommand({
      kind: "complete-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      result: {
        reference: `octant://agent-run/${String(accepted.run.id)}/result`,
        truncated: false,
      },
      resultText: "Final review.",
    });
    expect(completed.kind).toBe("run-updated");
    const live = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(await live?.json()).toMatchObject({
      status: "complete",
      entries: [{ text: "working" }],
    });
    liveConversations.clear(accepted.run.id);
    const retained = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(await retained?.json()).toMatchObject({
      status: "complete",
      entries: [{ text: "Final review." }],
    });
    purgeThreadContent(connection, String(ids.thread));
    const purged = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/conversation?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(await purged?.json()).toMatchObject({
      status: "unavailable",
      entries: [],
      staleReason: "No retained child conversation is available.",
    });
  });

  it("returns parent summary for an authenticated window", async () => {
    const { handler, persistence, token } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/parent-summary?parentThreadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { entries: Array<{ runId: string; task: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.task).toBe("Summarize");
  });

  it.each(["parent", "child"])("refuses child data when %s scope is denied", async (scope) => {
    const { handler, persistence, token, liveConversations } = createHandler({
      authorizeCancellation: () => scope !== "child",
      authorizeParentThread: () => scope !== "parent",
    });
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") throw new Error("Admission failed");
    const readResults = vi.spyOn(persistence, "resultPackets");
    const readConversation = vi.spyOn(liveConversations, "read");
    const readReview = vi.spyOn(persistence, "reviewSnapshot");
    for (const route of ["review", "results", "conversation", "conversation/stream"]) {
      const response = await handler(
        new Request(
          `http://127.0.0.1/api/agent-runs/${route}?runId=${accepted.run.id}${route === "review" ? "&generation=1" : ""}`,
          {
            headers: { "x-octant-window-capability": token },
          },
        ),
      );
      expect(response?.status).toBe(403);
    }
    const summary = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/parent-summary?parentThreadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    if (scope === "parent") expect(summary?.status).toBe(403);
    else expect(await summary?.json()).toMatchObject({ entries: [], observations: [] });
    expect(readReview).not.toHaveBeenCalled();
    expect(readResults).not.toHaveBeenCalled();
    expect(readConversation).not.toHaveBeenCalled();
  });

  it("attributes observed descendants to the authorized root and managed parent without run controls", async () => {
    const { handler, persistence, token, liveConversations } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") throw new Error("Admission failed");
    const report = decodeProviderRuntimeEvent({
      kind: "child-agent-activity",
      instanceId: ids.provider,
      sessionId: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      correlationId: ids.request,
      occurredAt: "2026-10-03T20:00:00.000Z",
      childAgentId: "provider-child",
      status: "running",
      summary: "Reviewing",
    });
    if (report.kind !== "child-agent-activity") throw new Error("Invalid fixture");
    liveConversations.begin(accepted.run.id);
    liveConversations.appendChildActivity(accepted.run.id, report, 1);
    liveConversations.appendChildActivity(accepted.run.id, report, 1);
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/parent-summary?parentThreadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(await response?.json()).toMatchObject({
      observations: [
        {
          kind: "observed",
          parentThreadId: ids.thread,
          parentRunId: accepted.run.id,
          childAgentId: "provider-child",
          control: "unavailable",
          historyStatus: "partial",
        },
      ],
      entries: [{ resultPackets: [{ generation: 1, reportedSummary: { status: "unavailable" } }] }],
    });
    const results = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/results?runId=${accepted.run.id}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    const review = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/review?runId=${accepted.run.id}&generation=1`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(review?.status).toBe(200);
    expect(await review?.json()).toMatchObject({
      runId: accepted.run.id,
      generation: 1,
      status: "unavailable",
    });
    const invalid = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/review?runId=${accepted.run.id}&generation=-1`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(invalid?.status).toBe(400);
    const snapshot = {
      capturedAt: "2026-10-03T20:00:00.000Z",
      baseTree: "a".repeat(40),
      resultTree: "b".repeat(40),
      diff: "private captured diff",
      changedPaths: ["file.txt"],
      truncated: false,
    };
    persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version,
    });
    persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    const completion = persistence.applyCommand({
      kind: "complete-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      result: { reference: `octant://agent-run/${accepted.run.id}/result`, truncated: false },
      resultText: "Completed",
      resultEvidence: {
        files: { status: "unavailable", items: [] },
        checks: { status: "unavailable", items: [] },
        review: snapshot as never,
      },
    });
    expect(completion.kind).toBe("run-updated");
    const captured = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/review?runId=${accepted.run.id}&generation=1`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(await captured?.json()).toMatchObject({ status: "available", snapshot });
    expect(results?.status).toBe(200);
    expect(await results?.json()).toMatchObject({
      runId: accepted.run.id,
      packets: [{ parentThreadId: ids.thread, generation: 1 }],
    });
  });

  it("returns authorized center rows with enriched parent titles", async () => {
    const resolveCenterContext = vi.fn(() => ({ parentThreadTitle: "Thread context" }));
    const { handler, persistence, token } = createHandler({ resolveCenterContext });
    persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/center?status=all&mode=all&limit=50", {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      items: Array<{ task: string; parentThreadTitle: string; mode: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.task).toBe("Summarize");
    expect(body.items[0]?.parentThreadTitle).toContain("Thread");
    expect(body.items[0]?.mode).toBe("chat");
    expect(resolveCenterContext).toHaveBeenCalledWith({
      parentThreadId: ids.thread,
      mode: "chat",
      requestId: ids.request,
      workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
    });
  });

  it("omits center rows the window is not authorized to read", async () => {
    const authorizeParentThread = vi.fn(() => false);
    const { handler, persistence, token } = createHandler({ authorizeParentThread });
    persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Hidden",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/center?status=all&mode=all&limit=50", {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
    expect(authorizeParentThread).toHaveBeenCalled();
  });

  it("refuses the parent summary before any read when the window may not see the thread", async () => {
    const authorizeParentThread = vi.fn(() => false);
    const { handler, persistence, token } = createHandler({ authorizeParentThread });
    const read = vi.spyOn(persistence, "parentSummary");

    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/parent-summary?parentThreadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );

    // A window capability proves the caller is a renderer of this host, not
    // that it may read this parent thread's runs — which now carry each
    // completed child's full reply.
    expect(response?.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(authorizeParentThread).toHaveBeenCalledWith({
      parentThreadId: ids.thread,
      windowId: String(windowId),
    });
  });

  it("refuses acknowledgement for a run whose parent thread the window may not touch", async () => {
    const authorizeParentThread = vi.fn(() => false);
    const { handler, persistence, token } = createHandler({ authorizeParentThread });
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    const apply = vi.spyOn(persistence, "applyCommand");

    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: accepted.run.id, expectedVersion: accepted.run.version }),
      }),
    );

    expect(response?.status).toBe(403);
    // The refusal happens before the command runs, and authorization derives
    // from the run's own recorded parent thread, never a client claim.
    expect(apply).not.toHaveBeenCalled();
    expect(authorizeParentThread).toHaveBeenCalledWith({
      parentThreadId: accepted.run.parentThreadId,
      windowId: String(windowId),
    });
    expect(persistence.getById(accepted.run.id)?.resultAcknowledgement.acknowledged).toBe(false);
  });

  it("refuses acknowledgement of an unknown run without consulting authorization", async () => {
    const authorizeParentThread = vi.fn(() => true);
    const { handler, token } = createHandler({ authorizeParentThread });

    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: ids.run, expectedVersion: 1 }),
      }),
    );

    // The same 403 as an unauthorized run, so run ids cannot be probed for
    // existence.
    expect(response?.status).toBe(403);
    expect(authorizeParentThread).not.toHaveBeenCalled();
  });

  it("refuses a canvas snapshot when the window may not see the thread", async () => {
    const authorizeParentThread = vi.fn(() => false);
    const snapshotCanvas = vi.fn();
    const { handler, persistence, token } = createHandler({
      authorizeParentThread,
      snapshotCanvas,
    });
    persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/canvas-snapshot", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ parentThreadId: ids.thread }),
      }),
    );
    expect(response?.status).toBe(403);
    expect(snapshotCanvas).not.toHaveBeenCalled();
    expect(authorizeParentThread).toHaveBeenCalledWith({
      parentThreadId: ids.thread,
      windowId: String(windowId),
    });
  });

  it("denies a canvas snapshot when the parent thread has no runs", async () => {
    const snapshotCanvas = vi.fn();
    const { handler, token } = createHandler({ snapshotCanvas });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/canvas-snapshot", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ parentThreadId: ids.thread }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      kind: "denied",
      message: "This thread has no agent runs to save.",
    });
    expect(snapshotCanvas).not.toHaveBeenCalled();
  });

  it("snapshots the parent thread forest as a Canvas diagram", async () => {
    const snapshotCanvas = vi.fn(async () =>
      decodeAgentRunCanvasSnapshotResult({
        kind: "accepted",
        canvasId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        title: "Thread cccccccc agent graph",
        originThreadId: ids.thread,
        mode: "chat",
        projectId: "77777777-7777-4777-8777-777777777777",
      }),
    );
    const { handler, persistence, token } = createHandler({ snapshotCanvas });
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/canvas-snapshot", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ parentThreadId: ids.thread }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      kind: "accepted",
      canvasId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      title: "Thread cccccccc agent graph",
      originThreadId: ids.thread,
      mode: "chat",
      projectId: "77777777-7777-4777-8777-777777777777",
    });
    expect(snapshotCanvas).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: ids.thread,
        mode: "chat",
        title: expect.stringContaining("agent graph"),
        blocks: [expect.objectContaining({ kind: "diagram" })],
      }),
    );
  });

  it("rejects unauthenticated parent-summary queries", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/parent-summary?parentThreadId=${ids.thread}`),
    );
    expect(response?.status).toBe(401);
  });

  it("acknowledges a completed run through the command route", async () => {
    const { handler, persistence, token } = createHandler();
    const accepted = persistence.requestRun({
      command: {
        kind: "request-agent-run",
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize",
        creationPosture: "automatic",
        requestedAuthority: authority,
        routingReceipt: routing,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority: { ...authority, subagents: true },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version,
    });
    persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    const completed = persistence.applyCommand({
      kind: "complete-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      result: {
        reference: `octant://agent-run/${String(accepted.run.id)}/result`,
        truncated: false,
      },
      resultText: "The fallback is safe.",
    });
    expect(completed.kind).toBe("run-updated");
    if (completed.kind !== "run-updated") return;
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/acknowledge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": token,
        },
        body: JSON.stringify({
          runId: completed.run.id,
          expectedVersion: completed.run.version,
        }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      kind: string;
      run: { resultAcknowledgement: { acknowledged: boolean } };
    };
    expect(body.kind).toBe("run-updated");
    expect(body.run.resultAcknowledgement.acknowledged).toBe(true);
  });

  const creationBody = () => ({
    requestId: ids.request,
    parentThreadId: ids.thread,
    role: "research" as const,
    task: "Summarize the open PRs in this repository.",
  });

  /** A run the thread's agent started, for the tests of what a person may do with it. */
  async function startedRun(
    create: Awaited<ReturnType<typeof createHandler>>["create"],
    body: Record<string, unknown> = creationBody(),
  ): Promise<AgentRun> {
    const result = await create(body);
    if (!("run" in result) || result.run === undefined) {
      throw new Error(`expected a started run, got ${JSON.stringify(result)}`);
    }
    return result.run;
  }

  it("no longer serves a route that starts a subagent by hand", async () => {
    const { handler, token, persistence } = createHandler();
    for (const path of [
      "/api/agent-runs/request",
      "/api/agent-runs/control-preview",
      "/api/agent-runs/workspaces/prepare",
      "/api/agent-runs/workspaces/confirm",
    ]) {
      const response = await handler(
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify(creationBody()),
        }),
      );
      expect(response?.status).toBe(404);
    }
    expect(persistence.getByRequestId(ids.request)).toBeUndefined();
  });

  it("admits and starts a delegation from the thread's agent on a host that never chose a posture", async () => {
    const { delegate, persistence, settings } = createHandler();
    expect(settings.current().creationPosture).toBe("automatic");

    const outcome = await delegate().start({
      role: "research",
      task: "Summarize the open PRs in this repository.",
      includeParentContext: false,
    });

    expect(outcome).toMatchObject({
      status: "accepted",
      runId: String(ids.run),
      lifecycleStatus: "starting",
      target: { providerInstanceId: ids.provider, modelId: "gpt-4o" },
      route: { kind: "primary" },
    });
    expect(persistence.getById(ids.run)?.parentThreadId).toBe(ids.thread);
  });

  it("refuses a delegation once a person turned subagents off", async () => {
    const { delegate, persistence, settings } = createHandler();
    settings.update({ creationPosture: "off", expectedVersion: 0 });

    const outcome = await delegate().start({
      role: "research",
      task: "Summarize the open PRs in this repository.",
      includeParentContext: false,
    });

    expect(outcome).toMatchObject({ status: "refused", reason: "creation-posture-off" });
    expect(persistence.getByRequestId(ids.request)).toBeUndefined();
  });

  it("creates a child run under Automatic posture", async () => {
    const { create } = createHandler();
    expect(await create(creationBody())).toMatchObject({
      kind: "run-updated",
      run: { lifecycleStatus: "starting" },
    });
  });

  it("denies creation when the posture is Off, whatever the request claims", async () => {
    const { create, settings } = createHandler();
    settings.update({ creationPosture: "off", expectedVersion: 0 });
    expect(await create(creationBody())).toMatchObject({
      kind: "run-command-failed",
      reason: "posture-rejected",
    });
  });

  it("denies creation unless the window owns the actual parent thread", async () => {
    const { create } = createHandler({ authorizeCreation: () => false });
    expect(await create(creationBody())).toEqual({
      kind: "refused",
      reason: "unauthorized",
      status: 403,
    });
  });

  it("refuses a Chat-only research child on a Code parent", async () => {
    const { create, persistence } = createHandler({ parentMode: "code" });
    expect(await create(creationBody())).toEqual({
      kind: "refused",
      reason: "unsupported",
      status: 400,
    });
    expect(persistence.getByRequestId(ids.request)).toBeUndefined();
  });

  it("does not reserve capacity again when the request id is retried", async () => {
    const capacity = createInMemoryCapacityPort();
    const reserve = vi.spyOn(capacity, "tryReserve");
    const { create } = createHandler({ capacity });

    await startedRun(create);
    await startedRun(create);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("returns an idempotent receipt before mutable provider readiness is rechecked", async () => {
    const { create, setReadyProvider } = createHandler();
    await startedRun(create);
    setReadyProvider("99999999-9999-4999-8999-999999999999");

    expect(await create(creationBody())).toMatchObject({
      kind: "run-accepted",
      run: { id: ids.run, lifecycleStatus: "starting" },
    });
  });

  it("binds only a newly admitted child and never rebinds an idempotent or refused delegation", async () => {
    const onExecutionAccepted = vi.fn();
    const { create, admission, setReadyProvider } = createHandler({ onExecutionAccepted });
    const run = await startedRun(create);
    expect(onExecutionAccepted).toHaveBeenCalledExactlyOnceWith({
      run: expect.objectContaining({ requestId: run.requestId }),
      windowId: String(windowId),
      operation: "admission",
    });
    const otherWindow = "00000000-0000-4000-8000-00000000a002";
    await admitAgentRunControlRequest(admission, {
      controlRequest: decodeAgentRunControlRequest(creationBody()),
      windowId: otherWindow,
      confirmed: false,
    });
    expect(onExecutionAccepted).toHaveBeenCalledOnce();
    setReadyProvider("99999999-9999-4999-8999-999999999999");
    await create({ ...creationBody(), requestId: "00000000-0000-4000-8000-00000000a003" });
    expect(onExecutionAccepted).toHaveBeenCalledOnce();
  });

  it.each(["resume", "retry"] as const)(
    "rebinds only an accepted %s and leaves stale controls unable to steal the window",
    async (action) => {
      const onExecutionAccepted = vi.fn();
      const { handler, windowAuthorityStore, persistence, create } = createHandler({
        onExecutionAccepted,
        resume: () => undefined,
      });
      const run = await startedRun(create);
      const otherWindow = decodeWindowId("00000000-0000-4000-8000-00000000a002");
      const token = capability();
      windowAuthorityStore.register({ windowId: otherWindow, capability: token, now: 0 });
      persistence.applyCommand({
        kind: action === "retry" ? "fail-agent-run" : "wait-agent-run",
        runId: run.id,
        expectedVersion: run.version,
        recoveryReason: "provider-unavailable",
      });
      const current = persistence.getById(run.id);
      const control = (version: number | undefined) =>
        handler(
          new Request(`http://127.0.0.1/api/agent-runs/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-octant-window-capability": token },
            body: JSON.stringify({ runId: run.id, expectedVersion: version }),
          }),
        );
      onExecutionAccepted.mockClear();
      expect((await control(run.version))?.status).toBe(409);
      expect(onExecutionAccepted).not.toHaveBeenCalled();
      expect((await control(current?.version))?.status).toBe(200);
      expect(onExecutionAccepted).toHaveBeenCalledExactlyOnceWith({
        run: expect.objectContaining({ id: run.id, lifecycleStatus: "starting" }),
        windowId: String(otherWindow),
        operation: action,
      });
    },
  );

  it("does not rebind a resume that cannot open the saved provider session", async () => {
    const onExecutionAccepted = vi.fn();
    const { handler, token, persistence, create } = createHandler({
      onExecutionAccepted,
      resume: () => {
        throw new AgentRunSessionError("resume-unavailable", "Saved cursor unavailable");
      },
    });
    const run = await startedRun(create);
    const waiting = persistence.applyCommand({
      kind: "wait-agent-run",
      runId: run.id,
      expectedVersion: run.version,
      recoveryReason: "provider-unavailable",
    });
    if (waiting.kind !== "run-updated") throw new Error("Expected waiting child");
    onExecutionAccepted.mockClear();
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/resume", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: run.id, expectedVersion: waiting.run.version }),
      }),
    );
    expect(await response?.json()).toMatchObject({ run: { lifecycleStatus: "waiting" } });
    expect(onExecutionAccepted).not.toHaveBeenCalled();
  });

  it("rejects a request ID reused for a different parent or authority", async () => {
    const { create } = createHandler();
    await startedRun(create);
    const reused = {
      kind: "invalid",
      message: "AgentRun request ID cannot be reused for a different authorized request.",
      status: 409,
    };

    expect(
      await create({ ...creationBody(), parentThreadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccd" }),
    ).toEqual(reused);
    expect(await create({ ...creationBody(), task: "A different bounded task." })).toEqual(reused);
  });

  it("stores the admitted parent context and journals only its identity", async () => {
    const { create, connection } = createHandler({
      parentContext: {
        resolve: () => [{ kind: "user-message", text: "Which service paged first?" }],
      },
    });
    const run = await startedRun(create, { ...creationBody(), includeParentContext: true });

    // The receipt records what the child was admitted with, not the parent's
    // words: the blocks are that thread's conversation and go to the store.
    expect(run.routingReceipt.admittedContextBlocks).toBe(1);
    expect(
      readAgentRunAdmittedContext(connection, {
        runId: run.id,
        contextSnapshotId: run.routingReceipt.contextSnapshotId,
      }),
    ).toEqual([{ kind: "user-message", text: "Which service paged first?" }]);
    expect(
      connection
        .prepare(
          "SELECT COUNT(*) AS count FROM event_journal WHERE payload_json LIKE '%Which service paged first%'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("refuses a child asking for parent context this host cannot resolve", async () => {
    for (const parentContext of [undefined, { resolve: () => undefined }]) {
      const { create } = createHandler(parentContext === undefined ? {} : { parentContext });
      expect(await create({ ...creationBody(), includeParentContext: true })).toMatchObject({
        kind: "invalid",
        status: 400,
      });
    }
  });

  it("names why parent context is unavailable and allocates no workspace for the refused child", async () => {
    const prepare = vi.fn();
    const { create } = createHandler({
      parentContext: { resolve: () => ({ unavailable: "source-changed" }) },
      workspace: { prepare, confirm: vi.fn(), admit: vi.fn() } as never,
    });

    const refused = await create({ ...creationBody(), includeParentContext: true });

    expect(refused).toMatchObject({
      kind: "invalid",
      status: 400,
      message: expect.stringMatching(/conversation changed while it was being read/),
    });
    // A worktree allocated before this refusal would be left behind for a
    // child that never started.
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a request ID reused with a different parent-context ask", async () => {
    const { create } = createHandler({
      parentContext: {
        resolve: () => [{ kind: "user-message", text: "Which service paged first?" }],
      },
    });
    await startedRun(create, { ...creationBody(), includeParentContext: true });

    expect(await create(creationBody())).toMatchObject({ kind: "invalid", status: 409 });
  });

  it("rejects creation for an unconfigured provider", async () => {
    const { create, setReadyProvider } = createHandler();
    setReadyProvider("99999999-9999-4999-8999-999999999999");
    expect(await create(creationBody())).toMatchObject({ kind: "invalid", status: 400 });
  });

  it("returns a structured limit result once the global active-run ceiling is reached", async () => {
    const { create } = createHandler();
    const distinctThread = (n: number) =>
      decodeAgentRunParentThreadId(`33333333-3333-4333-8333-${String(n).padStart(12, "0")}`);
    const request = (n: number) =>
      decodeAgentRunRequestId(`bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`);
    for (let i = 0; i < AGENT_RUN_MAX_ACTIVE_GLOBAL; i++) {
      await create({ ...creationBody(), requestId: request(i), parentThreadId: distinctThread(i) });
    }
    expect(
      await create({
        ...creationBody(),
        requestId: request(AGENT_RUN_MAX_ACTIVE_GLOBAL),
        parentThreadId: distinctThread(AGENT_RUN_MAX_ACTIVE_GLOBAL),
      }),
    ).toMatchObject({ kind: "run-command-failed", reason: "limit-reached" });
  });

  it("cancels a run through the cancel route", async () => {
    const { handler, token, create } = createHandler();
    const run = await startedRun(create);
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: run.id, scope: "self" }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      results: Array<{ run?: { lifecycleStatus: string } }>;
    };
    expect(body.results[0]?.run?.lifecycleStatus).toBe("cancelled");
  });

  it("rejects cancellation when the authenticated window does not own the parent thread", async () => {
    const { handler, token, persistence, create } = createHandler({
      authorizeCancellation: () => false,
    });
    const run = await startedRun(create);
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: run.id, scope: "self" }),
      }),
    );

    expect(response?.status).toBe(403);
    expect(persistence.getById(run.id)?.lifecycleStatus).toBe("starting");
  });

  it("authorizes every descendant before cancelling a subtree", async () => {
    const checked: string[] = [];
    const { handler, token, persistence, create } = createHandler({
      authorizeCancellation: ({ run }) => {
        checked.push(String(run.id));
        return run.parentRunId === undefined;
      },
    });
    const root = await startedRun(create);
    const child = await startedRun(create, {
      ...creationBody(),
      requestId: "22222222-2222-4222-8222-222222222223",
      parentRunId: root.id,
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: root.id, scope: "subtree" }),
      }),
    );
    expect(response?.status).toBe(403);
    // Leaf-first authorization must reach the linked child before it can
    // cancel the parent. It fails there, so the parent remains untouched.
    expect(checked).toEqual([String(child.id)]);
    expect(persistence.getById(root.id)?.lifecycleStatus).toBe("starting");
  });

  const poolBody = () => ({
    ...creationBody(),
    pool: {
      candidates: [poolRequestedCandidate, poolFallbackCandidate],
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: true,
    },
  });

  it("stores one immutable pool-derived route for an accepted pool creation request", async () => {
    const { create, persistence } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: [
          candidateFacts(poolRequestedCandidate),
          candidateFacts(poolFallbackCandidate),
        ],
      }),
    });
    const run = await startedRun(create, poolBody());
    expect(run.lifecycleStatus).toBe("starting");
    expect(persistence.getById(run.id)?.routingReceipt.poolRoute?.decision).toMatchObject({
      kind: "selected",
      selectionKind: "requested",
    });
  });

  it("admits a pool child durably as Waiting when no candidate is eligible", async () => {
    const { create, persistence } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: [
          candidateFacts(poolRequestedCandidate, { modelAvailable: false }),
          candidateFacts(poolFallbackCandidate, { readiness: "unavailable" }),
        ],
      }),
    });
    const result = await create(poolBody());
    expect(result).toMatchObject({
      kind: "run-updated",
      run: { lifecycleStatus: "waiting", recoveryReason: "multi-model-pool-no-eligible-candidate" },
    });
    expect(persistence.getByRequestId(ids.request)?.routingReceipt.poolRoute?.decision.kind).toBe(
      "waiting",
    );
  });

  it("returns the original immutable pool decision on retry even after runtime facts change", async () => {
    const facts = {
      current: [candidateFacts(poolRequestedCandidate), candidateFacts(poolFallbackCandidate)],
    };
    const { create } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: facts.current,
      }),
    });
    await startedRun(create, poolBody());

    facts.current = [
      candidateFacts(poolRequestedCandidate, { modelAvailable: false }),
      candidateFacts(poolFallbackCandidate, { readiness: "unavailable" }),
    ];
    const retried = await startedRun(create, poolBody());
    expect(retried.routingReceipt.poolRoute?.decision).toMatchObject({
      kind: "selected",
      selectionKind: "requested",
    });
  });

  it("rejects a pool request ID reused with a different pool", async () => {
    const { create } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: [
          candidateFacts(poolRequestedCandidate),
          candidateFacts(poolFallbackCandidate),
        ],
      }),
    });
    await startedRun(create, poolBody());

    expect(
      await create({ ...poolBody(), pool: { ...poolBody().pool, fallbackAllowed: false } }),
    ).toMatchObject({ kind: "invalid", status: 409 });
    expect(await create(creationBody())).toMatchObject({ kind: "invalid", status: 409 });
  });

  it("fails closed when a pool is selected but pool routing is unavailable on this host", async () => {
    const { create } = createHandler();
    expect(await create(poolBody())).toMatchObject({ kind: "invalid", status: 400 });
  });

  it("serializes honest route receipt data in the parent summary response", async () => {
    const { handler, token, create } = createHandler();
    await startedRun(create);
    const response = await handler(
      new Request(`http://127.0.0.1/api/agent-runs/parent-summary?parentThreadId=${ids.thread}`, {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      entries: Array<{ route?: Record<string, unknown> }>;
    };
    expect(body.entries[0]?.route).toEqual({
      requestedProviderInstanceId: ids.provider,
      requestedModelId: "gpt-4o",
      executionProviderInstanceId: ids.provider,
      executionModelId: "gpt-4o",
      poolDerived: false,
    });
  });

  it("rejects unauthenticated cancellation", async () => {
    const { handler } = createHandler();
    const cancelResponse = await handler(
      new Request("http://127.0.0.1/api/agent-runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: ids.run, scope: "self" }),
      }),
    );
    expect(cancelResponse?.status).toBe(401);
  });

  const workspaceReceipt = "66666666-6666-4666-8666-666666666666";
  const bindingRevision = "88888888-8888-4888-8888-888888888888";
  const projectId = "77777777-7777-4777-8777-777777777777";

  function workspaceStub(mode: "chat" | "work" | "code" = "chat") {
    return {
      prepare: async () =>
        mode === "chat"
          ? {
              status: "prepared" as const,
              workspace: {
                kind: "chat-virtual" as const,
                mode: "chat" as const,
                receiptId: workspaceReceipt as never,
              },
            }
          : mode === "work"
            ? {
                status: "prepared" as const,
                workspace: {
                  kind: "work-root" as const,
                  mode: "work" as const,
                  receiptId: workspaceReceipt as never,
                  projectId: projectId as never,
                  bindingRevisionId: bindingRevision as never,
                },
              }
            : {
                status: "prepared" as const,
                workspace: {
                  kind: "code-worktree" as const,
                  mode: "code" as const,
                  worktreeReceiptId: workspaceReceipt as never,
                  confirmation: "prepared" as const,
                },
              },
      confirm: async () => ({
        status: "confirmed" as const,
        workspace: {
          kind: "code-worktree" as const,
          mode: "code" as const,
          worktreeReceiptId: workspaceReceipt as never,
          confirmation: "confirmed" as const,
        },
      }),
      admit: async () =>
        mode === "work"
          ? {
              status: "admitted" as const,
              workspace: {
                kind: "work-root" as const,
                mode: "work" as const,
                projectId: projectId as never,
                bindingRevisionId: bindingRevision as never,
                canonicalRoot: "/projects/demo",
              },
            }
          : mode === "code"
            ? {
                status: "admitted" as const,
                workspace: {
                  kind: "code-worktree" as const,
                  mode: "code" as const,
                  projectId: projectId as never,
                  checkoutRoot: "/repo",
                  worktreeRoot: "/repo/.octant/worktrees/child",
                  verified: true,
                },
              }
            : {
                status: "admitted" as const,
                workspace: { kind: "chat-virtual" as const, mode: "chat" as const },
              },
    };
  }

  it("admits a Work child from a prepared receipt and refuses parent-checkout Code receipts", async () => {
    const work = createHandler({ parentMode: "work", workspace: workspaceStub("work") });
    await startedRun(work.create, { ...creationBody(), role: "research" });

    const code = createHandler({
      parentMode: "code",
      workspace: {
        ...workspaceStub("code"),
        admit: async () => ({ status: "refused" as const, reason: "parent-checkout" as const }),
      },
    });
    expect(await code.create({ ...creationBody(), role: "implementation" })).toEqual({
      kind: "refused",
      reason: "parent-checkout",
      status: 400,
    });
  });

  it("steers a live child at the expected version and refuses a stale one", async () => {
    const { handler, token, persistence, create } = createHandler();
    const run = await startedRun(create);
    persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: run.id,
      expectedVersion: run.version,
    });
    const stale = await handler(
      new Request("http://127.0.0.1/api/agent-runs/steer", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({
          runId: run.id,
          expectedVersion: 1,
          message: "Focus on the failing test.",
        }),
      }),
    );
    expect(stale?.status).toBe(409);
    expect(persistence.getById(run.id)?.lifecycleStatus).toBe("running");
  });

  it("retries a failed child at the expected version", async () => {
    const { handler, token, persistence, create } = createHandler();
    const run = await startedRun(create);
    persistence.applyCommand({
      kind: "fail-agent-run",
      runId: run.id,
      expectedVersion: run.version,
      recoveryReason: "provider-unavailable",
    });
    const failed = persistence.getById(run.id);
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/retry", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: run.id, expectedVersion: failed?.version }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { run: { lifecycleStatus: string } };
    expect(body.run.lifecycleStatus).toBe("starting");
  });

  it("requires an authorized explicit message to resume a completed child at a new generation", async () => {
    let authorized = true;
    const resume = vi.fn();
    const { handler, token, persistence, orchestration, create } = createHandler({
      authorizeParentThread: () => authorized,
      processes: {
        start: vi.fn(),
        resume,
        checkResume: () => ({ status: "ready" }),
        stop: async () => undefined,
      },
    });
    const run = await startedRun(create);
    orchestration.onSessionSettled({
      runId: run.id,
      outcome: { kind: "completed", responseText: "First answer" },
    });
    const finished = persistence.getById(run.id);
    if (finished === undefined) throw new Error("missing completion");
    const delivered = persistence.applyCommand({
      kind: "settle-agent-run-result-delivery",
      runId: finished.id,
      expectedVersion: finished.version,
      generation: finished.generation ?? 1,
      outcome: "delivered",
    });
    if (delivered.kind !== "run-updated") throw new Error("delivery failed");
    const completed = delivered.run;
    const post = (body: Record<string, unknown>) =>
      handler(
        new Request("http://127.0.0.1/api/agent-runs/resume", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify(body),
        }),
      );
    const base = { runId: run.id, expectedVersion: completed.version };
    expect((await post(base))?.status).toBe(400);
    expect((await post({ ...base, message: " " }))?.status).toBe(400);
    expect((await post({ ...base, message: "x".repeat(4097) }))?.status).toBe(400);
    authorized = false;
    expect((await post({ ...base, message: "Continue" }))?.status).toBe(403);
    authorized = true;
    expect((await post({ ...base, expectedVersion: 1, message: "Continue" }))?.status).toBe(409);
    expect(persistence.getById(run.id)).toEqual(completed);
    const response = await post({ ...base, message: "Explain this answer" });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      kind: "run-updated",
      run: { id: run.id, generation: 2, lifecycleStatus: "starting" },
    });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }), {
      message: "Explain this answer",
    });
    expect((await post({ ...base, message: "duplicate" }))?.status).toBe(409);
    expect(resume).toHaveBeenCalledOnce();
  });

  it.each([
    ["provider", false],
    ["model", false],
    ["reasoning", false],
    ["provider", true],
    ["model", true],
    ["reasoning", true],
  ] as const)(
    "refuses a removed %s on UI follow-up, including preflight drift: %s",
    async (removed, duringPreflight) => {
      let revoked = !duringPreflight;
      const resume = vi.fn();
      const { handler, token, persistence, orchestration, create } = createHandler({
        reasoning: "high",
        listTargets: () => [
          {
            providerInstanceId: revoked && removed === "provider" ? "unavailable" : ids.provider,
            modelIds: revoked && removed === "model" ? [] : ["gpt-4o"],
            reasoningByModel: { "gpt-4o": revoked && removed === "reasoning" ? [] : ["high"] },
            displayName: "Fixture",
            driverKind: "openai",
          },
        ],
        processes: {
          start: vi.fn(),
          resume,
          checkResume: async () => {
            revoked = true;
            return { status: "ready" };
          },
          stop: async () => undefined,
        },
      });
      const run = await startedRun(create);
      expect(run.routingReceipt.rawReasoning).toBe("high");
      orchestration.onSessionSettled({
        runId: run.id,
        outcome: { kind: "completed", responseText: "First answer" },
      });
      const finished = persistence.getById(run.id);
      if (finished === undefined) throw new Error("Missing completion");
      const delivered = persistence.applyCommand({
        kind: "settle-agent-run-result-delivery",
        runId: finished.id,
        expectedVersion: finished.version,
        generation: finished.generation ?? 1,
        outcome: "delivered",
      });
      if (delivered.kind !== "run-updated") throw new Error("Delivery failed");
      const response = await handler(
        new Request("http://127.0.0.1/api/agent-runs/resume", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify({
            runId: run.id,
            expectedVersion: delivered.run.version,
            message: "Continue",
          }),
        }),
      );
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({
        kind: "run-command-failed",
        reason: "unsupported-transition",
      });
      expect(resume).not.toHaveBeenCalled();
      expect(persistence.getById(run.id)).toEqual(delivered.run);
    },
  );

  it("resumes a waiting child and refuses a restart interruption without resume evidence", async () => {
    const { handler, token, persistence, create } = createHandler();
    const run = await startedRun(create);
    persistence.applyCommand({
      kind: "interrupt-agent-run",
      runId: run.id,
      expectedVersion: run.version,
      recoveryReason: "restart-without-resumable-execution",
    });
    const interrupted = persistence.getById(run.id);
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/resume", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: run.id, expectedVersion: interrupted?.version }),
      }),
    );
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ kind: "run-command-failed" });
  });
});
