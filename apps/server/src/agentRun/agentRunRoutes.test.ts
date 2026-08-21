import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AgentRunRequested,
  AgentRunResultAcknowledged,
  AgentRunStatusChanged,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  decodeMultiModelRoutingVendorId,
  decodeWindowId,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunId,
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
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
} from "./agentRunEventStore";
import {
  AgentRunOrchestrationService,
  createInMemoryCapacityPort,
} from "./agentRunOrchestrationService";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProjection } from "./agentRunProjection";
import { createAgentRunRouteHandler, type AgentRunRouteDependencies } from "./agentRunRoutes";

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
      }) => ReadonlyArray<{ readonly kind: string; readonly text: string }> | undefined;
    };
    readonly parentMode?: "chat" | "work" | "code";
    readonly workspace?: AgentRunRouteDependencies["workspace"];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = new EventRegistry()
    .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
    .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
    .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged);
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
    processes: { start: () => undefined, stop: async () => undefined },
  });
  let readyProviderId = ids.provider;
  let creationPosture: "off" | "ask" | "automatic" = "automatic";
  const handler = createAgentRunRouteHandler({
    windowAuthorityStore,
    persistence,
    orchestration,
    settings: {
      current: () => ({ creationPosture, version: 1 as never, updatedAt: now as never }),
    },
    providerReadiness: {
      isReady: ({ providerInstanceId }) => providerInstanceId === readyProviderId,
    },
    authorizeCreation: () => {
      if (options.authorizeCreation?.() === false) return undefined;
      const parentMode = options.parentMode ?? "chat";
      const parentAuthority =
        parentMode === "work"
          ? {
              ...authority,
              filesystem: true,
              executionPolicy: "approval-gated" as const,
              subagents: true,
            }
          : parentMode === "code"
            ? {
                ...authority,
                filesystem: true,
                shell: true,
                git: true,
                executionPolicy: "approval-gated" as const,
                subagents: true,
              }
            : { ...authority, subagents: true };
      return {
        parentMode,
        parentAuthority,
        liveAuthority: parentAuthority,
        workspaceParent: {
          threadId: String(ids.thread),
          mode: parentMode,
        },
      };
    },
    authorizeCancellation: ({ run }) => options.authorizeCancellation?.({ run }) ?? true,
    authorizeParentThread: (input) => options.authorizeParentThread?.(input) ?? true,
    ...(options.poolRouting === undefined ? {} : { poolRouting: options.poolRouting }),
    ...(options.parentContext === undefined
      ? {}
      : { parentContext: options.parentContext as never }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `cccccccc-cccc-4ccc-8ccc-${n.toString(16).padStart(12, "0")}`;
      };
    })(),
    now: () => 0,
  });
  return {
    handler,
    persistence,
    orchestration,
    token,
    connection,
    setReadyProvider: (id: string) => {
      readyProviderId = id;
    },
    setCreationPosture: (posture: "off" | "ask" | "automatic") => {
      creationPosture = posture;
    },
  };
}

