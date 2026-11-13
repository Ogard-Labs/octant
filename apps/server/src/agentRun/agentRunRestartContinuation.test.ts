import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AgentRunRequested,
  AgentRunStatusChanged,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCommand,
  type AgentRunRoutingReceipt,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { createCodeRestartContinuationAttempts } from "../code/codeRestartContinuation";
import { RESTART_CONTINUATION_PROMPT } from "../harness/restartContinuation";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
} from "./agentRunEventStore";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProjection } from "./agentRunProjection";
import {
  continueAgentRunsCutOffByRestart,
  type AgentRunRestartContinuationPorts,
} from "./agentRunRestartContinuation";

const now = "2026-11-13T10:00:00.000Z";
const directories: Array<string> = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  request: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222222"),
  thread: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333333"),
  provider: "55555555-5555-4555-8555-555555555555",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});

const parentAuthority: AgentRunAuthority = {
  filesystem: true,
  shell: true,
  git: true,
  network: true,
  tools: true,
  subagents: true,
  executionPolicy: "approval-gated",
  permissionPersistence: "project-default",
};

const routingReceipt: AgentRunRoutingReceipt = {
  executionResolution: {
    providerInstanceId: ids.provider as never,
    modelId: "model-a" as never,
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
  selectedModelId: "model-a" as never,
  fallbackCandidates: [],
  capabilityDegradations: ["native-child-agents-unavailable"],
  contextSnapshotId: "66666666-6666-4666-8666-666666666666" as never,
  effectiveAuthorityDigest: "digest-1",
  usageQuality: "provider-reported",
  hostId: "local" as never,
  mode: "chat",
};

const requestCommand: Extract<AgentRunCommand, { kind: "request-agent-run" }> = {
  kind: "request-agent-run",
  requestId: ids.request,
  parentThreadId: ids.thread,
  role: "research",
  task: "Summarize the design.",
  creationPosture: "automatic",
  requestedAuthority: {
    filesystem: false,
    shell: false,
    git: false,
    network: true,
    tools: true,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  routingReceipt,
  workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
};

/** One host's lifetime over a journal file that outlives it. */
function startHost(connection: SqliteConnection) {
  const registry = new EventRegistry()
    .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
    .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged);
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const uuid = randomUUID;
  const persistence = new AgentRunPersistenceService({
    store: new AgentRunEventStore({ journal, uuid, actor }),
    projection: new AgentRunProjection(),
    uuid,
    clock: () => now,
    connection,
  });
  persistence.rebuildFromJournal();
  const cutOff = persistence.reconcileAfterRestart();
  return { persistence, cutOff };
}

function openJournalFile(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-agent-run-restart-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

/** Puts the run on its provider, as a session reporting that it runs would. */
function markRunning(persistence: AgentRunPersistenceService, run: AgentRun): void {
  const result = persistence.applyCommand({
    kind: "mark-agent-run-running",
    runId: run.id,
    expectedVersion: run.version as never,
  });
  expect(result.kind).toBe("run-updated");
}

function continuationPorts(
  host: ReturnType<typeof startHost>,
  connection: SqliteConnection,
  overrides: Partial<AgentRunRestartContinuationPorts> = {},
) {
  const resumed: Array<string> = [];
  const ports: AgentRunRestartContinuationPorts = {
    quitByPerson: false,
    cutOff: host.cutOff,
    readRun: (run) => host.persistence.getById(run.id),
    enabled: () => true,
    parentOptedOut: () => false,
    latestStartVersion: (run) => host.persistence.latestStartVersion(run.id),
    attempts: createCodeRestartContinuationAttempts(connection),
    // What the ordinary resume journals once its checks pass.
    resume: async (run, message) => {
      resumed.push(message);
      return host.persistence.applyCommand({
        kind: "resume-agent-run",
        runId: run.id,
        expectedVersion: run.version as never,
        message,
      });
    },
    ...overrides,
  };
  return { ports, resumed };
}

describe("subagent restart continuation", () => {
  it("resumes a cut-off run across restarts until its own continuations are cut off twice", async () => {
    const connection = openJournalFile();
    const first = startHost(connection);
    const accepted = first.persistence.requestRun({
      command: requestCommand,
      parentAuthority,
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("the run was not accepted");
    const started = first.persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    if (started.kind !== "run-updated") throw new Error("the run did not start");
    markRunning(first.persistence, started.run);

    // The host crashes while the run is on its provider; each later start
    // rebuilds from the journal, interrupts it and decides.
    for (const attempt of [1, 2]) {
      const host = startHost(connection);
      expect(host.cutOff.map((run) => String(run.id))).toEqual([String(accepted.run.id)]);
      const { ports, resumed } = continuationPorts(host, connection);
      const recovered = await continueAgentRunsCutOffByRestart(ports);
      expect(recovered).toEqual({ continued: [{ mode: "chat", threadId: ids.thread }], held: [] });
      expect(resumed).toEqual([RESTART_CONTINUATION_PROMPT]);
      const resumedRun = host.persistence.getById(accepted.run.id);
      expect(resumedRun?.lifecycleStatus, `continuation ${attempt}`).toBe("starting");
      if (resumedRun !== undefined) markRunning(host.persistence, resumedRun);
    }

    const third = startHost(connection);
    const { ports, resumed } = continuationPorts(third, connection);
    const recovered = await continueAgentRunsCutOffByRestart(ports);
    expect(resumed).toEqual([]);
    expect(recovered.continued).toEqual([]);
    expect(recovered.held).toMatchObject([
      { mode: "chat", threadId: ids.thread, reason: "crash-loop" },
    ]);
    // Held runs stay Interrupted, so only a person's Resume runs them again.
    expect(third.persistence.getById(accepted.run.id)?.lifecycleStatus).toBe("interrupted");

    // A person resumes it; the next crash starts a fresh chain.
    const held = third.persistence.getById(accepted.run.id);
    if (held === undefined) throw new Error("the run is gone");
    const personResumed = third.persistence.applyCommand({
      kind: "resume-agent-run",
      runId: held.id,
      expectedVersion: held.version as never,
    });
    if (personResumed.kind !== "run-updated") throw new Error("the person's resume failed");
    markRunning(third.persistence, personResumed.run);
    const fourth = startHost(connection);
    const afterPerson = await continueAgentRunsCutOffByRestart(
      continuationPorts(fourth, connection).ports,
    );
    expect(afterPerson.continued).toHaveLength(1);
  });

  it("holds a cut-off run for its person after a deliberate quit or with the setting off", async () => {
    const connection = openJournalFile();
    const first = startHost(connection);
    const accepted = first.persistence.requestRun({
      command: requestCommand,
      parentAuthority,
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("the run was not accepted");
    const started = first.persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    if (started.kind !== "run-updated") throw new Error("the run did not start");

    const host = startHost(connection);
    for (const [overrides, reason] of [
      [{ quitByPerson: true }, "quit"],
      [{ enabled: () => false }, "turned-off"],
      [{ parentOptedOut: () => true }, "opted-out"],
    ] as const) {
      const { ports, resumed } = continuationPorts(host, connection, overrides);
      const recovered = await continueAgentRunsCutOffByRestart(ports);
      expect(resumed).toEqual([]);
      expect(recovered.held).toMatchObject([{ reason }]);
    }
    expect(host.persistence.getById(accepted.run.id)?.lifecycleStatus).toBe("interrupted");
  });

  it("names a refused resume as held and leaves the run for its person", async () => {
    const connection = openJournalFile();
    const first = startHost(connection);
    const accepted = first.persistence.requestRun({
      command: requestCommand,
      parentAuthority,
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("the run was not accepted");
    first.persistence.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    const host = startHost(connection);
    const { ports } = continuationPorts(host, connection, {
      resume: async () => ({
        kind: "run-command-failed",
        reason: "unsupported-transition",
        message: "The parent execution authority is no longer available.",
      }),
    });
    const recovered = await continueAgentRunsCutOffByRestart(ports);
    expect(recovered.held).toEqual([
      {
        mode: "chat",
        threadId: ids.thread,
        reason: "refused",
        detail: "The parent execution authority is no longer available.",
      },
    ]);
  });
});
