import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeChatThread,
  decodeCodeEvidenceBatchResponse,
  decodeCodeEvidenceContentId,
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeThread,
  decodeProviderInstanceId,
  decodeWindowId,
  decodeWorkThread,
  decodeWorkTurnState,
  type AgentRun,
  type EventEnvelope,
  type UsageResumeRecord,
  type UtcTimestamp,
} from "@octant/contracts";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createUsageResumePorts, type UsageResumePortDependencies } from "./usageResumePorts";

const NOW = "2026-07-19T12:00:00.000Z" as UtcTimestamp;
const RESET = "2026-07-19T13:00:00.000Z" as UtcTimestamp;

const ids = {
  window: decodeWindowId("83000000-0000-4000-8000-000000000001"),
  project: "83000000-0000-4000-8000-000000000002",
  thread: "83000000-0000-4000-8000-000000000003",
  turn: "83000000-0000-4000-8000-000000000004",
  attempt: "83000000-0000-4000-8000-000000000005",
  binding: "83000000-0000-4000-8000-000000000006",
  checkout: "83000000-0000-4000-8000-000000000007",
  repository: "83000000-0000-4000-8000-000000000008",
  content: decodeCodeEvidenceContentId("83000000-0000-4000-8000-000000000009"),
  provider: "83000000-0000-4000-8000-00000000000a",
  request: "83000000-0000-4000-8000-00000000000b",
  correlation: "83000000-0000-4000-8000-00000000000c",
  run: "83000000-0000-4000-8000-000000000010",
};

let directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-usage-resume-ports-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  return connection;
}

function record(): UsageResumeRecord {
  return {
    threadId: ids.thread,
    turnId: ids.turn,
    attemptId: ids.attempt,
    providerInstanceId: decodeProviderInstanceId(ids.provider),
    usageLimit: { kind: "exhausted", resetsAt: RESET },
    resetsAt: RESET,
    scheduledAt: NOW,
  };
}

