import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeUtcTimestamp } from "@octant/contracts";
import { CODE_HOME_DELIVERY_OBSERVED } from "@octant/contracts/code-home-activity";
import { readActivityFacts } from "./activityHistoryProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";
import { openSqlite } from "./sqlitePort";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";

const directories: Array<string> = [];
const now = decodeUtcTimestamp("2026-08-20T10:00:00.000Z");
const later = decodeUtcTimestamp("2026-08-20T11:00:00.000Z");
const earlier = decodeUtcTimestamp("2026-08-19T09:00:00.000Z");
const farFuture = decodeUtcTimestamp("9999-12-31T23:59:59.999Z");
const ids = {
  actor: "83000000-0000-4000-8000-000000000001",
  correlation: "83000000-0000-4000-8000-000000000002",
  project: "83000000-0000-4000-8000-000000000004",
  provider: "83000000-0000-4000-8000-000000000010",
  session: "83000000-0000-4000-8000-000000000011",
  manifest: "83000000-0000-4000-8000-000000000012",
  codeThread: "83000000-0000-4000-8000-000000000020",
  chatThread: "83000000-0000-4000-8000-000000000021",
  otherThread: "83000000-0000-4000-8000-000000000022",
  turn: "83000000-0000-4000-8000-000000000030",
  attempt: "83000000-0000-4000-8000-000000000031",
  operation: "83000000-0000-4000-8000-000000000040",
  operationTwo: "83000000-0000-4000-8000-000000000041",
  operationThree: "83000000-0000-4000-8000-000000000042",
  run: "83000000-0000-4000-8000-000000000050",
  runTwo: "83000000-0000-4000-8000-000000000051",
  request: "83000000-0000-4000-8000-000000000052",
  binding: "83000000-0000-4000-8000-000000000060",
  checkout: "83000000-0000-4000-8000-000000000061",
  evidence: "83000000-0000-4000-8000-000000000062",
  snapshot: "83000000-0000-4000-8000-000000000063",
} as const;
const digest = "0".repeat(64);
const repositoryId = `repo_${"a".repeat(64)}`;
let eventCounter = 0;
const versions = new Map<string, number>();

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
  versions.clear();
});

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-activity-history-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const projection = runtime.projections.get("activity-history");
  if (projection === undefined) throw new Error("Activity history projection must be registered");
  return {
    connection,
    projection,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    }),
  };
}

function append(
  journal: Journal,
  aggregateType: string,
  aggregateId: string,
  eventName: string,
  payload: unknown,
  occurredAt: string = now,
): void {
  const key = `${aggregateType}:${aggregateId}`;
  const expectedVersion = versions.get(key) ?? 0;
  versions.set(key, expectedVersion + 1);
  journal.append({
    aggregate: { aggregateType, aggregateId },
    expectedVersion,
    events: [
      {
        eventVersion: 1,
        eventId: `83000000-0000-4000-8000-${String(++eventCounter).padStart(12, "0")}`,
        eventName,
        correlationId: ids.correlation,
        actor: { kind: "local-user", actorId: ids.actor },
        occurredAt,
        payload,
      },
    ],
  });
}

const deliveryAggregate = () => ["code-home-activity", ids.project] as const;

function prMerged(overrides: Record<string, unknown> = {}) {
  return {
    kind: "prs-merged",
    projectId: ids.project,
    threadId: ids.codeThread,
    repositoryOwner: "octant-dev",
    repositoryName: "octant",
    number: 42,
    title: "Record Code Home activity",
    occurredAt: now,
    mergedBy: "henrik",
    ...overrides,
  };
}

