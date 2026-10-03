import { randomUUID } from "node:crypto";
import { readAgentRunResultText } from "../persistence/agentRunContentStore";
import { AgentRunSessionError } from "./agentRunSessionPort";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN_DEPENDENCY_WAITING_REASON } from "@octant/domain";
import { Effect, Schema } from "effect";
import {
  AgentRunRequested,
  AgentRunResultDeliverySettled,
  AgentRunResultAcknowledged,
  AgentRunStatusChanged,
  MAX_AGENT_RUN_RESULT_CHARACTERS,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  decodeNativeHarnessSlotCandidate,
  type AgentRunAuthority,
  type AgentRunCommand,
  type AgentRunRoutingReceipt,
  type AgentRunWorkspaceReceipt,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { registerNativeHarnessEvents } from "../harness/nativeHarnessEvents";
import { NativeHarnessSessionStore } from "../harness/nativeHarnessSessionStore";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_DELIVERY_SETTLED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
} from "./agentRunEventStore";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProjection } from "./agentRunProjection";
import {
  AgentRunOrchestrationError,
  AgentRunOrchestrationService,
  type AgentRunParentSessionPort,
  type AgentRunProcessSupervisorPort,
  createInMemoryCapacityPort,
} from "./agentRunOrchestrationService";
import { AgentRunProcessSupervisor } from "./agentRunProcessSupervisor";
import { AgentRunDependencyScheduler } from "./agentRunDependencyScheduler";
import type { AgentRunSessionOutcome } from "./agentRunSessionPort";
import { AgentRunSessionSupervisor } from "./agentRunSessionSupervisor";
import { createAgentRunSessionRuntime } from "./agentRunSessionRuntime";
import { makeProviderCapacityScheduler } from "../context/contextRuntime";

const directories: string[] = [];
const now = "2026-08-01T14:00:00.000Z";
afterEach(() => {
  while (directories.length) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  run: decodeAgentRunId("11111111-1111-4111-8111-111111111111"),
  child: decodeAgentRunId("12121212-1212-4121-8121-121212121212"),
  request: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222222"),
  requestChild: decodeAgentRunRequestId("23232323-2323-4232-8232-232323232323"),
  thread: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333333"),
  provider: "55555555-5555-4555-8555-555555555555",
  providerB: "56565656-5656-4565-8565-565656565656",
  snapshot: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
  project: "88888888-8888-4888-8888-888888888888",
};

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const otherThread = decodeAgentRunParentThreadId("34343434-3434-4343-8343-343434343434");

const authority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: true,
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
      subagents: true,
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
  capabilityDegradations: [],
  contextSnapshotId: ids.snapshot as never,
  effectiveAuthorityDigest: "digest",
  usageQuality: "provider-reported",
  hostId: "local" as never,
  mode: "chat",
};

function requestCommand(
  requestId = ids.request,
  workspace: AgentRunWorkspaceReceipt = { kind: "chat-virtual", mode: "chat" },
  parentRunId?: typeof ids.run,
  routingReceipt: AgentRunRoutingReceipt = routing,
): Extract<AgentRunCommand, { kind: "request-agent-run" }> {
  return {
    kind: "request-agent-run",
    requestId,
    parentThreadId: ids.thread,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    role: "research",
    task: "Investigate",
    creationPosture: "automatic",
    requestedAuthority: authority,
    routingReceipt,
    workspaceReceipt: workspace,
  };
}

const poolRequestedCandidate = {
  hostId: "local",
  providerInstanceId: ids.provider,
  modelId: "gpt-4o",
} as never;
const poolFallbackCandidate = {
  hostId: "local",
  providerInstanceId: ids.providerB,
  modelId: "claude-x",
} as never;
const poolFixture = {
  candidates: [poolRequestedCandidate, poolFallbackCandidate],
  mixedVendorEnabled: true,
  fallbackAllowed: true,
  higherCostFallbackAllowed: true,
};

function poolRoutedReceipt(decision: "requested" | "fallback" | "waiting"): AgentRunRoutingReceipt {
  const shared = {
    request: {
      pool: poolFixture,
      requestedCandidate: poolRequestedCandidate,
      requiredCapabilities: [],
    },
    mode: "chat" as const,
    activeHostId: "local" as never,
    parentCandidate: poolRequestedCandidate,
  };
  const poolRoute =
    decision === "waiting"
      ? {
          decision: {
            kind: "waiting" as const,
            ...shared,
            eligibility: [
              {
                candidate: poolRequestedCandidate,
                eligible: false,
                reasons: ["model-unavailable" as const],
              },
              {
                candidate: poolFallbackCandidate,
                eligible: false,
                reasons: ["provider-not-ready" as const],
              },
            ],
            reason: "no-eligible-candidate" as const,
            message: "No selected model is currently eligible.",
          },
          decidedAt: now as never,
        }
      : {
          decision: {
            kind: "selected" as const,
            ...shared,
            eligibility:
              decision === "requested"
                ? [
                    { candidate: poolRequestedCandidate, eligible: true, reasons: [] },
                    { candidate: poolFallbackCandidate, eligible: true, reasons: [] },
                  ]
                : [
                    {
                      candidate: poolRequestedCandidate,
                      eligible: false,
                      reasons: ["model-unavailable" as const],
                    },
                    { candidate: poolFallbackCandidate, eligible: true, reasons: [] },
                  ],
            selectedCandidate:
              decision === "requested" ? poolRequestedCandidate : poolFallbackCandidate,
            selectionKind: decision,
            reason:
              decision === "requested"
                ? "The requested model is selected and eligible for this execution unit."
                : "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
          },
          decidedAt: now as never,
        };
  return {
    ...routing,
    ...(decision === "fallback"
      ? {
          selectedFallback: {
            providerInstanceId: ids.providerB as never,
            modelId: "claude-x" as never,
            reason:
              "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
          },
        }
      : {}),
    poolRoute: poolRoute as never,
  };
}