describe("agentRunRoutes", () => {
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
    role: "research",
    task: "Summarize the open PRs in this repository.",
    mode: "chat",
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    requestedAuthority: authority,
    workspace: { kind: "chat-virtual", mode: "chat" },
  });

  it("creates a child run from an explicit request under Automatic posture", async () => {
    const { handler, token } = createHandler();
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { kind: string; run: { lifecycleStatus: string } };
    expect(body.kind).toBe("run-updated");
    expect(body.run.lifecycleStatus).toBe("starting");
  });

  it("denies creation when the posture is Off, regardless of any client-claimed posture", async () => {
    const { handler, token, setCreationPosture } = createHandler();
    setCreationPosture("off");
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );
    expect(response?.status).toBe(409);
    const body = (await response!.json()) as { reason?: string };
    expect(body.reason).toBe("posture-rejected");
  });

  it("denies creation unless the authenticated window owns the actual parent thread", async () => {
    const { handler, token } = createHandler({ authorizeCreation: () => false });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );
    expect(response?.status).toBe(403);
  });

  it("refuses a child whose requested mode does not match its actual parent thread", async () => {
    const { handler, persistence, token } = createHandler({ parentMode: "code" });

    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      status: "refused",
      reason: "unsupported",
    });
    expect(persistence.getByRequestId(ids.request)).toBeUndefined();
  });

  it("does not reserve capacity again when the request id is retried", async () => {
    const capacity = createInMemoryCapacityPort();
    const reserve = vi.spyOn(capacity, "tryReserve");
    const { handler, token } = createHandler({ capacity });
    const request = () =>
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      });

    expect((await handler(request()))?.status).toBe(200);
    expect((await handler(request()))?.status).toBe(200);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("returns an idempotent receipt before mutable provider readiness is rechecked", async () => {
    const { handler, token, setReadyProvider } = createHandler();
    const request = () =>
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      });

    expect((await handler(request()))?.status).toBe(200);
    setReadyProvider("99999999-9999-4999-8999-999999999999");

    const retry = await handler(request());
    expect(retry?.status).toBe(200);
    expect(await retry!.json()).toMatchObject({
      kind: "run-accepted",
      run: { id: ids.run, lifecycleStatus: "starting" },
    });
  });

  it("rejects a request ID reused for a different parent or authority", async () => {
    const { handler, token } = createHandler();
    const request = (body: Record<string, unknown>) =>
      handler(
        new Request("http://127.0.0.1/api/agent-runs/request", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify(body),
        }),
      );

    expect((await request(creationBody()))?.status).toBe(200);

    const wrongParent = await request({
      ...creationBody(),
      parentThreadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccd",
    });
    expect(wrongParent?.status).toBe(409);
    expect(await wrongParent!.json()).toEqual({
      error: "AgentRun request ID cannot be reused for a different authorized request.",
    });

    const widenedAuthority = await request({
      ...creationBody(),
      requestedAuthority: { ...authority, tools: false },
    });
    expect(widenedAuthority?.status).toBe(409);
    expect(await widenedAuthority!.json()).toEqual({
      error: "AgentRun request ID cannot be reused for a different authorized request.",
    });
  });

  it("stores the admitted parent context and journals only its identity", async () => {
    const { handler, token, connection } = createHandler({
      parentContext: {
        resolve: () => [{ kind: "user-message", text: "Which service paged first?" }],
      },
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ ...creationBody(), includeParentContext: true }),
      }),
    );

    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      readonly run: {
        readonly id: AgentRunId;
        readonly routingReceipt: { readonly contextSnapshotId: string };
      };
    };
    // The receipt records what the child was admitted with, not the parent's
    // words: the blocks are that thread's conversation and go to the store.
    expect(body).toMatchObject({ run: { routingReceipt: { admittedContextBlocks: 1 } } });
    expect(
      readAgentRunAdmittedContext(connection, {
        runId: body.run.id,
        contextSnapshotId: body.run.routingReceipt.contextSnapshotId as never,
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
      const { handler, token } = createHandler({
        ...(parentContext === undefined ? {} : { parentContext }),
      });
      const response = await handler(
        new Request("http://127.0.0.1/api/agent-runs/request", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify({ ...creationBody(), includeParentContext: true }),
        }),
      );

      expect(response?.status).toBe(400);
    }
  });

  it("rejects a request ID reused with a different parent-context ask", async () => {
    const { handler, token } = createHandler({
      parentContext: {
        resolve: () => [{ kind: "user-message", text: "Which service paged first?" }],
      },
    });
    const request = (body: Record<string, unknown>) =>
      handler(
        new Request("http://127.0.0.1/api/agent-runs/request", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify(body),
        }),
      );

    expect((await request({ ...creationBody(), includeParentContext: true }))?.status).toBe(200);

    const retried = await request(creationBody());
    expect(retried?.status).toBe(409);
  });

  it("rejects creation for an unconfigured provider", async () => {
    const { handler, token, setReadyProvider } = createHandler();
    setReadyProvider("99999999-9999-4999-8999-999999999999");
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects Code-mode creation because worktree isolation is not yet wired", async () => {
    const { handler, token } = createHandler();
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ ...creationBody(), mode: "code" }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("returns a structured limit result once the global active-run ceiling is reached", async () => {
    const { handler, token } = createHandler();
    const distinctThread = (n: number) =>
      decodeAgentRunParentThreadId(`33333333-3333-4333-8333-33333333333${n}`);
    for (let i = 0; i < 4; i++) {
      const response = await handler(
        new Request("http://127.0.0.1/api/agent-runs/request", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify({
            ...creationBody(),
            requestId: decodeAgentRunRequestId(`bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${i}`),
            parentThreadId: distinctThread(i),
          }),
        }),
      );
      expect(response?.status).toBe(200);
    }
    const fifth = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({
          ...creationBody(),
          requestId: decodeAgentRunRequestId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4"),
          parentThreadId: distinctThread(4),
        }),
      }),
    );
    expect(fifth?.status).toBe(409);
    const fifthBody = (await fifth!.json()) as { reason?: string };
    expect(fifthBody.reason).toBe("limit-reached");
  });

  it("cancels a run through the cancel route", async () => {
    const { handler, token, orchestration } = createHandler();
    const created = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );
    const createdBody = (await created!.json()) as { run: { id: string; version: number } };
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: createdBody.run.id, scope: "self" }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      results: Array<{ run?: { lifecycleStatus: string } }>;
    };
    expect(body.results[0]?.run?.lifecycleStatus).toBe("cancelled");
    void orchestration;
  });

  it("rejects cancellation when the authenticated window does not own the parent thread", async () => {
    const { handler, token, persistence } = createHandler({ authorizeCancellation: () => false });
    const created = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );
    const createdBody = (await created!.json()) as { run: { id: string } };
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: createdBody.run.id, scope: "self" }),
      }),
    );

    expect(response?.status).toBe(403);
    expect(persistence.getById(createdBody.run.id as never)?.lifecycleStatus).toBe("starting");
  });

  it("authorizes every descendant before cancelling a subtree", async () => {
    const checked: string[] = [];
    const { handler, token, persistence } = createHandler({
      authorizeCancellation: ({ run }) => {
        checked.push(String(run.id));
        return run.parentRunId === undefined;
      },
    });
    const create = (body: Record<string, unknown>) =>
      handler(
        new Request("http://127.0.0.1/api/agent-runs/request", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify(body),
        }),
      );
    const root = await create({
      ...creationBody(),
      requestedAuthority: { ...authority, subagents: true },
    });
    const rootBody = (await root!.json()) as { run: { id: string } };
    const child = await create({
      ...creationBody(),
      requestId: "22222222-2222-4222-8222-222222222223",
      parentRunId: rootBody.run.id,
    });
    expect(child?.status).toBe(200);
    const childBody = (await child!.json()) as { run: { id: string } };
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ runId: rootBody.run.id, scope: "subtree" }),
      }),
    );
    expect(response?.status).toBe(403);
    // Leaf-first authorization must reach the linked child before it can
    // cancel the parent. It fails there, so the parent remains untouched.
    expect(checked).toEqual([childBody.run.id]);
    expect(persistence.getById(rootBody.run.id as never)?.lifecycleStatus).toBe("starting");
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
    const { handler, token, persistence } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: [
          candidateFacts(poolRequestedCandidate),
          candidateFacts(poolFallbackCandidate),
        ],
      }),
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(poolBody()),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      kind: string;
      run: { id: string; lifecycleStatus: string };
    };
    expect(body.run.lifecycleStatus).toBe("starting");
    const persisted = persistence.getById(body.run.id as never);
    expect(persisted?.routingReceipt.poolRoute?.decision).toMatchObject({
      kind: "selected",
      selectionKind: "requested",
    });
  });

  it("admits a pool child durably as Waiting when no candidate is eligible", async () => {
    const { handler, token, persistence } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: [
          candidateFacts(poolRequestedCandidate, { modelAvailable: false }),
          candidateFacts(poolFallbackCandidate, { readiness: "unavailable" }),
        ],
      }),
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(poolBody()),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      kind: string;
      run: { id: string; lifecycleStatus: string; recoveryReason?: string };
    };
    expect(body.kind).toBe("run-updated");
    expect(body.run.lifecycleStatus).toBe("waiting");
    expect(body.run.recoveryReason).toBe("multi-model-pool-no-eligible-candidate");
    expect(persistence.getById(body.run.id as never)?.routingReceipt.poolRoute?.decision.kind).toBe(
      "waiting",
    );
  });

  it("returns the original immutable pool decision on retry even after runtime facts change", async () => {
    const facts = {
      current: [candidateFacts(poolRequestedCandidate), candidateFacts(poolFallbackCandidate)],
    };
    const { handler, token } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: facts.current,
      }),
    });
    const request = () =>
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(poolBody()),
      });
    expect((await handler(request()))?.status).toBe(200);

    facts.current = [
      candidateFacts(poolRequestedCandidate, { modelAvailable: false }),
      candidateFacts(poolFallbackCandidate, { readiness: "unavailable" }),
    ];
    const retry = await handler(request());
    expect(retry?.status).toBe(200);
    const retryBody = (await retry!.json()) as {
      run: {
        routingReceipt: { poolRoute?: { decision: { kind: string; selectionKind?: string } } };
      };
    };
    expect(retryBody.run.routingReceipt.poolRoute?.decision).toMatchObject({
      kind: "selected",
      selectionKind: "requested",
    });
  });

  it("rejects a pool request ID reused with a different pool", async () => {
    const { handler, token } = createHandler({
      poolRouting: () => ({
        parentCandidate: poolRequestedCandidate,
        runtimeFacts: [
          candidateFacts(poolRequestedCandidate),
          candidateFacts(poolFallbackCandidate),
        ],
      }),
    });
    const request = (body: Record<string, unknown>) =>
      handler(
        new Request("http://127.0.0.1/api/agent-runs/request", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": token },
          body: JSON.stringify(body),
        }),
      );
    expect((await request(poolBody()))?.status).toBe(200);

    const differentPool = await request({
      ...poolBody(),
      pool: { ...poolBody().pool, fallbackAllowed: false },
    });
    expect(differentPool?.status).toBe(409);

    const withoutPool = await request(creationBody());
    expect(withoutPool?.status).toBe(409);
  });

  it("fails closed when a pool is selected but pool routing is unavailable on this host", async () => {
    const { handler, token } = createHandler();
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(poolBody()),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("serializes honest route receipt data in the parent summary response", async () => {
    const { handler, token } = createHandler();
    const created = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(creationBody()),
      }),
    );
    expect(created?.status).toBe(200);
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

  it("rejects unauthenticated creation and cancellation", async () => {
    const { handler } = createHandler();
    const createResponse = await handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(creationBody()),
      }),
    );
    expect(createResponse?.status).toBe(401);
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

  it("prepares a research-only Chat virtual workspace without a filesystem path", async () => {
    const { handler, token } = createHandler({ workspace: workspaceStub("chat") });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/workspaces/prepare", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ parentThreadId: ids.thread }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      status: "prepared",
      workspace: { kind: "chat-virtual", mode: "chat", receiptId: workspaceReceipt },
    });
  });

  it("prepares a Work workspace bound to the current Project and binding revision", async () => {
    const { handler, token } = createHandler({
      parentMode: "work",
      workspace: workspaceStub("work"),
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/workspaces/prepare", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ parentThreadId: ids.thread }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      workspace: Record<string, unknown>;
    };
    expect(body.workspace).toEqual({
      kind: "work-root",
      mode: "work",
      receiptId: workspaceReceipt,
      projectId,
      bindingRevisionId: bindingRevision,
    });
    expect(body.workspace.canonicalRoot).toBeUndefined();
  });

  it("confirms a Code child worktree receipt without returning paths", async () => {
    const { handler, token } = createHandler({
      parentMode: "code",
      workspace: workspaceStub("code"),
    });
    const prepared = await handler(
      new Request("http://127.0.0.1/api/agent-runs/workspaces/prepare", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ parentThreadId: ids.thread }),
      }),
    );
    expect(prepared?.status).toBe(200);
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/workspaces/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({
          parentThreadId: ids.thread,
          worktreeReceiptId: workspaceReceipt,
        }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      status: "confirmed",
      workspace: {
        kind: "code-worktree",
        mode: "code",
        worktreeReceiptId: workspaceReceipt,
        confirmation: "confirmed",
      },
    });
  });

  it("refuses workspace preparation when the window does not own the parent thread", async () => {
    const { handler, token } = createHandler({
      authorizeCreation: () => false,
      workspace: workspaceStub("chat"),
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-runs/workspaces/prepare", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify({ parentThreadId: ids.thread }),
      }),
    );
    expect(response?.status).toBe(403);
    expect(await response!.json()).toEqual({ status: "refused", reason: "unauthorized" });
  });

  it("admits a Work child from a prepared receipt and refuses parent-checkout Code receipts", async () => {
    const work = createHandler({ parentMode: "work", workspace: workspaceStub("work") });
    const workResponse = await work.handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": work.token,
        },
        body: JSON.stringify({
          ...creationBody(),
          mode: "work",
          requestedAuthority: {
            filesystem: true,
            shell: false,
            git: false,
            network: false,
            tools: true,
            subagents: false,
            executionPolicy: "approval-gated",
            permissionPersistence: "current-session",
          },
          workspace: { kind: "work-root", mode: "work", receiptId: workspaceReceipt },
        }),
      }),
    );
    expect(workResponse?.status).toBe(200);

    const code = createHandler({
      parentMode: "code",
      workspace: {
        ...workspaceStub("code"),
        admit: async () => ({ status: "refused" as const, reason: "parent-checkout" as const }),
      },
    });
    const codeResponse = await code.handler(
      new Request("http://127.0.0.1/api/agent-runs/request", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": code.token,
        },
        body: JSON.stringify({
          ...creationBody(),
          mode: "code",
          role: "implementation",
          requestedAuthority: {
            filesystem: true,
            shell: true,
            git: false,
            network: false,
            tools: true,
            subagents: false,
            executionPolicy: "approval-gated",
            permissionPersistence: "current-session",
          },
          workspace: {
            kind: "code-worktree",
            mode: "code",
            worktreeReceiptId: workspaceReceipt,
          },
        }),
      }),
    );
    expect(codeResponse?.status).toBe(400);
    expect(await codeResponse!.json()).toEqual({
      status: "refused",
      reason: "parent-checkout",
    });
  });
});
