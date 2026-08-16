import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AgentRunRequested,
  AgentRunResultAcknowledged,
  AgentRunStatusChanged,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCommand,
  type AgentRunId,
  type AgentRunRoutingReceipt,
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
import {
  AgentRunOrchestrationService,
  createInMemoryCapacityPort,
} from "./agentRunOrchestrationService";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProcessSupervisorError } from "./agentRunProcessSupervisor";
import { AgentRunProjection } from "./agentRunProjection";
import type {
  AgentRunSessionHandle,
  AgentRunSessionOutcome,
  AgentRunSessionPort,
} from "./agentRunSessionPort";
import { AgentRunSessionSupervisor } from "./agentRunSessionSupervisor";

const now = "2026-08-01T14:00:00.000Z";
const directories: string[] = [];
afterEach(() => {
  while (directories.length) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  run: decodeAgentRunId("11111111-1111-4111-8111-111111111111"),
  child: decodeAgentRunId("12121212-1212-4121-8121-121212121212"),
  request: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222222"),
  requestChild: decodeAgentRunRequestId("23232323-2323-4232-8232-232323232323"),
  thread: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333333"),
  provider: "55555555-5555-4555-8555-555555555555",
  snapshot: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
};

const run = { id: ids.run } as unknown as AgentRun;

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
  attemptedExecutionKind: "octant-managed",
  selectedProviderInstanceId: ids.provider as never,
  selectedModelId: "gpt-4o" as never,
  fallbackCandidates: [],
  capabilityDegradations: [],
  contextSnapshotId: ids.snapshot as never,
  effectiveAuthorityDigest: "digest",
  usageQuality: "unavailable",
  hostId: "local" as never,
  mode: "chat",
};

function requestCommand(
  requestId = ids.request,
  parentRunId?: AgentRunId,
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
    routingReceipt: routing,
    workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
  };
}

interface FakePort {
  readonly port: AgentRunSessionPort;
  readonly started: AgentRunId[];
  readonly stopped: AgentRunId[];
  readonly settle: (runId: AgentRunId, outcome: AgentRunSessionOutcome) => void;
}

function createFakeSessionPort(options?: {
  readonly onStop?: (runId: AgentRunId) => Promise<void>;
  readonly startupReady?: () => Promise<void>;
  readonly reconcile?: () => Promise<void>;
}): FakePort {
  const listeners = new Map<AgentRunId, Set<(outcome: AgentRunSessionOutcome) => void>>();
  const started: AgentRunId[] = [];
  const stopped: AgentRunId[] = [];
  const settle = (runId: AgentRunId, outcome: AgentRunSessionOutcome) => {
    for (const listener of listeners.get(runId) ?? []) listener(outcome);
  };
  const port: AgentRunSessionPort = {
    start: (started_run): AgentRunSessionHandle => {
      started.push(started_run.id);
      const set = new Set<(outcome: AgentRunSessionOutcome) => void>();
      listeners.set(started_run.id, set);
      return {
        runId: started_run.id,
        onSettled: (listener) => {
          set.add(listener);
        },
        ...(options?.startupReady === undefined ? {} : { startupReady: options.startupReady() }),
      };
    },
    stop: async (runId) => {
      stopped.push(runId);
      await options?.onStop?.(runId);
    },
    ...(options?.reconcile === undefined ? {} : { reconcile: options.reconcile }),
  };
  return { port, started, stopped, settle };
}

function createOrchestrationHarness(supervisorPort: AgentRunSessionPort) {
  const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-session-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3")) as SqliteConnection;
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = new EventRegistry()
    .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
    .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
    .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  });
  let sequence = 0;
  const uuid = () => {
    sequence += 1;
    return sequence === 1
      ? String(ids.run)
      : sequence === 2
        ? String(ids.child)
        : `aaaaaaaa-aaaa-4aaa-8aaa-${sequence.toString(16).padStart(12, "0")}`;
  };
  const actor = Schema.decodeUnknownSync(EventActor)({
    kind: "local-user",
    actorId: ids.actor,
  });
  const persistence = new AgentRunPersistenceService({
    store: new AgentRunEventStore({ journal, uuid, actor }),
    projection: new AgentRunProjection(),
    uuid,
    clock: () => now,
    connection,
  });
  const activeRunIds: AgentRunId[] = [];
  const supervisor = new AgentRunSessionSupervisor({
    port: supervisorPort,
    // Wired exactly as the host wires it: the supervisor observes the outcome
    // and orchestration owns the durable transition. `orchestration` is
    // declared below and referenced only when a session settles.
    onSessionSettled: (settled) => orchestration.onSessionSettled(settled),
    persistedActiveRunIds: () => activeRunIds,
  });
  const orchestration = new AgentRunOrchestrationService({
    persistence,
    capacity: createInMemoryCapacityPort(),
    worktree: {
      isVerifiedIsolation: (workspace) => workspace.verified,
      isParentCheckout: (workspace) => workspace.worktreeRoot === workspace.checkoutRoot,
    },
    approvals: { isCurrent: () => true },
    processes: supervisor,
  });
  return { orchestration, persistence, supervisor, activeRunIds };
}

