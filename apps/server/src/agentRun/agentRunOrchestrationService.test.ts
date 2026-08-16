import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AgentRunRequested,
  AgentRunResultAcknowledged,
  AgentRunStatusChanged,
  MAX_AGENT_RUN_RESULT_CHARACTERS,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  type AgentRunAuthority,
  type AgentRunCommand,
  type AgentRunRoutingReceipt,
  type AgentRunWorkspaceReceipt,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
} from "./agentRunEventStore";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProjection } from "./agentRunProjection";
import {
  AgentRunOrchestrationError,
  AgentRunOrchestrationService,
  type AgentRunProcessSupervisorPort,
  createInMemoryCapacityPort,
} from "./agentRunOrchestrationService";
import { AgentRunProcessSupervisor } from "./agentRunProcessSupervisor";
import type { AgentRunSessionOutcome } from "./agentRunSessionPort";

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
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-orch-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3")) as SqliteConnection;
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = new EventRegistry()
    .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
    .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
    .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged);
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
  });
  return { orchestration, persistence, capacity, approvals, store, connection };
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
    const capacity = createInMemoryCapacityPort();
    // saturate default capacity (4)
    for (let i = 0; i < 4; i += 1) {
      capacity.tryReserve({ runId: ids.run, providerInstanceId: ids.provider });
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
    const capacity = createInMemoryCapacityPort();
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