function createHarness(
  capacity = createInMemoryCapacityPort(),
  withProcesses = true,
  processOverride?: AgentRunProcessSupervisorPort,
  parentSessions?: AgentRunParentSessionPort,
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-orch-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3")) as SqliteConnection;
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = registerNativeHarnessEvents(
    new EventRegistry()
      .register(AGENT_RUN_RESULT_DELIVERY_SETTLED, 1, AgentRunResultDeliverySettled)
      .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
      .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
      .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged),
  );
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  let n = 0;
  const uuid = () => {
    n += 1;
    return n === 1
      ? ids.run
      : n === 2
        ? ids.child
        : `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;
  };
  const store = new AgentRunEventStore({ journal, uuid, actor });
  const projection = new AgentRunProjection();
  const persistence = new AgentRunPersistenceService({
    store,
    projection,
    uuid,
    clock: () => now,
    connection,
  });
  const worktree = {
    isVerifiedIsolation: (workspace: { verified: boolean }) => workspace.verified,
    isParentCheckout: (workspace: { checkoutRoot: string; worktreeRoot: string }) =>
      workspace.checkoutRoot === workspace.worktreeRoot,
  };
  const approvals = { isCurrent: () => true };
  const processes =
    processOverride ??
    (withProcesses
      ? ({
          start: (_run) => undefined,
          stop: async (_runId): Promise<void> => undefined,
        } satisfies AgentRunProcessSupervisorPort)
      : undefined);
  const orchestration = new AgentRunOrchestrationService({
    persistence,
    capacity,
    worktree,
    approvals,
    ...(processes === undefined ? {} : { processes }),
    ...(parentSessions === undefined ? {} : { parentSessions }),
  });
  return { orchestration, persistence, capacity, approvals, store, connection, journal };
}

describe("AgentRunOrchestrationService", () => {
  it("admits a chat child, reserves capacity, and starts after live authority recheck", () => {
    const { orchestration } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    const started = orchestration.start(admitted.run.id, admitted.run.version, authority);
    expect(started.kind).toBe("run-updated");
    if (started.kind !== "run-updated") return;
    expect(started.run.lifecycleStatus).toBe("starting");
  });

  it("admits when live authority is narrower than the mode ceiling and clamps the child to it", () => {
    const { orchestration, persistence } = createHarness();
    const modeCeiling = {
      ...authority,
      filesystem: true,
      shell: true,
      git: true,
      network: true,
      executionPolicy: "approval-gated" as const,
    };
    const liveAuthority = {
      ...authority,
      filesystem: true,
      shell: false,
      git: false,
      network: false,
      executionPolicy: "plan" as const,
      permissionPersistence: "current-session" as const,
    };
    const admitted = orchestration.admit({
      command: {
        ...requestCommand(),
        requestedAuthority: {
          filesystem: false,
          shell: false,
          git: false,
          network: false,
          tools: true,
          subagents: false,
          executionPolicy: "plan",
          permissionPersistence: "current-session",
        },
      },
      parentAuthority: modeCeiling,
      confirmed: true,
      liveAuthority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    expect(admitted.run.authority.shell).toBe(false);
    expect(admitted.run.authority.executionPolicy).toBe("plan");
    expect(persistence.getById(admitted.run.id)?.authority.network).toBe(false);
  });

  it("rejects admission when live authority claims wider rights than the parent ceiling", () => {
    const { orchestration } = createHarness();
    expect(() =>
      orchestration.admit({
        command: requestCommand(),
        parentAuthority: {
          ...authority,
          shell: false,
          executionPolicy: "plan",
        },
        confirmed: true,
        liveAuthority: {
          ...authority,
          shell: true,
          executionPolicy: "approval-gated",
        },
      }),
    ).toThrow(/drift|wider/i);
  });

  it("rejects admission when managed child execution is unsupported", () => {
    const { orchestration } = createHarness(createInMemoryCapacityPort(), false);

    expect(() =>
      orchestration.admit({
        command: requestCommand(),
        parentAuthority: authority,
        confirmed: true,
        liveAuthority: authority,
      }),
    ).toThrow(/execution.*unsupported|execution.*unavailable|supervisor/i);
  });

  it("denies code execution in the parent checkout and unverified worktrees", () => {
    const { orchestration } = createHarness();
    expect(() =>
      orchestration.admit({
        command: requestCommand(ids.request, {
          kind: "code-worktree",
          mode: "code",
          projectId: ids.project as never,
          checkoutRoot: "/repo",
          worktreeRoot: "/repo",
          verified: true,
        }),
        parentAuthority: {
          ...authority,
          filesystem: true,
          shell: true,
          git: true,
          executionPolicy: "approval-gated",
        },
        confirmed: true,
        liveAuthority: {
          ...authority,
          filesystem: true,
          shell: true,
          git: true,
          executionPolicy: "approval-gated",
        },
      }),
    ).toThrow(/parent checkout/i);

    expect(() =>
      orchestration.admit({
        command: requestCommand(ids.requestChild, {
          kind: "code-worktree",
          mode: "code",
          projectId: ids.project as never,
          checkoutRoot: "/repo",
          worktreeRoot: "/repo/.oo/wt",
          verified: false,
        }),
        parentAuthority: {
          ...authority,
          filesystem: true,
          shell: true,
          git: true,
          executionPolicy: "approval-gated",
        },
        confirmed: true,
        liveAuthority: {
          ...authority,
          filesystem: true,
          shell: true,
          git: true,
          executionPolicy: "approval-gated",
        },
      }),
    ).toThrow(AgentRunOrchestrationError);
  });

  it("durably waits when capacity is saturated, including on an idempotent retry", () => {
    const capacity = createInMemoryCapacityPort(() => ({ perThread: 4, onHost: 4 }));
    // saturate the app's four slots with another thread's runs
    for (let i = 0; i < 4; i += 1) {
      capacity.tryReserve({
        runId: ids.run,
        providerInstanceId: ids.provider,
        parentThreadId: otherThread,
      });
    }
    const reserve = vi.spyOn(capacity, "tryReserve");
    const { orchestration, persistence } = createHarness(capacity);
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-updated");
    if (admitted.kind !== "run-updated") return;
    expect(admitted.run.lifecycleStatus).toBe("waiting");
    expect(admitted.run.recoveryReason).toMatch(/capacity/i);
    expect(persistence.getById(admitted.run.id)).toMatchObject({
      lifecycleStatus: "waiting",
      recoveryReason: "provider-capacity-saturated",
    });

    const retry = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(retry).toMatchObject({ kind: "run-accepted", run: { lifecycleStatus: "waiting" } });
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("reserves and starts the next capacity waiter when a reservation is released", () => {
    const capacity = createInMemoryCapacityPort(() => ({ perThread: 4, onHost: 4 }));
    const starts: string[] = [];
    const { orchestration, persistence } = createHarness(capacity, true, {
      start: (run) => {
        starts.push(String(run.id));
      },
      stop: async () => undefined,
    });
    const occupyingRun = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(occupyingRun.kind).toBe("run-accepted");
    if (occupyingRun.kind !== "run-accepted") return;

    // Fill the remaining shared provider slots. The subsequent child is
    // admitted durably but waits for capacity rather than being discarded.
    for (let i = 0; i < 3; i += 1) {
      capacity.tryReserve({
        runId: decodeAgentRunId(`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`),
        providerInstanceId: ids.provider,
        parentThreadId: otherThread,
      });
    }
    const waitingRun = orchestration.admit({
      command: requestCommand(ids.requestChild),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(waitingRun).toMatchObject({
      kind: "run-updated",
      run: { lifecycleStatus: "waiting", recoveryReason: "provider-capacity-saturated" },
    });
    if (waitingRun.kind !== "run-updated") return;

    orchestration.onProcessDeath(occupyingRun.run.id, occupyingRun.run.version);

    expect(persistence.getById(waitingRun.run.id)?.lifecycleStatus).toBe("starting");
    expect(persistence.getById(waitingRun.run.id)).not.toHaveProperty("recoveryReason");
    expect(starts).toEqual([String(waitingRun.run.id)]);
  });

  it("cancels leaf-first for a subtree", async () => {
    const { orchestration, persistence } = createHarness();
    const parent = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(parent.kind).toBe("run-accepted");
    if (parent.kind !== "run-accepted") return;
    const child = orchestration.admit({
      command: requestCommand(
        ids.requestChild,
        { kind: "chat-virtual", mode: "chat" },
        parent.run.id,
      ),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(child.kind).toBe("run-accepted");
    if (child.kind !== "run-accepted") return;

    const results = await orchestration.cancelLeafFirst({ runId: parent.run.id, scope: "subtree" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(persistence.getById(child.run.id)?.lifecycleStatus).toBe("cancelled");
    expect(persistence.getById(parent.run.id)?.lifecycleStatus).toBe("cancelled");
    // child cancelled before parent in result order
    const statuses = results
      .filter((result) => result.kind === "run-updated")
      .map((result) => (result.kind === "run-updated" ? result.run.id : null));
    expect(statuses.indexOf(child.run.id)).toBeLessThan(statuses.indexOf(parent.run.id));
  });

  it("keeps the run and its reservation live when process termination is not confirmed", async () => {
    const capacity = createInMemoryCapacityPort();
    const release = vi.spyOn(capacity, "release");
    const { orchestration, persistence } = createHarness(capacity, true, {
      start: () => undefined,
      stop: async () => Promise.reject(new Error("termination timeout")),
    });
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;

    const results = await orchestration.cancelLeafFirst({ runId: admitted.run.id, scope: "self" });
    expect(results).toMatchObject([
      { kind: "run-command-failed", message: expect.stringMatching(/termination/i) },
    ]);
    expect(persistence.getById(admitted.run.id)?.lifecycleStatus).toBe("queued");
    expect(release).not.toHaveBeenCalled();
  });

  it("interrupts on process death without inventing completed", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);
    const running = persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: admitted.run.id,
      expectedVersion: (admitted.run.version + 1) as never,
    });
    expect(running.kind).toBe("run-updated");
    if (running.kind !== "run-updated") return;
    const interrupted = orchestration.onProcessDeath(admitted.run.id, running.run.version);
    expect(interrupted.kind).toBe("run-updated");
    if (interrupted.kind !== "run-updated") return;
    expect(interrupted.run.lifecycleStatus).toBe("interrupted");
    expect(interrupted.run.lifecycleStatus).not.toBe("completed");
  });

  it("waits when approval/extension drift is detected at start", () => {
    const harness = createHarness();
    harness.approvals.isCurrent = () => false;
    const admitted = harness.orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    const waited = harness.orchestration.start(admitted.run.id, admitted.run.version, authority);
    expect(waited.kind).toBe("run-updated");
    if (waited.kind !== "run-updated") return;
    expect(waited.run.lifecycleStatus).toBe("interrupted");
    expect(waited.run.recoveryReason).toMatch(/drift/i);
  });

  it("starts and stops the supervised child with the AgentRun lifecycle", async () => {
    let onExit: (() => void) | undefined;
    const supervisor = new AgentRunProcessSupervisor({
      port: {
        spawn: () => ({
          pid: 77,
          onExit: (listener) => {
            onExit = listener;
          },
          terminate: async () => onExit?.(),
        }),
      },
    });
    const { persistence, capacity } = createHarness();
    const orchestration = new AgentRunOrchestrationService({
      persistence,
      capacity,
      worktree: {
        isVerifiedIsolation: (workspace) => workspace.verified,
        isParentCheckout: (workspace) => workspace.checkoutRoot === workspace.worktreeRoot,
      },
      approvals: { isCurrent: () => true },
      processes: supervisor,
    });
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;

    const started = orchestration.start(admitted.run.id, admitted.run.version, authority);
    expect(started.kind).toBe("run-updated");
    expect(supervisor.activeRunIds()).toEqual([admitted.run.id]);

    await orchestration.cancelLeafFirst({ runId: admitted.run.id, scope: "self" });
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("interrupts an active run when its supervised process exits unexpectedly", () => {
    let onExit: (() => void) | undefined;
    const supervisor = new AgentRunProcessSupervisor({
      port: {
        spawn: () => ({
          pid: 78,
          onExit: (listener) => {
            onExit = listener;
          },
          terminate: async () => undefined,
        }),
      },
    });
    const { persistence, capacity } = createHarness();
    const orchestration = new AgentRunOrchestrationService({
      persistence,
      capacity,
      worktree: {
        isVerifiedIsolation: (workspace) => workspace.verified,
        isParentCheckout: (workspace) => workspace.checkoutRoot === workspace.worktreeRoot,
      },
      approvals: { isCurrent: () => true },
      processes: supervisor,
    });
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;

    const started = orchestration.start(admitted.run.id, admitted.run.version, authority);
    expect(started).toMatchObject({ kind: "run-updated", run: { lifecycleStatus: "starting" } });
    onExit?.();

    expect(persistence.getById(admitted.run.id)).toMatchObject({
      lifecycleStatus: "interrupted",
      recoveryReason: "provider-process-death",
    });
  });

  it("admits a pool-waiting child durably as Waiting without reserving capacity or starting", () => {
    const capacity = createInMemoryCapacityPort();
    const reserve = vi.spyOn(capacity, "tryReserve");
    const starts: string[] = [];
    const { orchestration, persistence } = createHarness(capacity, true, {
      start: (run) => {
        starts.push(String(run.id));
      },
      stop: async () => undefined,
    });

    const admitted = orchestration.admit({
      command: requestCommand(
        ids.request,
        { kind: "chat-virtual", mode: "chat" },
        undefined,
        poolRoutedReceipt("waiting"),
      ),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });

    expect(admitted).toMatchObject({
      kind: "run-updated",
      run: {
        lifecycleStatus: "waiting",
        recoveryReason: "multi-model-pool-no-eligible-candidate",
      },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
    if (admitted.kind !== "run-updated") return;
    const persisted = persistence.getById(admitted.run.id);
    expect(persisted?.lifecycleStatus).toBe("waiting");
    expect(persisted?.routingReceipt.poolRoute?.decision.kind).toBe("waiting");
  });

  it("reserves capacity on the explicit pool fallback target, not the unavailable primary", () => {
    const capacity = createInMemoryCapacityPort();
    const reserve = vi.spyOn(capacity, "tryReserve");
    const { orchestration } = createHarness(capacity);

    const admitted = orchestration.admit({
      command: requestCommand(
        ids.request,
        { kind: "chat-virtual", mode: "chat" },
        undefined,
        poolRoutedReceipt("fallback"),
      ),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });

    expect(admitted.kind).toBe("run-accepted");
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ providerInstanceId: ids.providerB }),
    );
  });

  it("refuses to start a pool-waiting run so the immutable decision cannot be bypassed", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(
        ids.request,
        { kind: "chat-virtual", mode: "chat" },
        undefined,
        poolRoutedReceipt("waiting"),
      ),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-updated");
    if (admitted.kind !== "run-updated") return;

    const started = orchestration.start(admitted.run.id, admitted.run.version, authority);
    expect(started).toMatchObject({
      kind: "run-command-failed",
      reason: "unsupported-transition",
    });
    expect(persistence.getById(admitted.run.id)?.lifecycleStatus).toBe("waiting");
  });

  it("persists each managed session outcome as the state that outcome actually reports", () => {
    const cases = [
      {
        outcome: { kind: "completed", responseText: "the answer" },
        status: "completed",
      },
      {
        outcome: { kind: "waiting", reason: "provider expects input" },
        status: "waiting",
        reason: /expects input/,
      },
      {
        outcome: { kind: "cancelled" },
        status: "cancelled",
      },
      {
        outcome: {
          kind: "failed",
          failure: { category: "provider-failed", message: "model refused" },
        },
        status: "failed",
        reason: /model refused/,
      },
      {
        outcome: { kind: "interrupted", reason: "deadline exceeded" },
        status: "interrupted",
        reason: /deadline exceeded/,
      },
    ] as const satisfies ReadonlyArray<{
      readonly outcome: AgentRunSessionOutcome;
      readonly status: string;
      readonly reason?: RegExp;
    }>;

    for (const testCase of cases) {
      const { orchestration, persistence } = createHarness();
      const admitted = orchestration.admit({
        command: requestCommand(),
        parentAuthority: authority,
        confirmed: true,
        liveAuthority: authority,
      });
      expect(admitted.kind).toBe("run-accepted");
      if (admitted.kind !== "run-accepted") return;
      orchestration.start(admitted.run.id, admitted.run.version, authority);

      orchestration.onSessionSettled({
        runId: admitted.run.id,
        outcome: testCase.outcome,
      });

      const settled = persistence.getById(admitted.run.id);
      expect(settled?.lifecycleStatus).toBe(testCase.status);
      if ("reason" in testCase) expect(settled?.recoveryReason).toMatch(testCase.reason);
    }
  });

  it("leaves the parent acknowledgement outstanding when a child completes", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "the answer" },
    });

    const completed = persistence.getById(admitted.run.id);
    expect(completed?.lifecycleStatus).toBe("completed");
    expect(completed?.resultAcknowledgement).toMatchObject({
      required: true,
      acknowledged: false,
    });
  });

  it("journals the managed reply with the completion so a restart replays it", () => {
    const harness = createHarness();
    const admitted = harness.orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    harness.orchestration.start(admitted.run.id, admitted.run.version, authority);

    harness.orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "  The provider fallback is safe.  " },
    });

    const completed = harness.persistence.getById(admitted.run.id);
    expect(completed?.lifecycleStatus).toBe("completed");
    expect(completed?.result).toEqual({
      reference: `octant://agent-run/${String(admitted.run.id)}/result`,
      truncated: false,
    });
    expect(harness.persistence.resultText(admitted.run.id)).toBe("The provider fallback is safe.");

    const rebuiltProjection = new AgentRunProjection();
    const rebuilt = new AgentRunPersistenceService({
      store: harness.store,
      projection: rebuiltProjection,
      uuid: () => ids.child,
      clock: () => now,
      connection: harness.connection,
    });
    // Replay rebuilds the reply's identity from the journal, and the stored
    // text is still there behind it: a restart hands the parent the same reply.
    rebuilt.rebuildFromJournal();
    expect(rebuilt.getById(admitted.run.id)?.result).toEqual(completed?.result);
    expect(
      rebuilt.parentSummary(ids.thread).find((entry) => entry.runId === admitted.run.id)
        ?.resultText,
    ).toBe("The provider fallback is safe.");
  });

  it("truncates an oversized managed reply with a stated marker instead of discarding it", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "a".repeat(MAX_AGENT_RUN_RESULT_CHARACTERS + 1) },
    });

    const completed = persistence.getById(admitted.run.id);
    expect(completed?.lifecycleStatus).toBe("completed");
    expect(completed?.result?.truncated).toBe(true);
    const storedReply = persistence.resultText(admitted.run.id);
    expect(storedReply?.length).toBeLessThanOrEqual(MAX_AGENT_RUN_RESULT_CHARACTERS);
    expect(storedReply).toMatch(/truncated at 16384 characters\]$/);
  });

  it("records a completion without a visible reply as failed rather than inventing a result", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "   " },
    });

    const settled = persistence.getById(admitted.run.id);
    expect(settled?.lifecycleStatus).toBe("failed");
    expect(settled?.recoveryReason).toMatch(/without-result/);
  });

  it("records a settlement whose journal append throws as failed with a precise reason", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    // The completion append fails once (e.g. the journal write throws); the
    // contained fail path must still record a durable terminal state instead
    // of leaving the run claiming to be active until restart.
    vi.spyOn(persistence, "applyCommand").mockImplementationOnce(() => {
      throw new Error("completion journal append failed");
    });

    const result = orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "the answer" },
    });

    expect(result?.kind).toBe("run-updated");
    const settled = persistence.getById(admitted.run.id);
    expect(settled?.lifecycleStatus).toBe("failed");
    expect(settled?.recoveryReason).toMatch(/settlement-persistence-failure/);
    expect(settled?.recoveryReason).toMatch(/completion journal append failed/);
  });

  it("returns a command failure instead of throwing when even the fail path cannot persist", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    vi.spyOn(persistence, "applyCommand").mockImplementation(() => {
      throw new Error("journal is gone");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = orchestration.onSessionSettled({
        runId: admitted.run.id,
        outcome: {
          kind: "failed",
          failure: { category: "provider-failed", message: "model refused" },
        },
      });

      expect(result).toMatchObject({ kind: "run-command-failed", reason: "invalid" });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps a repeated settle and a settle after recovery idempotent", () => {
    const { orchestration, persistence } = createHarness();
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "the answer" },
    });
    const first = persistence.getById(admitted.run.id);
    const repeated = orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "the answer" },
    });

    expect(repeated).toBeUndefined();
    expect(persistence.getById(admitted.run.id)?.version).toBe(first?.version);

    // A run already recovered as interrupted by restart reconciliation keeps
    // that terminal state; a late settle may not overwrite or re-apply it.
    const interruptedHarness = createHarness();
    const other = interruptedHarness.orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(other.kind).toBe("run-accepted");
    if (other.kind !== "run-accepted") return;
    interruptedHarness.orchestration.start(other.run.id, other.run.version, authority);
    interruptedHarness.persistence.reconcileAfterRestart();
    const recovered = interruptedHarness.persistence.getById(other.run.id);
    expect(recovered?.lifecycleStatus).toBe("interrupted");

    expect(
      interruptedHarness.orchestration.onSessionSettled({
        runId: other.run.id,
        outcome: { kind: "completed", responseText: "the answer" },
      }),
    ).toBeUndefined();
    expect(interruptedHarness.persistence.getById(other.run.id)).toEqual(recovered);
  });
});