describe("AgentRunSessionSupervisor", () => {
  it("owns one managed session per run and refuses a duplicate start", () => {
    const fake = createFakeSessionPort();
    const supervisor = new AgentRunSessionSupervisor({ port: fake.port });

    supervisor.start(run);

    expect(supervisor.activeRunIds()).toEqual([ids.run]);
    expect(() => supervisor.start(run)).toThrowError(AgentRunProcessSupervisorError);
    try {
      supervisor.start(run);
    } catch (error) {
      expect((error as AgentRunProcessSupervisorError).reason).toBe("duplicate");
    }
    expect(fake.started).toEqual([ids.run]);
  });

  it("reports a non-completed outcome as process death exactly once", () => {
    const onProcessDeath = vi.fn();
    const subscriber = vi.fn();
    const fake = createFakeSessionPort();
    const supervisor = new AgentRunSessionSupervisor({
      port: fake.port,
      onProcessDeath,
    });
    supervisor.subscribeToProcessDeath(subscriber);

    supervisor.start(run);
    fake.settle(ids.run, {
      kind: "interrupted",
      reason: "provider disconnected",
    });
    fake.settle(ids.run, {
      kind: "interrupted",
      reason: "provider disconnected",
    });

    expect(onProcessDeath).toHaveBeenCalledOnce();
    expect(onProcessDeath).toHaveBeenCalledWith(ids.run);
    expect(subscriber).toHaveBeenCalledOnce();
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("never reports a clean completion as death but still surfaces the outcome", () => {
    const onProcessDeath = vi.fn();
    const onSessionSettled = vi.fn();
    const fake = createFakeSessionPort();
    const supervisor = new AgentRunSessionSupervisor({
      port: fake.port,
      onProcessDeath,
      onSessionSettled,
    });

    supervisor.start(run);
    fake.settle(ids.run, { kind: "completed", responseText: "result" });

    expect(onProcessDeath).not.toHaveBeenCalled();
    expect(onSessionSettled).toHaveBeenCalledWith({
      runId: ids.run,
      outcome: { kind: "completed", responseText: "result" },
    });
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("resolves stop only after the port confirms termination and reports no death", async () => {
    const onProcessDeath = vi.fn();
    let confirmTermination: (() => void) | undefined;
    const fake = createFakeSessionPort({
      onStop: (runId) =>
        new Promise<void>((resolve) => {
          confirmTermination = () => {
            fake.settle(runId, { kind: "cancelled" });
            resolve();
          };
        }),
    });
    const supervisor = new AgentRunSessionSupervisor({
      port: fake.port,
      onProcessDeath,
    });

    supervisor.start(run);
    let stopped = false;
    const stopping = supervisor.stop(ids.run).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    confirmTermination?.();
    await stopping;

    expect(stopped).toBe(true);
    expect(onProcessDeath).not.toHaveBeenCalled();
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("treats a failed session startup as a controlled death and stops the owned session", async () => {
    const onProcessDeath = vi.fn();
    const fake = createFakeSessionPort({
      startupReady: () => Promise.reject(new Error("provider session never became ready")),
    });
    const supervisor = new AgentRunSessionSupervisor({
      port: fake.port,
      onProcessDeath,
    });

    supervisor.start(run);
    await vi.waitFor(() => expect(fake.stopped).toEqual([ids.run]));

    expect(onProcessDeath).toHaveBeenCalledOnce();
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("always finishes settling when the settlement observer throws", async () => {
    const onProcessDeath = vi.fn();
    const fake = createFakeSessionPort({
      onStop: async (runId) => {
        fake.settle(runId, { kind: "cancelled" });
      },
    });
    const supervisor = new AgentRunSessionSupervisor({
      port: fake.port,
      onProcessDeath,
      onSessionSettled: () => {
        throw new Error("completion journal append failed");
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // A death outcome still reaches the death path even though persisting
      // the settlement threw, and the throw never propagates back into the
      // runtime's settle listener.
      supervisor.start(run);
      expect(() =>
        fake.settle(ids.run, { kind: "interrupted", reason: "provider disconnected" }),
      ).not.toThrow();
      expect(onProcessDeath).toHaveBeenCalledOnce();
      expect(supervisor.activeRunIds()).toEqual([]);

      // A supervisor-initiated stop settles through the same observer; the
      // stop promise must still resolve so a cancellation never waits forever.
      supervisor.start(run);
      await expect(supervisor.stop(ids.run)).resolves.toBeUndefined();
      expect(supervisor.activeRunIds()).toEqual([]);
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps a session supervised when the port cannot confirm termination", async () => {
    let attempts = 0;
    const fake = createFakeSessionPort({
      onStop: async (runId) => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider did not confirm termination");
        fake.settle(runId, { kind: "cancelled" });
      },
    });
    const { orchestration, persistence, supervisor } = createOrchestrationHarness(fake.port);
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    const first = await orchestration.cancelLeafFirst({ runId: admitted.run.id, scope: "self" });

    // The stop was never confirmed, so nothing terminal may be journaled and
    // the session must stay owned so the cancellation can be retried.
    expect(first.map((result) => result.kind)).toEqual(["run-command-failed"]);
    expect(persistence.getById(admitted.run.id)?.lifecycleStatus).toBe("starting");
    expect(supervisor.activeRunIds()).toEqual([admitted.run.id]);

    const second = await orchestration.cancelLeafFirst({ runId: admitted.run.id, scope: "self" });

    expect(second.map((result) => result.kind)).toEqual(["run-updated"]);
    expect(fake.stopped).toEqual([admitted.run.id, admitted.run.id]);
    expect(persistence.getById(admitted.run.id)?.lifecycleStatus).toBe("cancelled");
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("records the outcome a retained session reaches after a failed stop", async () => {
    const fake = createFakeSessionPort({
      onStop: async () => {
        throw new Error("provider did not confirm termination");
      },
    });
    const { orchestration, persistence, supervisor } = createOrchestrationHarness(fake.port);
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    const results = await orchestration.cancelLeafFirst({ runId: admitted.run.id, scope: "self" });
    expect(results.map((result) => result.kind)).toEqual(["run-command-failed"]);

    // The execution the failed stop could not reach finishes on its own. The
    // retained session still observes it, so the run reaches the state the
    // provider actually reported instead of staying Running forever.
    fake.settle(admitted.run.id, { kind: "completed", responseText: "child answer" });

    const settled = persistence.getById(admitted.run.id);
    expect(settled?.lifecycleStatus).toBe("completed");
    expect(persistence.resultText(admitted.run.id)).toBe("child answer");
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("stops descendants before their parent during leaf-first cancellation", async () => {
    const fake = createFakeSessionPort({
      onStop: async (runId) => {
        fake.settle(runId, { kind: "cancelled" });
      },
    });
    const { orchestration, persistence } = createOrchestrationHarness(fake.port);
    const parent = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(parent.kind).toBe("run-accepted");
    if (parent.kind !== "run-accepted") return;
    orchestration.start(parent.run.id, parent.run.version, authority);
    const child = orchestration.admit({
      command: requestCommand(ids.requestChild, parent.run.id),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(child.kind).toBe("run-accepted");
    if (child.kind !== "run-accepted") return;
    orchestration.start(child.run.id, child.run.version, authority);
    expect(fake.started).toEqual([parent.run.id, child.run.id]);

    const results = await orchestration.cancelLeafFirst({
      runId: parent.run.id,
      scope: "subtree",
    });

    // A supervisor-initiated stop settles `cancelled` while the stop is still
    // awaited. Cancellation must still be reported exactly once, so every
    // target reports an update rather than a stale-version double-report.
    expect(results.map((result) => result.kind)).toEqual(["run-updated", "run-updated"]);
    expect(fake.stopped).toEqual([child.run.id, parent.run.id]);
    expect(persistence.getById(child.run.id)?.lifecycleStatus).toBe("cancelled");
    expect(persistence.getById(parent.run.id)?.lifecycleStatus).toBe("cancelled");
  });

  it("persists a settled outcome and keeps the death report it races from overwriting it", () => {
    const fake = createFakeSessionPort();
    const { orchestration, persistence } = createOrchestrationHarness(fake.port);
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    // Every non-completed outcome is also reported as death, immediately after
    // the settlement the supervisor delivers first.
    fake.settle(admitted.run.id, {
      kind: "failed",
      failure: { category: "provider-failed", message: "model refused" },
    });

    const settled = persistence.getById(admitted.run.id);
    expect(settled?.lifecycleStatus).toBe("failed");
    expect(settled?.recoveryReason).toMatch(/model refused/);
    expect(settled?.recoveryReason).not.toMatch(/process-death/);
  });

  it("keeps a session that settled waiting out of the generic process-death path", () => {
    const fake = createFakeSessionPort();
    const { orchestration, persistence } = createOrchestrationHarness(fake.port);
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    fake.settle(admitted.run.id, {
      kind: "waiting",
      reason: "provider expects input",
    });

    // Waiting is not terminal, so only the recorded settlement keeps the death
    // that follows it from re-recording this run a second time.
    const settled = persistence.getById(admitted.run.id);
    expect(settled?.lifecycleStatus).toBe("waiting");
    expect(settled?.recoveryReason).toMatch(/expects input/);
    expect(settled?.recoveryReason).not.toMatch(/process-death/);
  });

  it("records the published death when a settlement could not be journaled at all", () => {
    const fake = createFakeSessionPort();
    const { orchestration, persistence } = createOrchestrationHarness(fake.port);
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    // A transient journal outage rejects the settlement append and the
    // contained fail append that follows it. Nothing durable was recorded, so
    // the death the supervisor publishes next is the only remaining chance to
    // stop this now sessionless run from claiming it is still active.
    const applyCommand = vi.spyOn(persistence, "applyCommand");
    applyCommand.mockImplementationOnce(() => {
      throw new Error("journal is gone");
    });
    applyCommand.mockImplementationOnce(() => {
      throw new Error("journal is gone");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        fake.settle(admitted.run.id, {
          kind: "failed",
          failure: { category: "provider-failed", message: "model refused" },
        }),
      ).not.toThrow();
    } finally {
      applyCommand.mockRestore();
      errorLog.mockRestore();
    }

    const recorded = persistence.getById(admitted.run.id);
    expect(recorded?.lifecycleStatus).toBe("interrupted");
    expect(recorded?.recoveryReason).toBe("provider-process-death");
  });

  it("finishes settling when neither the settlement nor its published death can be journaled", async () => {
    const fake = createFakeSessionPort({
      onStop: async (runId) => {
        fake.settle(runId, { kind: "cancelled" });
      },
    });
    const { orchestration, persistence, supervisor } = createOrchestrationHarness(fake.port);
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    orchestration.start(admitted.run.id, admitted.run.version, authority);

    const applyCommand = vi.spyOn(persistence, "applyCommand").mockImplementation(() => {
      throw new Error("journal is gone");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Persistence stays broken through the settlement, the contained fail
      // path, and the death published right after. None of that may escape
      // into the runtime's settle listener, or a pending stop would await a
      // settlement promise that never resolves.
      expect(() =>
        fake.settle(admitted.run.id, { kind: "interrupted", reason: "provider disconnected" }),
      ).not.toThrow();
      expect(supervisor.activeRunIds()).toEqual([]);

      supervisor.start(run);
      await expect(supervisor.stop(admitted.run.id)).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalled();
    } finally {
      applyCommand.mockRestore();
      errorLog.mockRestore();
    }
  });

  it("reconciles a run the journal still calls active into an honest interrupted state", async () => {
    const reconcile = vi.fn(async () => undefined);
    const fake = createFakeSessionPort({ reconcile });
    const { orchestration, persistence, supervisor, activeRunIds } = createOrchestrationHarness(
      fake.port,
    );
    const admitted = orchestration.admit({
      command: requestCommand(),
      parentAuthority: authority,
      confirmed: true,
      liveAuthority: authority,
    });
    expect(admitted.kind).toBe("run-accepted");
    if (admitted.kind !== "run-accepted") return;
    // Durable state left behind by a previous host: started and running, with
    // no in-process session on this one.
    const started = persistence.applyCommand({
      kind: "start-agent-run",
      runId: admitted.run.id,
      expectedVersion: admitted.run.version as never,
    });
    expect(started.kind).toBe("run-updated");
    if (started.kind !== "run-updated") return;
    persistence.applyCommand({
      kind: "mark-agent-run-running",
      runId: admitted.run.id,
      expectedVersion: started.run.version as never,
    });
    activeRunIds.push(admitted.run.id);

    await supervisor.reconcile();

    expect(reconcile).toHaveBeenCalledOnce();
    const reconciled = persistence.getById(admitted.run.id);
    expect(reconciled?.lifecycleStatus).toBe("interrupted");
    expect(reconciled?.recoveryReason).toBe("provider-process-death");

    await supervisor.reconcile();
    expect(persistence.getById(admitted.run.id)?.version).toBe(reconciled?.version);
  });
});