function chatThread(overrides: Record<string, unknown> = {}) {
  return decodeChatThread({
    id: ids.thread,
    title: "Provider-neutral Chat",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm, direct, and useful.",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function workThread(overrides: Record<string, unknown> = {}) {
  return decodeWorkThread({
    id: ids.thread,
    projectId: ids.project,
    title: "Draft brief",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    bindingRevisionId: ids.binding,
    workingDirectory: ".",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function waitingWorkTurn() {
  return decodeWorkTurnState({
    requestId: ids.request,
    threadId: ids.thread,
    turnId: ids.turn,
    projectId: ids.project,
    authority: {
      hostId: "local",
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId: ids.provider,
      modelId: "model-a",
    },
    providerSessionId: "83000000-0000-4000-8000-00000000000d",
    resumeCursor: { driverKind: "openai-compatible", value: "session-1" },
    status: "waiting",
    prompt: "Keep going.",
    transcript: [],
    failure: {
      category: "rate-limited",
      message: "The provider's usage window is spent.",
      usageLimit: { kind: "exhausted", resetsAt: RESET },
    },
    capabilities: {
      workspace: "project-backed",
      confinement: "project-root-confined",
      shell: "denied",
      git: "denied",
      worktree: "denied",
      pullRequest: "denied",
      code: "denied",
    },
    version: 1,
    acceptedAt: NOW,
    updatedAt: NOW,
  });
}

function codeThread(overrides: Record<string, unknown> = {}) {
  return decodeCodeThread({
    id: ids.thread,
    projectId: ids.project,
    bindingRevisionId: ids.binding,
    repositoryId: `repo_${"d".repeat(64)}`,
    checkoutId: ids.checkout,
    title: "Authority foundation",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    executionPolicy: "full-access",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/phase-7",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: NOW,
    },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function waitingProviderTurnFrame(): EventEnvelope {
  return {
    eventId: "83000000-0000-4000-8000-00000000000e",
    globalSequence: 1,
    aggregateType: "code-operation",
    aggregateId: ids.turn,
    aggregateVersion: 1,
    eventName: "code.operation-event-recorded@1",
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: "83000000-0000-4000-8000-00000000000f" },
    occurredAt: NOW,
    payload: {
      threadId: ids.thread,
      operationId: ids.turn,
      cursor: 1,
      occurredAt: NOW,
      event: {
        kind: "operation-result",
        result: {
          kind: "provider-turn-state",
          operationId: ids.turn,
          state: "waiting",
          evidence: {
            contentId: String(ids.content),
            digest: "a".repeat(64),
            byteLength: 11,
          },
          failure: {
            category: "waiting",
            message: "The provider's usage window is spent.",
            usageLimit: { kind: "exhausted", resetsAt: RESET },
          },
        },
      },
    },
  } as EventEnvelope;
}

function dependencies(
  overrides: {
    readonly journal?: UsageResumePortDependencies["journal"];
    readonly chat?: UsageResumePortDependencies["chat"];
    readonly work?: UsageResumePortDependencies["work"];
    readonly code?: UsageResumePortDependencies["code"];
    readonly agentRun?: UsageResumePortDependencies["agentRun"];
  } = {},
): UsageResumePortDependencies {
  return {
    connection: openConnection(),
    journal: overrides.journal ?? { replayAggregate: () => [] },
    clock: () => new Date(NOW),
    uuid: () => crypto.randomUUID(),
    windowId: () => ids.window,
    chat: overrides.chat ?? {
      readThread: () => undefined,
      readThreadView: () => undefined,
      execute: async () => ({}),
    },
    work: overrides.work ?? {
      readThread: () => undefined,
      listTurns: () => [],
      startFirstTurn: async () => ({
        kind: "accepted",
        turn: waitingWorkTurn(),
      }),
    },
    code: overrides.code ?? {
      readThread: () => undefined,
      readRuntimeWorks: () => [],
    },
    agentRun: overrides.agentRun ?? {
      readRun: () => undefined,
      liveAuthority: () => undefined,
      resume: () => ({ kind: "run-command-failed", reason: "invalid", message: "invalid" }),
    },
  };
}

describe("usage-resume ports", () => {
  it("marks a Chat limit recovery retry as the host's own dispatch", async () => {
    const execute = vi.fn(async () => ({}));
    const ports = createUsageResumePorts(
      dependencies({
        chat: { readThread: () => undefined, readThreadView: () => undefined, execute },
      }),
    );

    const result = await ports.chat.dispatch(record());
    expect(result).toEqual({ kind: "dispatched" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "retry-chat-turn" }), {
      limitRecovery: true,
    });
  });

  it("marks a Work limit recovery turn as the host's own dispatch", async () => {
    const startFirstTurn = vi.fn(async () => ({
      kind: "accepted" as const,
      turn: waitingWorkTurn(),
    }));
    const ports = createUsageResumePorts(
      dependencies({
        work: {
          readThread: () => workThread(),
          listTurns: () => [waitingWorkTurn()],
          startFirstTurn,
        },
      }),
    );

    await ports.work.dispatch(record());
    expect(startFirstTurn).toHaveBeenCalledWith(
      ids.window,
      expect.objectContaining({
        kind: "start-work-thread-turn",
        prompt: "Keep going.",
      }),
      { limitRecovery: true },
    );
  });

  it("marks a Code limit recovery turn as the host's own dispatch", async () => {
    const executeOperation = vi.fn(async () => ({
      kind: "provider-turn-state" as const,
      operationId: decodeCodeOperationId(ids.turn),
      state: "running" as const,
    }));
    const ports = createUsageResumePorts(
      dependencies({
        journal: { replayAggregate: () => [waitingProviderTurnFrame()] },
        code: {
          readThread: () => codeThread(),
          readRuntimeWorks: () => [],
          readOperationContents: async () =>
            decodeCodeEvidenceBatchResponse({
              threadId: String(codeThread().id),
              items: [
                {
                  operationId: ids.turn,
                  contentId: String(ids.content),
                  text: "Keep going.",
                },
              ],
            }),
          stageEvidence: async () =>
            decodeCodeEvidenceReference({
              contentId: String(ids.content),
              digest: "a".repeat(64),
              byteLength: 11,
            }),
          executeOperation,
        },
      }),
    );

    const result = await ports.code.dispatch(record());
    expect(result).toEqual({ kind: "dispatched" });
    expect(executeOperation).toHaveBeenCalledWith(
      ids.window,
      expect.objectContaining({ kind: "start-provider-turn" }),
      { limitRecovery: true },
    );
  });

  it("lifts a limit-owned snooze when the resume dispatch settles", () => {
    const ports = createUsageResumePorts(
      dependencies({
        chat: {
          readThread: () =>
            chatThread({ snooze: { until: RESET, at: NOW, origin: "usage-limit" } }),
          readThreadView: () => undefined,
          execute: async () => ({}),
        },
      }),
    );

    const update = ports.chat.settleUpdate?.(record(), "dispatched", undefined, 4);
    if (update === undefined) throw new Error("Expected the settle update.");
    const thread = (update.payload as { thread: Record<string, unknown> }).thread;
    expect(thread).not.toHaveProperty("snooze");
    expect(thread.usageResume).toMatchObject({ status: "dispatched" });
  });

  it("leaves a snooze the person set alone when the resume dispatch settles", () => {
    const ports = createUsageResumePorts(
      dependencies({
        chat: {
          readThread: () => chatThread({ snooze: { until: RESET, at: NOW } }),
          readThreadView: () => undefined,
          execute: async () => ({}),
        },
      }),
    );

    const update = ports.chat.settleUpdate?.(record(), "dispatched", undefined, 4);
    if (update === undefined) throw new Error("Expected the settle update.");
    const thread = (update.payload as { thread: Record<string, unknown> }).thread;
    expect(thread.snooze).toEqual({ until: RESET, at: NOW });
  });

  it("keeps a limit-owned snooze when the resume settles without dispatching", () => {
    const ports = createUsageResumePorts(
      dependencies({
        chat: {
          readThread: () =>
            chatThread({ snooze: { until: RESET, at: NOW, origin: "usage-limit" } }),
          readThreadView: () => undefined,
          execute: async () => ({}),
        },
      }),
    );

    const update = ports.chat.settleUpdate?.(record(), "invalidated", "Stale", 4);
    if (update === undefined) throw new Error("Expected the settle update.");
    const thread = (update.payload as { thread: { snooze?: unknown } }).thread;
    expect(thread.snooze).toMatchObject({ origin: "usage-limit" });
  });

  function runRecord(): UsageResumeRecord {
    const { attemptId: _attempt, ...rest } = record();
    return { ...rest, threadId: ids.run, turnId: ids.run };
  }

  function run(overrides: Record<string, unknown> = {}): AgentRun {
    return {
      id: ids.run,
      parentThreadId: ids.thread,
      lifecycleStatus: "waiting",
      usageLimit: { kind: "exhausted", resetsAt: RESET },
      usageResume: { record: runRecord(), status: "scheduled" },
      routingReceipt: {
        selectedProviderInstanceId: ids.provider,
        selectedModelId: "gpt-4o",
      },
      version: 5,
      ...overrides,
    } as AgentRun;
  }

  it("reports a limited child run ready only while every journaled premise holds", async () => {
    const ports = createUsageResumePorts(
      dependencies({
        agentRun: {
          readRun: () => run(),
          liveAuthority: () => ({}) as never,
          resume: () => ({ kind: "run-updated", run: run() }) as never,
        },
      }),
    );

    expect(await ports.agentRun.inspect(runRecord())).toEqual({ kind: "ready" });
    const premises: ReadonlyArray<Record<string, unknown>> = [
      { lifecycleStatus: "cancelled" },
      { usageLimit: undefined },
      { usageLimit: { kind: "exhausted", resetsAt: "2026-07-19T14:00:00.000Z" } },
      {
        routingReceipt: {
          selectedProviderInstanceId: "83000000-0000-4000-8000-00000000000d",
          selectedModelId: "gpt-4o",
        },
      },
      { usageResume: undefined },
    ];
    for (const premise of premises) {
      const narrow = createUsageResumePorts(
        dependencies({
          agentRun: {
            readRun: () => run(premise),
            liveAuthority: () => ({}) as never,
            resume: () => ({ kind: "run-updated", run: run() }) as never,
          },
        }),
      );
      expect((await narrow.agentRun.inspect(runRecord())).kind).toBe("invalid");
    }
  });

  it("resumes a limited child through the ordinary start path with the live grant", async () => {
    const authority = { executionPolicy: "plan" } as never;
    const resume = vi.fn(() => ({ kind: "run-updated", run: run() }) as never);
    const ports = createUsageResumePorts(
      dependencies({
        agentRun: {
          readRun: () => run(),
          liveAuthority: () => authority,
          resume,
        },
      }),
    );

    const result = await ports.agentRun.dispatch(runRecord());
    expect(result).toEqual({ kind: "dispatched" });
    expect(resume).toHaveBeenCalledWith(ids.run, 5, authority);
  });

  it("refuses to resume a child whose parent grant no longer exists", async () => {
    const ports = createUsageResumePorts(
      dependencies({
        agentRun: {
          readRun: () => run(),
          liveAuthority: () => undefined,
          resume: () => ({ kind: "run-updated", run: run() }) as never,
        },
      }),
    );

    const result = await ports.agentRun.dispatch(runRecord());
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.detail).toMatch(/parent thread grant/);
    }
  });

  it("folds a journaled settle back into the run projection", () => {
    const applySettled = vi.fn();
    const ports = createUsageResumePorts(
      dependencies({
        agentRun: {
          readRun: () => run(),
          liveAuthority: () => undefined,
          resume: () =>
            ({ kind: "run-command-failed", reason: "invalid", message: "invalid" }) as never,
          applySettled,
        },
      }),
    );

    const settled = { resume: runRecord(), outcome: "dispatched" as const };
    ports.agentRun.settleApplied?.(settled, undefined);
    expect(applySettled).toHaveBeenCalledWith(settled);
  });
});