describe("AgentRun dependency graphs", () => {
  const requestIds = [
    decodeAgentRunRequestId("24242424-2424-4242-8242-242424242424"),
    decodeAgentRunRequestId("25252525-2525-4252-8252-252525252525"),
    decodeAgentRunRequestId("26262626-2626-4262-8262-262626262626"),
  ] as const;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function graphHarness() {
    const starts: string[] = [];
    const processes: AgentRunProcessSupervisorPort = {
      start: (run) => {
        starts.push(String(run.id));
      },
      stop: async () => undefined,
    };
    let sessions: NativeHarnessSessionStore | undefined;
    // The rule the host wires: a paused session, or one a restart left
    // needing a check, holds its children.
    const parentSessions: AgentRunParentSessionPort = {
      isHeld: (parentThreadId) => {
        const status = sessions?.read(String(parentThreadId))?.session.status;
        return (
          status === "paused-by-user" ||
          status === "paused-by-advisor" ||
          status === "recovery-required"
        );
      },
    };
    const harness = createHarness(createInMemoryCapacityPort(), true, processes, parentSessions);
    sessions = new NativeHarnessSessionStore({
      journal: harness.journal,
      uuid: randomUUID,
      actor,
      clock: () => now,
    });
    sessions.ensure({
      threadId: String(ids.thread),
      mode: "chat",
      leadSlotId: "default" as never,
      lead: decodeNativeHarnessSlotCandidate({
        hostId: "00000000-0000-4000-8000-0000000000aa",
        providerInstanceId: ids.provider,
        modelId: "frontier-large",
      }),
    });
    const scheduler = new AgentRunDependencyScheduler({
      agentRuns: harness.persistence,
      orchestration: harness.orchestration,
    });
    const unsubscribe = harness.journal.subscribeCommitted((append) =>
      scheduler.onCommittedAppend(append),
    );
    /** What host boot does: interrupt live runs, then a fresh service and scheduler. */
    const restart = () => {
      unsubscribe();
      harness.persistence.reconcileAfterRestart();
      const orchestration = new AgentRunOrchestrationService({
        persistence: harness.persistence,
        capacity: createInMemoryCapacityPort(),
        worktree: { isVerifiedIsolation: () => true, isParentCheckout: () => false },
        approvals: { isCurrent: () => true },
        processes,
        parentSessions,
      });
      const restarted = new AgentRunDependencyScheduler({
        agentRuns: harness.persistence,
        orchestration,
      });
      harness.journal.subscribeCommitted((append) => restarted.onCommittedAppend(append));
      restarted.start();
      return orchestration;
    };
    const admit = (requestId: (typeof requestIds)[number], dependsOn?: ReadonlyArray<string>) => {
      const admitted = harness.orchestration.admit({
        command: {
          ...requestCommand(requestId),
          ...(dependsOn === undefined ? {} : { dependsOn: dependsOn as never }),
        },
        parentAuthority: authority,
        confirmed: true,
        liveAuthority: authority,
      });
      if (admitted.kind === "run-command-failed") throw new Error(admitted.message);
      return admitted.run;
    };
    const run = (requestId: (typeof requestIds)[number]) => {
      const admitted = admit(requestId);
      harness.orchestration.start(admitted.id, admitted.version, authority);
      return admitted.id;
    };
    return { ...harness, starts, scheduler, admit, run, restart, sessions };
  }

  it("parks a run that waits on siblings without starting it, and starts it once all completed", async () => {
    const { persistence, orchestration, starts, admit, run } = graphHarness();
    const first = run(requestIds[0]);
    const second = run(requestIds[1]);
    const joined = admit(requestIds[2], [String(first), String(second)]);
    expect(joined).toMatchObject({
      lifecycleStatus: "waiting",
      recoveryReason: AGENT_RUN_DEPENDENCY_WAITING_REASON,
    });

    orchestration.onSessionSettled({
      runId: first,
      outcome: { kind: "completed", responseText: "first finding" },
    });
    await settle();
    expect(persistence.getById(joined.id)?.lifecycleStatus).toBe("waiting");
    expect(starts).not.toContain(String(joined.id));

    orchestration.onSessionSettled({
      runId: second,
      outcome: { kind: "completed", responseText: "second finding" },
    });
    await settle();
    expect(persistence.getById(joined.id)?.lifecycleStatus).toBe("starting");
    expect(starts).toContain(String(joined.id));
  });

  it("fails a waiting run without ever starting it when a dependency fails", async () => {
    const { persistence, orchestration, starts, admit, run } = graphHarness();
    const first = run(requestIds[0]);
    const dependent = admit(requestIds[1], [String(first)]);

    orchestration.onSessionSettled({
      runId: first,
      outcome: { kind: "failed", failure: { category: "provider-failed", message: "refused" } },
    });
    await settle();

    expect(persistence.getById(dependent.id)).toMatchObject({
      lifecycleStatus: "failed",
      recoveryReason: `dependency-failed: ${String(first)}`,
    });
    expect(starts).not.toContain(String(dependent.id));
  });

  it("refuses to admit a run that waits on a sibling that already failed", async () => {
    const { orchestration, admit, run } = graphHarness();
    const first = run(requestIds[0]);
    orchestration.onSessionSettled({
      runId: first,
      outcome: { kind: "failed", failure: { category: "provider-failed", message: "refused" } },
    });
    expect(() => admit(requestIds[1], [String(first)])).toThrow(/could never start/);
  });

  it("keeps a run parked on its dependencies across a restart", () => {
    const { persistence, admit, run } = graphHarness();
    const first = run(requestIds[0]);
    const dependent = admit(requestIds[1], [String(first)]);

    persistence.reconcileAfterRestart();

    // The running dependency is interrupted like any child a restart catches;
    // the parked run never held execution, so it keeps waiting for a retry.
    expect(persistence.getById(first)?.lifecycleStatus).toBe("interrupted");
    expect(persistence.getById(dependent.id)).toMatchObject({
      lifecycleStatus: "waiting",
      recoveryReason: AGENT_RUN_DEPENDENCY_WAITING_REASON,
    });
  });

  it("holds a run parked before a restart even once its dependencies complete, until a person resumes it", async () => {
    const { persistence, starts, admit, run, restart } = graphHarness();
    const first = run(requestIds[0]);
    const dependent = admit(requestIds[1], [String(first)]);
    // The old host finishes what it already noticed before it goes away.
    await settle();

    const orchestration = restart();
    const waiting = persistence.getById(dependent.id);
    if (waiting === undefined) throw new Error("The dependent is gone.");
    expect(orchestration.resume(dependent.id, waiting.version + 1, authority)).toMatchObject({
      kind: "run-command-failed",
      reason: "stale-version",
    });
    const interrupted = persistence.getById(first);
    if (interrupted === undefined) throw new Error("The dependency is gone.");
    orchestration.retry(first, interrupted.version, authority);
    orchestration.onSessionSettled({
      runId: first,
      outcome: { kind: "completed", responseText: "first finding" },
    });
    await settle();

    // The parent's session is idle, so only the restart holds the run back.
    expect(persistence.getById(first)?.lifecycleStatus).toBe("completed");
    expect(persistence.getById(dependent.id)?.lifecycleStatus).toBe("waiting");
    expect(starts).not.toContain(String(dependent.id));

    const parked = persistence.getById(dependent.id);
    if (parked === undefined) throw new Error("The dependent is gone.");
    orchestration.resume(dependent.id, parked.version, authority);
    expect(persistence.getById(dependent.id)?.lifecycleStatus).toBe("starting");
    expect(starts).toContain(String(dependent.id));
  });

  it("starts no child while its parent's session is paused, and starts it once the session resumes", async () => {
    const { persistence, orchestration, starts, admit, run, sessions } = graphHarness();
    const first = run(requestIds[0]);
    const dependent = admit(requestIds[1], [String(first)]);
    sessions.pause(String(ids.thread), "paused-by-user", "Checking the plan.");

    orchestration.onSessionSettled({
      runId: first,
      outcome: { kind: "completed", responseText: "first finding" },
    });
    await settle();
    expect(persistence.getById(dependent.id)?.lifecycleStatus).toBe("waiting");
    expect(starts).not.toContain(String(dependent.id));

    // Resuming the child alone does not get around its parent's pause.
    const parked = persistence.getById(dependent.id);
    if (parked === undefined) throw new Error("The dependent is gone.");
    expect(orchestration.resume(dependent.id, parked.version, authority)).toMatchObject({
      kind: "run-command-failed",
      reason: "unsupported-transition",
    });
    expect(starts).not.toContain(String(dependent.id));

    sessions.resume(String(ids.thread));
    await settle();
    expect(persistence.getById(dependent.id)?.lifecycleStatus).toBe("starting");
    expect(starts).toContain(String(dependent.id));
  });
});

