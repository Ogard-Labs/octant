import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AgentRunRequested,
  AgentRunStatusChanged,
  AgentRunResultAcknowledged,
  decodeAgentRun,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  type AgentRun,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_AGGREGATE_TYPE,
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
  AgentRunEventStoreError,
} from "./agentRunEventStore";

const directories: Array<string> = [];
const now = "2026-08-01T10:00:00.000Z";
const later = "2026-08-01T10:01:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-agent-run-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  run: decodeAgentRunId("11111111-1111-4111-8111-111111111111"),
  request: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222222"),
  thread: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333333"),
  provider: "55555555-5555-4555-8555-555555555555",
  snapshot: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });

function baseRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return decodeAgentRun({
    id: ids.run,
    requestId: ids.request,
    parentThreadId: ids.thread,
    depth: 0,
    role: "research",
    task: "Summarize the design.",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "queued",
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
    routingReceipt: {
      executionResolution: {
        providerInstanceId: ids.provider,
        modelId: "gpt-4o",
        hostId: "local",
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
      selectedProviderInstanceId: ids.provider,
      selectedModelId: "gpt-4o",
      fallbackCandidates: [],
      capabilityDegradations: ["native-child-agents-unavailable"],
      contextSnapshotId: ids.snapshot,
      effectiveAuthorityDigest: "digest-1",
      usageQuality: "provider-reported",
      hostId: "local",
      mode: "chat",
    },
    workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function createStore(connection = openConnection()): AgentRunEventStore {
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
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
  return new AgentRunEventStore({ journal, uuid, actor });
}

describe("AgentRunEventStore", () => {
  it("appends a requested run at aggregate version 1", () => {
    const store = createStore();
    const run = baseRun();
    const envelope = store.appendRequested(run);
    expect(envelope.aggregateType).toBe(AGENT_RUN_AGGREGATE_TYPE);
    expect(envelope.aggregateId).toBe(ids.run);
    expect(envelope.aggregateVersion).toBe(1);
    expect(envelope.eventName).toBe(AGENT_RUN_REQUESTED);
    expect(envelope.payload).toEqual({ run });
  });

  it("appends status changes with optimistic concurrency", () => {
    const store = createStore();
    const run = baseRun();
    store.appendRequested(run);
    const changed = store.appendStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      expectedVersion: 1,
      occurredAt: later as never,
    });
    expect(changed.aggregateVersion).toBe(2);
    expect(changed.eventName).toBe(AGENT_RUN_STATUS_CHANGED);

    expect(() =>
      store.appendStatusChanged({
        runId: ids.run,
        fromStatus: "queued",
        toStatus: "starting",
        version: 2,
        expectedVersion: 1,
        occurredAt: later as never,
      }),
    ).toThrow(AgentRunEventStoreError);
  });

  it("replays a run's events in order after restart from journal truth", () => {
    const connection = openConnection();
    const first = createStore(connection);
    const run = baseRun();
    first.appendRequested(run);
    first.appendStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      expectedVersion: 1,
      occurredAt: later as never,
    });
    first.appendStatusChanged({
      runId: ids.run,
      fromStatus: "starting",
      toStatus: "running",
      version: 3,
      expectedVersion: 2,
      occurredAt: later as never,
    });

    const restarted = createStore(connection);
    const replay = restarted.replayRun({ runId: ids.run, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.events.map((event) => event.eventName)).toEqual([
      AGENT_RUN_REQUESTED,
      AGENT_RUN_STATUS_CHANGED,
      AGENT_RUN_STATUS_CHANGED,
    ]);
    expect(replay.events.map((event) => event.aggregateVersion)).toEqual([1, 2, 3]);
  });

  it("appends result acknowledgement events", () => {
    const store = createStore();
    const run = baseRun();
    store.appendRequested(run);
    store.appendStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      expectedVersion: 1,
      occurredAt: later as never,
    });
    store.appendStatusChanged({
      runId: ids.run,
      fromStatus: "starting",
      toStatus: "running",
      version: 3,
      expectedVersion: 2,
      occurredAt: later as never,
    });
    store.appendStatusChanged({
      runId: ids.run,
      fromStatus: "running",
      toStatus: "completed",
      version: 4,
      expectedVersion: 3,
      occurredAt: later as never,
    });
    const ack = store.appendResultAcknowledged({
      runId: ids.run,
      version: 5,
      expectedVersion: 4,
      acknowledgedAt: later as never,
    });
    expect(ack.eventName).toBe(AGENT_RUN_RESULT_ACKNOWLEDGED);
    expect(ack.aggregateVersion).toBe(5);
  });
});