function codeThreadPayload() {
  return {
    kind: "thread-created",
    thread: {
      id: ids.codeThread,
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      repositoryId,
      checkoutId: ids.checkout,
      title: "Activity thread",
      lifecycle: "active",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "feature",
        remoteName: "origin",
        proposedBaseRepository: "octant-dev/octant",
        proposedBaseBranch: "main",
        outcomeKind: "merged-pr",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function turnStarted(threadId: string, operationId: string, cursor: number) {
  return {
    threadId,
    operationId,
    cursor,
    occurredAt: now,
    event: {
      kind: "conversation-turn-started",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      sessionId: ids.session,
      prompt: { contentId: ids.evidence, digest, byteLength: 12 },
    },
  };
}

function opFrame(threadId: string, operationId: string, cursor: number, event: unknown) {
  return { threadId, operationId, cursor, occurredAt: now, event };
}

function chatThreadPayload() {
  return {
    kind: "thread-created",
    thread: {
      id: ids.chatThread,
      projectId: ids.project,
      title: "Chat thread",
      lifecycle: "active",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "help",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function chatAttempt(overrides: Record<string, unknown>) {
  return {
    kind: "attempt-updated",
    attempt: {
      id: ids.attempt,
      turnId: ids.turn,
      threadId: ids.chatThread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      modelId: "gpt-4o",
      contextManifestId: ids.manifest,
      outcome: "streaming",
      responseRefs: [],
      citationIds: [],
      createdAt: earlier,
      updatedAt: now,
      ...overrides,
    },
  };
}

function agentRunPayload(runId: string, requestId: string) {
  return {
    run: {
      id: runId,
      requestId,
      parentThreadId: ids.chatThread,
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
    },
  };
}

function runFacts(connection: SqliteConnection) {
  return readActivityFacts(connection, { kind: "runs", from: null, until: farFuture });
}

describe("ActivityHistoryProjection", () => {
  it("records one confirmed linked human merge as a prs-merged fact", () => {
    const { connection, journal } = openStore();
    try {
      append(journal, ...deliveryAggregate(), CODE_HOME_DELIVERY_OBSERVED, prMerged());
      const facts = readActivityFacts(connection, {
        kind: "prs-merged",
        from: null,
        until: farFuture,
      });
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        identity: "octant-dev/octant#42",
        occurredAt: now,
        threadId: ids.codeThread,
        projectId: ids.project,
      });
      expect(JSON.parse(facts[0]!.metadataJson)).toMatchObject({
        repositoryOwner: "octant-dev",
        repositoryName: "octant",
        number: 42,
        title: "Record Code Home activity",
        mergedBy: "henrik",
      });
    } finally {
      connection.close();
    }
  });

  it("keeps a fact per thread witnessing the same issue closure", () => {
    const { connection, journal } = openStore();
    try {
      const issue = {
        kind: "issues-closed",
        projectId: ids.project,
        repositoryOwner: "octant-dev",
        repositoryName: "octant",
        number: 7,
        occurredAt: now,
        closingPullRequest: { repositoryOwner: "octant-dev", repositoryName: "octant", number: 42 },
      };
      append(journal, ...deliveryAggregate(), CODE_HOME_DELIVERY_OBSERVED, {
        ...issue,
        threadId: ids.codeThread,
      });
      append(journal, ...deliveryAggregate(), CODE_HOME_DELIVERY_OBSERVED, {
        ...issue,
        threadId: ids.otherThread,
      });
      const facts = readActivityFacts(connection, {
        kind: "issues-closed",
        from: null,
        until: farFuture,
      });
      expect(facts.map((fact) => fact.threadId).sort()).toEqual(
        [ids.codeThread, ids.otherThread].sort(),
      );
    } finally {
      connection.close();
    }
  });

  it("records a successful and a failed terminal code turn and ignores a non-turn operation", () => {
    const { connection, journal } = openStore();
    try {
      append(journal, "code-thread", ids.codeThread, "code.thread-created@1", codeThreadPayload());
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        turnStarted(ids.codeThread, ids.operation, 1),
      );
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operation, 2, { kind: "operation-state", state: "completed" }),
      );
      append(
        journal,
        "code-operation",
        ids.operationTwo,
        "code.operation-event-recorded@1",
        turnStarted(ids.codeThread, ids.operationTwo, 3),
      );
      append(
        journal,
        "code-operation",
        ids.operationTwo,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operationTwo, 4, {
          kind: "operation-result",
          result: { kind: "provider-turn-state", operationId: ids.operationTwo, state: "failed" },
        }),
      );
      append(
        journal,
        "code-operation",
        ids.operationThree,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operationThree, 5, {
          kind: "operation-state",
          state: "completed",
        }),
      );
      const facts = runFacts(connection);
      expect(facts.map((fact) => fact.identity).sort()).toEqual(
        [`code:${ids.operation}`, `code:${ids.operationTwo}`].sort(),
      );
      const finishes = facts.map((fact) => JSON.parse(fact.metadataJson).finish).sort();
      expect(finishes).toEqual(["failed", "successful"]);
      expect(facts[0]).toMatchObject({ threadId: ids.codeThread, projectId: ids.project });
    } finally {
      connection.close();
    }
  });

  it("records a chat turn under the turn id once its attempt settles", () => {
    const { connection, journal } = openStore();
    try {
      append(journal, "chat-thread", ids.chatThread, "chat.thread-created@1", chatThreadPayload());
      append(journal, "chat-thread", ids.chatThread, "chat.turn-created@1", {
        kind: "turn-created",
        turn: {
          id: ids.turn,
          threadId: ids.chatThread,
          sequence: 1,
          userMessageRef: { contentId: ids.evidence, digest, byteLength: 5 },
          attachmentIds: [],
          attempts: [],
          createdAt: earlier,
        },
      });
      append(
        journal,
        "chat-thread",
        ids.chatThread,
        "chat.attempt-updated@1",
        chatAttempt({ outcome: "streaming" }),
      );
      expect(runFacts(connection)).toHaveLength(0);
      append(
        journal,
        "chat-thread",
        ids.chatThread,
        "chat.attempt-updated@1",
        chatAttempt({ outcome: "completed", updatedAt: later }),
      );
      const facts = runFacts(connection);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        identity: `chat:${ids.turn}`,
        occurredAt: later,
        threadId: ids.chatThread,
        projectId: ids.project,
      });
    } finally {
      connection.close();
    }
  });

  it("skips carried Work turns and records cancelled and interrupted AgentRuns", () => {
    const { connection, journal } = openStore();
    try {
      append(journal, "chat-thread", ids.chatThread, "chat.thread-created@1", chatThreadPayload());
      append(journal, "work-thread", ids.codeThread, "work.turn-updated@1", {
        kind: "turn-updated",
        requestId: ids.request,
        threadId: ids.codeThread,
        turnId: ids.turn,
        status: "completed",
        carried: true,
        updatedAt: now,
      });
      append(
        journal,
        "agent-run",
        ids.run,
        "agent.run-requested@1",
        agentRunPayload(ids.run, ids.request),
      );
      append(
        journal,
        "agent-run",
        ids.run,
        "agent.run-status-changed@1",
        {
          runId: ids.run,
          generation: 1,
          fromStatus: "running",
          toStatus: "cancelled",
          version: 2,
        },
        later,
      );
      append(
        journal,
        "agent-run",
        ids.runTwo,
        "agent.run-requested@1",
        agentRunPayload(ids.runTwo, "83000000-0000-4000-8000-000000000099"),
      );
      append(
        journal,
        "agent-run",
        ids.runTwo,
        "agent.run-status-changed@1",
        {
          runId: ids.runTwo,
          generation: 1,
          fromStatus: "running",
          toStatus: "interrupted",
          version: 2,
        },
        later,
      );
      const facts = runFacts(connection);
      expect(facts).toHaveLength(2);
      expect(facts.map((fact) => fact.identity).sort()).toEqual(
        [`agent-run:${ids.run}`, `agent-run:${ids.runTwo}`].sort(),
      );
      const finishes = facts.map((fact) => JSON.parse(fact.metadataJson).finish).sort();
      expect(finishes).toEqual(["canceled", "failed"]);
      expect(facts[0]).toMatchObject({ threadId: ids.chatThread, projectId: ids.project });
    } finally {
      connection.close();
    }
  });

  it("deduplicates re-observed deliveries and rebuilds unchanged", () => {
    const { connection, journal, projection } = openStore();
    try {
      append(journal, ...deliveryAggregate(), CODE_HOME_DELIVERY_OBSERVED, prMerged());
      append(journal, ...deliveryAggregate(), CODE_HOME_DELIVERY_OBSERVED, prMerged());
      const read = () =>
        readActivityFacts(connection, {
          kind: "prs-merged",
          from: null,
          until: farFuture,
        });
      expect(read()).toHaveLength(1);
      const before = read();
      rebuildProjection({ connection, journal, projection, clock: () => now });
      expect(read()).toEqual(before);
    } finally {
      connection.close();
    }
  });

  it("records a person-requested Stop then an interrupted turn as canceled", () => {
    const { connection, journal } = openStore();
    try {
      append(journal, "code-thread", ids.codeThread, "code.thread-created@1", codeThreadPayload());
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        turnStarted(ids.codeThread, ids.operation, 1),
      );
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operation, 2, {
          kind: "conversation-turn-stop-requested",
        }),
      );
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operation, 3, {
          kind: "operation-state",
          state: "interrupted",
        }),
      );
      const facts = runFacts(connection);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ identity: `code:${ids.operation}` });
      expect(JSON.parse(facts[0]!.metadataJson)).toMatchObject({
        finish: "canceled",
        runId: ids.operation,
      });
    } finally {
      connection.close();
    }
  });

  it("keeps an unsolicited interruption as failed and a stopped-but-completed turn as successful", () => {
    const { connection, journal } = openStore();
    try {
      append(journal, "code-thread", ids.codeThread, "code.thread-created@1", codeThreadPayload());
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        turnStarted(ids.codeThread, ids.operation, 1),
      );
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operation, 2, {
          kind: "operation-state",
          state: "interrupted",
        }),
      );
      append(
        journal,
        "code-operation",
        ids.operationTwo,
        "code.operation-event-recorded@1",
        turnStarted(ids.codeThread, ids.operationTwo, 3),
      );
      append(
        journal,
        "code-operation",
        ids.operationTwo,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operationTwo, 4, {
          kind: "conversation-turn-stop-requested",
        }),
      );
      append(
        journal,
        "code-operation",
        ids.operationTwo,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operationTwo, 5, {
          kind: "operation-state",
          state: "completed",
        }),
      );
      const facts = runFacts(connection);
      expect(facts).toHaveLength(2);
      const byIdentity = new Map(
        facts.map((fact) => [fact.identity, JSON.parse(fact.metadataJson).finish]),
      );
      expect(byIdentity.get(`code:${ids.operation}`)).toBe("failed");
      expect(byIdentity.get(`code:${ids.operationTwo}`)).toBe("successful");
    } finally {
      connection.close();
    }
  });

  it("records an interrupted result as canceled only when the person's marker precedes it", () => {
    const { connection, journal } = openStore();
    try {
      append(journal, "code-thread", ids.codeThread, "code.thread-created@1", codeThreadPayload());
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        turnStarted(ids.codeThread, ids.operation, 1),
      );
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operation, 2, {
          kind: "conversation-turn-stop-requested",
        }),
      );
      append(
        journal,
        "code-operation",
        ids.operation,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operation, 3, {
          kind: "operation-result",
          result: {
            kind: "provider-turn-state",
            operationId: ids.operation,
            state: "interrupted",
          },
        }),
      );
      append(
        journal,
        "code-operation",
        ids.operationTwo,
        "code.operation-event-recorded@1",
        turnStarted(ids.codeThread, ids.operationTwo, 4),
      );
      append(
        journal,
        "code-operation",
        ids.operationTwo,
        "code.operation-event-recorded@1",
        opFrame(ids.codeThread, ids.operationTwo, 5, {
          kind: "operation-result",
          result: {
            kind: "provider-turn-state",
            operationId: ids.operationTwo,
            state: "interrupted",
          },
        }),
      );
      const facts = runFacts(connection);
      expect(facts).toHaveLength(2);
      const byIdentity = new Map(
        facts.map((fact) => [fact.identity, JSON.parse(fact.metadataJson).finish]),
      );
      expect(byIdentity.get(`code:${ids.operation}`)).toBe("canceled");
      expect(byIdentity.get(`code:${ids.operationTwo}`)).toBe("failed");
    } finally {
      connection.close();
    }
  });

  it("lowercases the delivery identity across differently-cased witnesses", () => {
    const { connection, journal } = openStore();
    try {
      append(
        journal,
        ...deliveryAggregate(),
        CODE_HOME_DELIVERY_OBSERVED,
        prMerged({ repositoryOwner: "Octant-Dev", repositoryName: "Octant" }),
      );
      append(
        journal,
        ...deliveryAggregate(),
        CODE_HOME_DELIVERY_OBSERVED,
        prMerged({ threadId: ids.otherThread }),
      );
      const facts = readActivityFacts(connection, {
        kind: "prs-merged",
        from: null,
        until: farFuture,
      });
      expect(facts.map((fact) => fact.identity)).toEqual([
        "octant-dev/octant#42",
        "octant-dev/octant#42",
      ]);
    } finally {
      connection.close();
    }
  });

  it("filters facts inside the requested window", () => {
    const { connection, journal } = openStore();
    try {
      append(
        journal,
        ...deliveryAggregate(),
        CODE_HOME_DELIVERY_OBSERVED,
        prMerged({ number: 1, occurredAt: earlier }),
      );
      append(
        journal,
        ...deliveryAggregate(),
        CODE_HOME_DELIVERY_OBSERVED,
        prMerged({ number: 2, occurredAt: now }),
      );
      append(
        journal,
        ...deliveryAggregate(),
        CODE_HOME_DELIVERY_OBSERVED,
        prMerged({ number: 3, occurredAt: later }),
      );
      const facts = readActivityFacts(connection, {
        kind: "prs-merged",
        from: earlier,
        until: later,
      });
      expect(facts.map((fact) => fact.identity)).toEqual([
        "octant-dev/octant#2",
        "octant-dev/octant#1",
      ]);
      const open = readActivityFacts(connection, {
        kind: "prs-merged",
        from: null,
        until: later,
      });
      expect(open.map((fact) => fact.identity)).toEqual([
        "octant-dev/octant#2",
        "octant-dev/octant#1",
      ]);
    } finally {
      connection.close();
    }
  });
});