describe("AgentRun run slots", () => {
  const thread = (n: number) =>
    decodeAgentRunParentThreadId(`35353535-3535-4353-8353-${String(n).padStart(12, "0")}`);
  const run = (n: number) =>
    decodeAgentRunId(`36363636-3636-4363-8363-${String(n).padStart(12, "0")}`);

  it("holds one thread to its own limit while another thread still gets a slot", () => {
    const capacity = createInMemoryCapacityPort(() => ({ perThread: 2, onHost: 3 }));
    const reserve = (runNumber: number, threadNumber: number) =>
      capacity.tryReserve({
        runId: run(runNumber),
        providerInstanceId: ids.provider,
        parentThreadId: thread(threadNumber),
      });
    expect(reserve(1, 1).status).toBe("reserved");
    expect(reserve(2, 1).status).toBe("reserved");
    expect(reserve(3, 1)).toMatchObject({ status: "queued", scope: "thread" });
    expect(reserve(4, 2).status).toBe("reserved");
    expect(reserve(5, 2)).toMatchObject({ status: "queued", scope: "host" });
  });

  it("applies a changed limit at the next reservation without touching held slots", () => {
    let limits = { perThread: 1, onHost: 1 };
    const capacity = createInMemoryCapacityPort(() => limits);
    const first = capacity.tryReserve({
      runId: run(1),
      providerInstanceId: ids.provider,
      parentThreadId: thread(1),
    });
    expect(first.status).toBe("reserved");
    const second = () =>
      capacity.tryReserve({
        runId: run(2),
        providerInstanceId: ids.provider,
        parentThreadId: thread(1),
      });
    expect(second().status).toBe("queued");
    limits = { perThread: 4, onHost: 8 };
    expect(second().status).toBe("reserved");
  });
});

describe("managed child continuation", () => {
  it.each(["dependency", "capacity"] as const)(
    "leaves a never-started %s wait unchanged after Resume and still releases it normally",
    async (kind) => {
      let slots = kind === "capacity" ? 1 : 4;
      const capacity = createInMemoryCapacityPort(() => ({ perThread: slots, onHost: slots }));
      const reserve = vi.spyOn(capacity, "tryReserve");
      const release = vi.spyOn(capacity, "release");
      const scratchRoot = vi.fn(() => "/scratch");
      const acquire = vi.fn(() => Effect.never);
      const runtime = createAgentRunSessionRuntime({
        capacityScheduler: makeProviderCapacityScheduler({
          now: () => 0,
          random: () => 0,
          maxRetryJitterMs: 0,
          ambiguousReservationTtlMs: 1000,
        }),
        resolveDriver: () => ({ kind: "codex", probe: () => Effect.never, acquire }),
        supportsResume: () => true,
        sessionStore: { read: () => undefined, write: () => true },
        context: { resolve: () => [] },
        scratchRoot,
        uuid: () => ids.run,
      });
      const start = vi.fn((run: Parameters<typeof runtime.start>[0]) => ({
        runId: run.id,
        onSettled: () => undefined,
      }));
      const supervisor = new AgentRunSessionSupervisor({ port: { ...runtime, start } });
      const harness = createHarness(capacity, true, supervisor);
      const scheduler = new AgentRunDependencyScheduler({
        agentRuns: harness.persistence,
        orchestration: harness.orchestration,
      });
      harness.journal.subscribeCommitted((append) => scheduler.onCommittedAppend(append));
      const first = harness.orchestration.admit({
        command: {
          ...requestCommand(),
          requestedAuthority: { ...authority, network: false, subagents: false },
        },
        parentAuthority: authority,
        liveAuthority: authority,
        confirmed: true,
      });
      if (first.kind !== "run-accepted") throw new Error("Expected admitted first child");
      harness.orchestration.start(first.run.id, first.run.version, authority);
      const waiting = harness.orchestration.admit({
        command: {
          ...requestCommand(ids.requestChild),
          requestedAuthority: { ...authority, network: false, subagents: false },
          ...(kind === "dependency" ? { dependsOn: [first.run.id] } : {}),
        },
        parentAuthority: authority,
        liveAuthority: authority,
        confirmed: true,
      });
      if (waiting.kind !== "run-updated") throw new Error("Expected waiting child");
      expect(waiting.run.recoveryReason).toBe(
        kind === "dependency" ? AGENT_RUN_DEPENDENCY_WAITING_REASON : "provider-capacity-saturated",
      );
      // A slot can open without either scheduler dispatching yet. Resume must still
      // leave this never-started child to its original scheduler.
      slots = 4;
      const events = () =>
        harness.connection.prepare("SELECT * FROM event_journal ORDER BY global_sequence").all();
      const beforeEvents = events();
      const beforeReserve = reserve.mock.calls.length;
      const beforeRelease = release.mock.calls.length;
      const result = await harness.orchestration.resume(
        waiting.run.id,
        waiting.run.version,
        authority,
      );
      expect(harness.persistence.getById(waiting.run.id)).toEqual(waiting.run);
      expect(events()).toEqual(beforeEvents);
      expect(reserve).toHaveBeenCalledTimes(beforeReserve);
      expect(release).toHaveBeenCalledTimes(beforeRelease);
      expect(scratchRoot).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(result).toEqual(
        kind === "dependency"
          ? { kind: "run-updated", run: waiting.run }
          : {
              kind: "run-command-failed",
              reason: "unsupported-transition",
              message:
                "This child has no saved session to resume; its existing wait remains unchanged.",
            },
      );
      harness.orchestration.onSessionSettled({
        runId: first.run.id,
        outcome: { kind: "completed", responseText: "Dependency finished" },
      });
      await vi.waitFor(() =>
        expect(harness.persistence.getById(waiting.run.id)?.lifecycleStatus).toBe("starting"),
      );
      expect(harness.persistence.getById(waiting.run.id)).not.toHaveProperty("recoveryReason");
      expect(start.mock.calls.map(([run]) => run.id)).toEqual([first.run.id, waiting.run.id]);
    },
  );

  it("resumes a waiting child through its saved session and reserves a new live slot", async () => {
    const start = vi.fn();
    const resume = vi.fn();
    const capacity = createInMemoryCapacityPort();
    const reserve = vi.spyOn(capacity, "tryReserve");
    const harness = createHarness(capacity, true, { start, resume, stop: async () => undefined });
    const admitted = harness.orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      liveAuthority: authority,
      confirmed: true,
    });
    if (admitted.kind !== "run-accepted") throw new Error("Fixture was not admitted");
    harness.orchestration.start(admitted.run.id, admitted.run.version, authority);
    const waited = harness.orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "waiting", reason: "Needs a follow-up" },
    });
    if (waited?.kind !== "run-updated") throw new Error("Fixture did not wait");
    const continued = await harness.orchestration.resume(
      waited.run.id,
      waited.run.version,
      authority,
    );
    expect(continued).toMatchObject({ kind: "run-updated", run: { lifecycleStatus: "starting" } });
    expect(start).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("preserves an honest resume refusal and never retries the original task automatically", async () => {
    const start = vi.fn();
    const resume = vi.fn(() => {
      throw new AgentRunSessionError(
        "resume-unavailable",
        "The saved session is unavailable. Use Retry.",
      );
    });
    const capacity = createInMemoryCapacityPort();
    const release = vi.spyOn(capacity, "release");
    const harness = createHarness(capacity, true, { start, resume, stop: async () => undefined });
    const admitted = harness.orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      liveAuthority: authority,
      confirmed: true,
    });
    if (admitted.kind !== "run-accepted") throw new Error("Fixture was not admitted");
    harness.orchestration.start(admitted.run.id, admitted.run.version, authority);
    const waited = harness.orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "waiting", reason: "Provider wait" },
    });
    if (waited?.kind !== "run-updated") throw new Error("Fixture did not wait");
    const continued = await harness.orchestration.resume(
      waited.run.id,
      waited.run.version,
      authority,
    );
    expect(continued).toMatchObject({
      kind: "run-updated",
      run: { lifecycleStatus: "waiting", recoveryReason: expect.stringContaining("Retry") },
    });
    expect(start).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it.each(["waiting", "completed"] as const)(
    "leaves a %s child unchanged when its execution backend cannot resume",
    async (status) => {
      const start = vi.fn();
      const harness = createHarness(createInMemoryCapacityPort(), true, {
        start,
        stop: async () => undefined,
      });
      const admitted = harness.orchestration.admit({
        command: requestCommand(),
        parentAuthority: authority,
        liveAuthority: authority,
        confirmed: true,
      });
      if (admitted.kind !== "run-accepted") throw new Error("Fixture was not admitted");
      harness.orchestration.start(admitted.run.id, admitted.run.version, authority);
      const waited = harness.orchestration.onSessionSettled({
        runId: admitted.run.id,
        outcome:
          status === "waiting"
            ? { kind: "waiting", reason: "Provider wait" }
            : { kind: "completed", responseText: "Retained reply" },
      });
      if (waited?.kind !== "run-updated") throw new Error("Fixture did not wait");
      expect(
        await harness.orchestration.resume(waited.run.id, waited.run.version, authority, {
          message: "Continue",
        }),
      ).toMatchObject({
        kind: "run-command-failed",
        message: expect.stringContaining(
          status === "completed" ? "Start a new delegation from the parent." : "Retry",
        ),
      });
      expect(harness.persistence.getById(waited.run.id)).toEqual(waited.run);
      expect(start).toHaveBeenCalledOnce();
    },
  );
});

it("starts another capacity waiter without restarting a continuation whose resume cannot be persisted", async () => {
  const start = vi.fn();
  const resume = vi.fn();
  const capacity = createInMemoryCapacityPort(() => ({ perThread: 1, onHost: 1 }));
  const release = vi.spyOn(capacity, "release");
  const harness = createHarness(capacity, true, { start, resume, stop: async () => undefined });
  const admitted = harness.orchestration.admit({
    command: requestCommand(),
    parentAuthority: authority,
    liveAuthority: authority,
    confirmed: true,
  });
  if (admitted.kind !== "run-accepted") throw new Error("Fixture was not admitted");
  harness.orchestration.start(admitted.run.id, admitted.run.version, authority);
  const waited = harness.orchestration.onSessionSettled({
    runId: admitted.run.id,
    outcome: { kind: "waiting", reason: "Provider wait" },
  });
  if (waited?.kind !== "run-updated") throw new Error("Fixture did not wait");
  // A saved continuation can itself be capacity-eligible. It must not be
  // mistaken for a fresh start when its resume transaction fails.
  const resuming = harness.persistence.applyCommand({
    kind: "resume-agent-run",
    runId: waited.run.id,
    expectedVersion: waited.run.version,
  });
  if (resuming.kind !== "run-updated") throw new Error("Fixture did not resume");
  const continuation = harness.persistence.applyCommand({
    kind: "wait-agent-run",
    runId: resuming.run.id,
    expectedVersion: resuming.run.version,
    recoveryReason: "provider-capacity-saturated",
  });
  if (continuation.kind !== "run-updated") throw new Error("Fixture did not park");
  const blocker = capacity.tryReserve({
    runId: decodeAgentRunId(randomUUID()),
    parentThreadId: otherThread,
    providerInstanceId: ids.provider,
  });
  if (blocker.status !== "reserved") throw new Error("Fixture did not reserve the slot");
  const next = harness.orchestration.admit({
    command: requestCommand(ids.requestChild),
    parentAuthority: authority,
    liveAuthority: authority,
    confirmed: true,
  });
  if (next.kind !== "run-updated") throw new Error("Fixture did not queue the next child");
  expect(next.run).toMatchObject({
    lifecycleStatus: "waiting",
    recoveryReason: "provider-capacity-saturated",
  });
  capacity.release(blocker.reservationId);
  // The journal fails once after Resume reserved the freed slot; subsequent
  // writes can admit the independent waiter normally.
  vi.spyOn(harness.journal, "append").mockImplementationOnce(() => {
    throw new Error("Journal unavailable");
  });
  await expect(
    harness.orchestration.resume(continuation.run.id, continuation.run.version, authority),
  ).rejects.toThrow("Journal unavailable");
  expect(resume).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(3);
  expect(harness.persistence.getById(continuation.run.id)).toEqual(continuation.run);
  expect(harness.persistence.getById(next.run.id)?.lifecycleStatus).toBe("starting");
  expect(start.mock.calls.map(([run]) => run.id)).toEqual([admitted.run.id, next.run.id]);
});

it("resumes a completed child's next generation while preserving journaled prior replies", async () => {
  const resume = vi.fn();
  const harness = createHarness(undefined, true, {
    start: vi.fn(),
    resume,
    checkResume: () => ({ status: "ready" }),
    stop: async () => undefined,
  });
  const { orchestration, persistence } = harness;
  const admitted = orchestration.admit({
    command: requestCommand(),
    parentAuthority: authority,
    confirmed: true,
    liveAuthority: authority,
  });
  if (admitted.kind !== "run-accepted") throw new Error("admission failed");
  orchestration.start(admitted.run.id, admitted.run.version, authority);
  orchestration.onSessionSettled({
    runId: admitted.run.id,
    outcome: { kind: "completed", responseText: "First reply" },
  });
  const completed = persistence.getById(admitted.run.id);
  if (completed?.result === undefined) throw new Error("completion failed");
  expect(
    await orchestration.resume(completed.id, completed.version, authority, {
      message: "Too early",
    }),
  ).toMatchObject({
    kind: "run-command-failed",
    message: "Collect the current result or wait for delivery to the parent before following up.",
  });
  expect(persistence.getById(completed.id)).toEqual(completed);
  expect(persistence.resultText(completed.id)).toBe("First reply");
  expect(resume).not.toHaveBeenCalled();
  const delivered = persistence.applyCommand({
    kind: "settle-agent-run-result-delivery",
    runId: completed.id,
    expectedVersion: completed.version,
    outcome: "delivered",
  });
  if (delivered.kind !== "run-updated") throw new Error("delivery failed");
  const acknowledged = persistence.applyCommand({
    kind: "acknowledge-agent-run-result",
    runId: completed.id,
    expectedVersion: delivered.run.version,
  });
  if (acknowledged.kind !== "run-updated") throw new Error("acknowledgement failed");
  const next = await orchestration.resume(completed.id, acknowledged.run.version, authority, {
    message: "Explain the evidence",
  });
  expect(next).toMatchObject({
    kind: "run-updated",
    run: { generation: 2, lifecycleStatus: "starting" },
  });
  expect(resume).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }), {
    message: "Explain the evidence",
  });
  expect(persistence.getById(completed.id)?.result).toBeUndefined();
  expect(persistence.getById(completed.id)?.resultDelivery).toBeUndefined();
  persistence.rebuildFromJournal();
  expect(persistence.getById(completed.id)).toMatchObject({
    generation: 2,
    resultAcknowledgement: { required: false, acknowledged: false },
  });
  expect(persistence.getById(completed.id)?.result).toBeUndefined();
  expect(persistence.getById(completed.id)?.resultDelivery).toBeUndefined();
  orchestration.onSessionSettled({
    runId: completed.id,
    outcome: { kind: "completed", responseText: "Second reply" },
  });
  persistence.rebuildFromJournal();
  const followup = persistence.getById(completed.id);
  expect(followup).toMatchObject({
    lifecycleStatus: "completed",
    generation: 2,
    result: { reference: `octant://agent-run/${completed.id}/result/2` },
    resultAcknowledgement: { required: true, acknowledged: false },
  });
  expect(persistence.resultText(completed.id)).toBe("Second reply");
  expect(
    readAgentRunResultText(harness.connection, {
      runId: completed.id,
      reference: completed.result.reference,
    }),
  ).toBe("First reply");
  const rebuilt = new AgentRunProjection();
  const replay = harness.store.replayAll(100);
  if (replay.status !== "ok") throw new Error("replay failed");
  for (const event of replay.events) rebuilt.apply(harness.connection, event);
  expect(rebuilt.getById(completed.id)).toEqual(followup);
  if (followup === undefined) throw new Error("missing follow-up");
  expect(
    persistence.applyCommand({
      kind: "settle-agent-run-result-delivery",
      runId: completed.id,
      expectedVersion: followup.version,
      generation: 1,
      outcome: "delivered",
    }),
  ).toMatchObject({ kind: "run-command-failed" });
  expect(
    persistence.applyCommand({
      kind: "settle-agent-run-result-delivery",
      runId: completed.id,
      expectedVersion: followup.version,
      generation: 2,
      outcome: "delivered",
    }),
  ).toMatchObject({ kind: "run-updated" });
});

it("keeps completion unchanged when follow-up resume evidence, authority or capacity is unavailable", async () => {
  const resume = vi.fn();
  const checkResume = vi.fn((): { status: "ready" } | { status: "refused"; message: string } => ({
    status: "refused",
    message: "No compatible cursor",
  }));
  const capacity = createInMemoryCapacityPort();
  const reserve = vi.spyOn(capacity, "tryReserve");
  const { orchestration, persistence, approvals } = createHarness(capacity, true, {
    start: vi.fn(),
    resume,
    checkResume,
    stop: async () => undefined,
  });
  const admitted = orchestration.admit({
    command: requestCommand(),
    parentAuthority: authority,
    confirmed: true,
    liveAuthority: authority,
  });
  if (admitted.kind !== "run-accepted") throw new Error("admission failed");
  orchestration.start(admitted.run.id, admitted.run.version, authority);
  orchestration.onSessionSettled({
    runId: admitted.run.id,
    outcome: { kind: "completed", responseText: "Keep this reply" },
  });
  const finished = persistence.getById(admitted.run.id);
  if (finished === undefined) throw new Error("completion failed");
  const delivered = persistence.applyCommand({
    kind: "settle-agent-run-result-delivery",
    runId: finished.id,
    expectedVersion: finished.version,
    generation: finished.generation ?? 1,
    outcome: "delivered",
  });
  if (delivered.kind !== "run-updated") throw new Error("delivery failed");
  const completed = delivered.run;
  reserve.mockClear();
  expect(
    await orchestration.resume(completed.id, completed.version, authority, { message: "Continue" }),
  ).toMatchObject({ kind: "run-command-failed" });
  expect(reserve).not.toHaveBeenCalled();
  checkResume.mockReturnValue({ status: "ready" });
  expect(await orchestration.resume(completed.id, completed.version, authority)).toMatchObject({
    kind: "run-command-failed",
  });
  approvals.isCurrent = () => false;
  expect(
    await orchestration.resume(completed.id, completed.version, authority, { message: "Continue" }),
  ).toMatchObject({ kind: "run-command-failed" });
  approvals.isCurrent = () => true;
  reserve.mockReturnValue({ status: "queued", scope: "host", reason: "full" });
  expect(
    await orchestration.resume(completed.id, completed.version, authority, { message: "Continue" }),
  ).toMatchObject({ kind: "run-command-failed", reason: "limit-reached" });
  expect(persistence.getById(completed.id)).toEqual(completed);
  expect(resume).not.toHaveBeenCalled();
});

it("refuses completed-child follow-ups at the existing unfinished-child admission limit", async () => {
  const resume = vi.fn();
  const { orchestration, persistence } = createHarness(undefined, true, {
    start: vi.fn(),
    resume,
    checkResume: () => ({ status: "ready" }),
    stop: async () => undefined,
  });
  const admitted = orchestration.admit({
    command: requestCommand(),
    parentAuthority: authority,
    confirmed: true,
    liveAuthority: authority,
  });
  if (admitted.kind !== "run-accepted") throw new Error("admission failed");
  orchestration.start(admitted.run.id, admitted.run.version, authority);
  orchestration.onSessionSettled({
    runId: admitted.run.id,
    outcome: { kind: "completed", responseText: "Completed" },
  });
  const finished = persistence.getById(admitted.run.id);
  if (finished === undefined) throw new Error("completion failed");
  const delivered = persistence.applyCommand({
    kind: "settle-agent-run-result-delivery",
    runId: finished.id,
    expectedVersion: finished.version,
    generation: finished.generation ?? 1,
    outcome: "delivered",
  });
  if (delivered.kind !== "run-updated") throw new Error("delivery failed");
  const completed = delivered.run;
  for (let i = 0; i < 16; i++) {
    const requested = persistence.requestRun({
      command: requestCommand(
        decodeAgentRunRequestId(`bbbbbbbb-bbbb-4bbb-8bbb-${i.toString(16).padStart(12, "0")}`),
      ),
      parentAuthority: authority,
      confirmed: true,
    });
    expect(requested.kind).toBe("run-accepted");
  }
  expect(
    await orchestration.resume(completed.id, completed.version, authority, { message: "Continue" }),
  ).toMatchObject({ kind: "run-command-failed", reason: "limit-reached" });
  expect(persistence.getById(completed.id)).toEqual(completed);
  expect(resume).not.toHaveBeenCalled();
});

it.each(["workspace-refused", "stale-version", "authority-revoked", "accepted"] as const)(
  "rechecks a completed child's async preflight before mutation: %s",
  async (scenario) => {
    let finish:
      | ((value: { status: "ready" } | { status: "refused"; message: string }) => void)
      | undefined;
    const readiness = new Promise<{ status: "ready" } | { status: "refused"; message: string }>(
      (resolve) => {
        finish = resolve;
      },
    );
    let bound = false;
    const acquired = vi.fn();
    const resume = vi.fn(() => {
      void Promise.resolve().then(() => acquired(bound));
    });
    const capacity = createInMemoryCapacityPort();
    const reserve = vi.spyOn(capacity, "tryReserve");
    const harness = createHarness(capacity, true, {
      start: vi.fn(),
      resume,
      checkResume: () => readiness,
      stop: async () => undefined,
    });
    const admitted = harness.orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      liveAuthority: authority,
      confirmed: true,
    });
    if (admitted.kind !== "run-accepted") throw new Error("Expected admitted child");
    harness.orchestration.start(admitted.run.id, admitted.run.version, authority);
    harness.orchestration.onSessionSettled({
      runId: admitted.run.id,
      outcome: { kind: "completed", responseText: "Retained original reply" },
    });
    const completed = harness.persistence.getById(admitted.run.id);
    if (completed === undefined) throw new Error("Expected completed child");
    const delivered = harness.persistence.applyCommand({
      kind: "settle-agent-run-result-delivery",
      runId: completed.id,
      expectedVersion: completed.version,
      generation: completed.generation ?? 1,
      outcome: "delivered",
    });
    if (delivered.kind !== "run-updated") throw new Error("Expected delivered result");
    reserve.mockClear();
    const accepted = vi.fn(() => {
      bound = true;
    });
    let live: AgentRunAuthority | undefined = authority;
    const pending = harness.orchestration.resume(completed.id, delivered.run.version, authority, {
      message: "Continue with the evidence",
      resolveLiveAuthority: () => live,
      onExecutionAccepted: accepted,
    });
    expect(harness.persistence.getById(completed.id)).toEqual(delivered.run);
    expect(reserve).not.toHaveBeenCalled();
    if (scenario === "stale-version")
      harness.persistence.applyCommand({
        kind: "acknowledge-agent-run-result",
        runId: completed.id,
        expectedVersion: delivered.run.version,
      });
    if (scenario === "authority-revoked") live = undefined;
    const before = harness.persistence.getById(completed.id);
    const events = () =>
      harness.connection.prepare("SELECT * FROM event_journal ORDER BY global_sequence").all();
    const beforeEvents = events();
    finish?.(
      scenario === "workspace-refused"
        ? { status: "refused", message: "Original workspace is gone" }
        : { status: "ready" },
    );
    const result = await pending;
    if (scenario === "accepted") {
      expect(result).toMatchObject({
        kind: "run-updated",
        run: { generation: 2, lifecycleStatus: "starting" },
      });
      expect(accepted).toHaveBeenCalledOnce();
      expect(acquired).toHaveBeenCalledExactlyOnceWith(true);
    } else {
      expect(result).toMatchObject({
        kind: "run-command-failed",
        reason: scenario === "stale-version" ? "stale-version" : "unsupported-transition",
      });
      expect(harness.persistence.getById(completed.id)).toEqual(before);
      expect(events()).toEqual(beforeEvents);
      expect(reserve).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
    }
  },
);
