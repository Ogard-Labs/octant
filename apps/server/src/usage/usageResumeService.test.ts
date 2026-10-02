import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  decodeChatThread,
  decodeProviderInstanceId,
  USAGE_RESUME_CANCELLED,
  USAGE_RESUME_SCHEDULED,
  USAGE_RESUME_SETTLED,
  type ChatThread,
  type UsageResumeRecord,
  type UtcTimestamp,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  listPendingUsageResumes,
  readUsageResumeState,
} from "../persistence/usageResumeProjection";
import { UsageResumeService, type UsageResumeModePort } from "./usageResumeService";

const ids = {
  actor: "82000000-0000-4000-8000-000000000010",
  attempt: "82000000-0000-4000-8000-000000000021",
  binding: "82000000-0000-4000-8000-000000000022",
  content: "82000000-0000-4000-8000-000000000023",
  correlation: "82000000-0000-4000-8000-000000000024",
  manifest: "82000000-0000-4000-8000-000000000025",
  operation: "82000000-0000-4000-8000-000000000026",
  project: "82000000-0000-4000-8000-000000000027",
  provider: "82000000-0000-4000-8000-000000000028",
  request: "82000000-0000-4000-8000-000000000029",
  run: "82000000-0000-4000-8000-00000000002e",
  session: "82000000-0000-4000-8000-00000000002a",
  thread: "82000000-0000-4000-8000-00000000002b",
  turn: "82000000-0000-4000-8000-00000000002c",
  turn2: "82000000-0000-4000-8000-00000000002d",
};

const NOW = "2026-07-19T12:00:00.000Z" as UtcTimestamp;
const RESET = "2026-07-19T13:00:00.000Z" as UtcTimestamp;
const PAST_RESET = "2026-07-19T11:00:00.000Z" as UtcTimestamp;

let directories: Array<string> = [];
let nowMs = Date.parse(NOW);
let nextTimerHandle = 0;
let timers = new Map<number, { readonly at: number; readonly fire: () => void }>();

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  timers = new Map();
  nextTimerHandle = 0;
  nowMs = Date.parse(NOW);
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-usage-resume-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  return connection;
}

function journal(connection: SqliteConnection) {
  const runtime = createPhase1RuntimeRegistries();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date(nowMs).toISOString(),
  });
}

function pending(eventName: string, payload: unknown) {
  return {
    eventId: crypto.randomUUID(),
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system" as const, actorId: ids.actor },
    occurredAt: new Date(nowMs).toISOString(),
    payload,
  };
}

function record(overrides: Partial<UsageResumeRecord> = {}): UsageResumeRecord {
  return {
    threadId: ids.thread,
    turnId: ids.turn,
    attemptId: ids.attempt,
    providerInstanceId: decodeProviderInstanceId(ids.provider),
    usageLimit: { kind: "exhausted", resetsAt: RESET },
    resetsAt: RESET,
    scheduledAt: NOW,
    ...overrides,
  };
}

function thread(overrides: Record<string, unknown> = {}): ChatThread {
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

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.attempt,
    turnId: ids.turn,
    threadId: ids.thread,
    providerInstanceId: ids.provider,
    providerSessionId: ids.session,
    modelId: "model-a",
    contextManifestId: ids.manifest,
    outcome: "waiting",
    usageLimit: { kind: "exhausted", resetsAt: RESET },
    responseRefs: [],
    citationIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.turn,
    threadId: ids.thread,
    sequence: 1,
    userMessageRef: {
      contentId: ids.content,
      digest: "d".repeat(64),
      byteLength: 4,
    },
    attachmentIds: [],
    attempts: [attempt()],
    createdAt: NOW,
    ...overrides,
  };
}

type SettleUpdateFn = NonNullable<UsageResumeModePort["settleUpdate"]>;
type SettleAppliedFn = NonNullable<UsageResumeModePort["settleApplied"]>;

interface PortSpies {
  readonly inspect: MockedFunction<UsageResumeModePort["inspect"]>;
  readonly dispatch: MockedFunction<UsageResumeModePort["dispatch"]>;
  readonly settleUpdate: MockedFunction<SettleUpdateFn>;
  readonly settleApplied: MockedFunction<SettleAppliedFn>;
}

function portSpies(overrides: Partial<UsageResumeModePort> = {}): PortSpies {
  return {
    inspect: vi.fn<UsageResumeModePort["inspect"]>(
      overrides.inspect ?? (async () => ({ kind: "ready" }) as const),
    ),
    dispatch: vi.fn<UsageResumeModePort["dispatch"]>(
      overrides.dispatch ?? (async () => ({ kind: "dispatched" }) as const),
    ),
    settleUpdate: vi.fn<SettleUpdateFn>(overrides.settleUpdate ?? (() => undefined)),
    settleApplied: vi.fn<SettleAppliedFn>(overrides.settleApplied ?? (() => undefined)),
  };
}

function serviceWith(
  connection: SqliteConnection,
  spies: { chat: PortSpies; work: PortSpies; code: PortSpies; agentRun?: PortSpies },
) {
  const agentRun = spies.agentRun ?? portSpies();
  const store = journal(connection);
  const service = new UsageResumeService({
    journal: store,
    connection,
    clock: () => new Date(nowMs),
    uuid: () => crypto.randomUUID(),
    ports: {
      chat: {
        inspect: spies.chat.inspect,
        dispatch: spies.chat.dispatch,
        settleUpdate: spies.chat.settleUpdate,
        settleApplied: spies.chat.settleApplied,
      },
      work: {
        inspect: spies.work.inspect,
        dispatch: spies.work.dispatch,
        settleUpdate: spies.work.settleUpdate,
        settleApplied: spies.work.settleApplied,
      },
      code: {
        inspect: spies.code.inspect,
        dispatch: spies.code.dispatch,
        settleUpdate: spies.code.settleUpdate,
        settleApplied: spies.code.settleApplied,
      },
      agentRun: {
        inspect: agentRun.inspect,
        dispatch: agentRun.dispatch,
        settleUpdate: agentRun.settleUpdate,
        settleApplied: agentRun.settleApplied,
      },
    },
    schedule: (at, fire) => {
      const handle = ++nextTimerHandle;
      timers.set(handle, { at, fire });
      return handle;
    },
    unschedule: (handle) => {
      timers.delete(handle as number);
    },
    onError: (message, error) => {
      console.error("[usage-resume-test]", message, error);
    },
  });
  store.subscribeCommitted((append) => service.onCommittedAppend(append));
  return { service, store };
}

function fireDue(atMs: number) {
  // Firing a timer means the clock reached it.
  nowMs = Math.max(nowMs, atMs);
  for (const [handle, timer] of timers) {
    if (timer.at <= atMs) {
      timers.delete(handle);
      timer.fire();
    }
  }
}

function resumeRow(connection: SqliteConnection, aggregateType: string, threadId: string) {
  return readUsageResumeState(connection, aggregateType, threadId);
}

function seededChatThread(connection: SqliteConnection) {
  const store = journal(connection);
  store.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
    expectedVersion: 0,
    events: [pending("chat.thread-created@1", { kind: "thread-created", thread: thread() })],
  });
  store.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
    expectedVersion: 1,
    events: [pending("chat.turn-created@1", { kind: "turn-created", turn: turn() })],
  });
  return store;
}

describe("UsageResumeService", () => {
  it("dispatches the recorded stop's continuation when the reset time arrives", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });

    expect(listPendingUsageResumes(connection)).toHaveLength(1);
    expect(timers.size).toBe(1);
    fireDue(Date.parse(RESET) - 1);
    await Promise.resolve();
    expect(spies.chat.inspect).not.toHaveBeenCalled();

    fireDue(Date.parse(RESET));
    await vi.waitFor(() => expect(spies.chat.dispatch).toHaveBeenCalledOnce());
    expect(spies.chat.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: ids.turn, attemptId: ids.attempt }),
    );
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("dispatched"),
    );
    expect(listPendingUsageResumes(connection)).toHaveLength(0);
    expect(spies.chat.settleApplied).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "dispatched" }),
      undefined,
    );
  });

  it("journals the settle and the thread's updated resume state in one append", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    spies.chat.settleUpdate.mockImplementation(
      (
        resume: UsageResumeRecord,
        outcome: string,
        _detail: string | undefined,
        version: number,
      ) => ({
        eventName: "chat.thread-updated@1",
        payload: {
          kind: "thread-updated",
          thread: thread({
            usageResume: { record: resume, status: outcome },
            version,
            updatedAt: new Date(nowMs).toISOString(),
          }),
        },
      }),
    );
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });

    fireDue(Date.parse(RESET));
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("dispatched"),
    );

    const envelopes = store.replayAggregate({
      aggregateType: "chat-thread",
      aggregateId: ids.thread,
      afterVersion: 3,
      limit: 10,
    });
    expect(envelopes.map((envelope) => envelope.eventName)).toEqual([
      USAGE_RESUME_SETTLED,
      "chat.thread-updated@1",
    ]);
    const updated = envelopes[1]?.payload as {
      thread: { version: number; usageResume?: { status: string } };
    };
    expect(updated.thread.version).toBe(5);
    expect(updated.thread.usageResume?.status).toBe("dispatched");
  });

  it("does not dispatch after the person cancels the opt-in", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 3,
      events: [pending(USAGE_RESUME_CANCELLED, { resume: record() })],
    });

    expect(timers.size).toBe(0);
    fireDue(Date.parse(RESET));
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(spies.chat.dispatch).not.toHaveBeenCalled();
    expect(resumeRow(connection, "chat-thread", ids.thread)).toBeUndefined();
  });

  it("settles invalidated when a newer turn starts on the scheduled thread", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 3,
      events: [
        pending("chat.turn-created@1", {
          kind: "turn-created",
          turn: turn({ id: ids.turn2, sequence: 2 }),
        }),
      ],
    });

    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("invalidated"),
    );
    expect(resumeRow(connection, "chat-thread", ids.thread)?.detail).toContain("newer turn");
    fireDue(Date.parse(RESET));
    await new Promise((resolve) => setImmediate(resolve));
    expect(spies.chat.dispatch).not.toHaveBeenCalled();
  });

  it("settles invalidated when the recorded attempt stops being the waiting limited one", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 3,
      events: [
        pending("chat.attempt-updated@1", {
          kind: "attempt-updated",
          attempt: (({ usageLimit: _dropped, ...rest }) => rest)(attempt({ outcome: "cancelled" })),
        }),
      ],
    });

    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("invalidated"),
    );
  });

  it("settles invalidated when a provider turn runs on a scheduled Code thread", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    const { attemptId: _noAttempt, ...codeRecord } = record({ turnId: ids.operation });
    store.append({
      aggregate: { aggregateType: "code-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        pending(USAGE_RESUME_SCHEDULED, {
          resume: codeRecord,
        }),
      ],
    });
    store.append({
      aggregate: { aggregateType: "code-operation", aggregateId: ids.operation },
      expectedVersion: 0,
      events: [
        pending("code.operation-event-recorded@1", {
          threadId: ids.thread,
          operationId: ids.operation,
          cursor: 1,
          occurredAt: NOW,
          event: {
            kind: "operation-result",
            result: {
              kind: "provider-turn-state",
              operationId: ids.operation,
              state: "running",
            },
          },
        }),
      ],
    });

    await vi.waitFor(() =>
      expect(resumeRow(connection, "code-thread", ids.thread)?.status).toBe("invalidated"),
    );
  });

  it("settles invalidated when a newer Work turn is accepted on the thread", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    const { attemptId: _noAttempt, ...workRecord } = record();
    store.append({
      aggregate: { aggregateType: "work-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        pending(USAGE_RESUME_SCHEDULED, {
          resume: workRecord,
        }),
      ],
    });
    store.append({
      aggregate: { aggregateType: "work-thread", aggregateId: ids.thread },
      expectedVersion: 1,
      events: [
        pending("work.turn-accepted@1", {
          kind: "turn-accepted",
          requestId: ids.request,
          threadId: ids.thread,
          turnId: ids.turn2,
          projectId: ids.project,
          authority: {
            hostId: "82000000-0000-4000-8000-000000000030",
            projectId: ids.project,
            bindingRevisionId: ids.binding,
            workingDirectory: ".",
            confinementPosture: "project-root-confined",
            providerInstanceId: ids.provider,
            modelId: "model-a",
          },
          providerSessionId: ids.session,
          prompt: "continue",
          capabilities: {
            workspace: "project-backed",
            confinement: "project-root-confined",
            shell: "denied",
            git: "denied",
            worktree: "denied",
            pullRequest: "denied",
            code: "denied",
          },
          acceptedAt: NOW,
        }),
      ],
    });

    await vi.waitFor(() =>
      expect(resumeRow(connection, "work-thread", ids.thread)?.status).toBe("invalidated"),
    );
  });

  it("settles invalidated when the mode finds the premise already moved", async () => {
    const connection = openConnection();
    const spies = {
      chat: portSpies({
        inspect: vi.fn(async () => ({ kind: "invalid", detail: "Provider changed." }) as const),
      }),
      work: portSpies(),
      code: portSpies(),
    };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });

    fireDue(Date.parse(RESET));
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("invalidated"),
    );
    expect(spies.chat.dispatch).not.toHaveBeenCalled();
  });

  it("settles failed when the mode refuses to admit the continuation", async () => {
    const connection = openConnection();
    const spies = {
      chat: portSpies({
        dispatch: vi.fn(
          async () => ({ kind: "refused", detail: "A request is pending." }) as const,
        ),
      }),
      work: portSpies(),
      code: portSpies(),
    };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });

    fireDue(Date.parse(RESET));
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("failed"),
    );
    expect(resumeRow(connection, "chat-thread", ids.thread)?.detail).toBe("A request is pending.");
  });

  it("stays armed on the retry cadence while the mode cannot dispatch yet", async () => {
    const connection = openConnection();
    const dispatch = vi
      .fn<UsageResumeModePort["dispatch"]>()
      .mockResolvedValueOnce({
        kind: "deferred",
        detail: "No local window is registered for this host.",
      })
      .mockResolvedValue({ kind: "dispatched" });
    const spies = { chat: portSpies({ dispatch }), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });

    fireDue(Date.parse(RESET));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    // Nothing settled: the durable opt-in stays armed for the retry cadence.
    expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("scheduled");
    expect(listPendingUsageResumes(connection)).toHaveLength(1);
    expect(timers.size).toBe(1);

    fireDue(nowMs + 30_000);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("dispatched"),
    );
  });

  it("keeps the opt-in armed when its settlement cannot commit", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: record() })],
    });
    const appendSpy = vi.spyOn(store, "append");
    appendSpy.mockImplementationOnce(() => {
      throw new Error("commit failed");
    });

    fireDue(Date.parse(RESET));
    await vi.waitFor(() => expect(spies.chat.dispatch).toHaveBeenCalledOnce());
    // The projection still says scheduled and the pending entry re-armed
    // instead of disappearing until the next restart.
    expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("scheduled");
    expect(listPendingUsageResumes(connection)).toHaveLength(1);
    expect(timers.size).toBe(1);

    fireDue(nowMs + 30_000);
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("dispatched"),
    );
  });

  it("waits out a reset further than a single timer can hold", async () => {
    const connection = openConnection();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { store } = serviceWith(connection, spies);
    seededChatThread(connection);
    const farReset = new Date(Date.parse(RESET) + 2_200_000_000).toISOString();
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [
        pending(USAGE_RESUME_SCHEDULED, {
          resume: record({
            resetsAt: farReset as UtcTimestamp,
            usageLimit: { kind: "exhausted", resetsAt: farReset as UtcTimestamp },
          }),
        }),
      ],
    });

    // The wait is armed in a bounded chunk rather than overflowing the timer.
    const first = [...timers.values()].at(0);
    expect(first?.at).toBeLessThan(Date.parse(farReset));

    fireDue(first?.at ?? 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(spies.chat.inspect).not.toHaveBeenCalled();
    expect(spies.chat.dispatch).not.toHaveBeenCalled();
    expect(timers.size).toBe(1);
    expect([...timers.values()].at(0)?.at).toBe(Date.parse(farReset));

    fireDue(Date.parse(farReset));
    await vi.waitFor(() => expect(spies.chat.dispatch).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("dispatched"),
    );
  });

  it("evaluates a resume whose reset passed while the host was away on start", async () => {
    const connection = openConnection();
    seededChatThread(connection);
    const store = journal(connection);
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [
        pending(USAGE_RESUME_SCHEDULED, {
          resume: record({
            resetsAt: PAST_RESET,
            usageLimit: { kind: "exhausted", resetsAt: PAST_RESET },
          }),
        }),
      ],
    });
    // The service opens after the append — the projection row is the only
    // evidence a pending resume ever armed.
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies() };
    const { service } = serviceWith(connection, spies);
    service.start();

    expect(timers.size).toBe(0);
    await vi.waitFor(() => expect(spies.chat.dispatch).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(resumeRow(connection, "chat-thread", ids.thread)?.status).toBe("dispatched"),
    );
  });

  function runRecord(overrides: Partial<UsageResumeRecord> = {}): UsageResumeRecord {
    const { attemptId: _attempts, ...rest } = record({
      threadId: ids.run,
      turnId: ids.run,
      ...overrides,
    });
    return rest;
  }

  function runStatusChanged(payload: Record<string, unknown>) {
    return pending("agent.run-status-changed@1", {
      runId: ids.run,
      fromStatus: "waiting",
      ...payload,
    });
  }

  function appendRunStatusChanged(
    store: ReturnType<typeof journal>,
    expectedVersion: number,
    payload: Record<string, unknown>,
  ) {
    store.append({
      aggregate: { aggregateType: "agent-run", aggregateId: ids.run },
      expectedVersion,
      events: [runStatusChanged(payload)],
    });
  }

  it("dispatches a limited child run's continuation when the reset arrives", async () => {
    const connection = openConnection();
    const agentRun = portSpies();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies(), agentRun };
    const { store } = serviceWith(connection, spies);
    store.append({
      aggregate: { aggregateType: "agent-run", aggregateId: ids.run },
      expectedVersion: 0,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: runRecord() })],
    });

    expect(listPendingUsageResumes(connection)).toHaveLength(1);
    fireDue(Date.parse(RESET));
    await vi.waitFor(() => expect(agentRun.dispatch).toHaveBeenCalledOnce());
    expect(agentRun.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ids.run, turnId: ids.run }),
    );
    await vi.waitFor(() =>
      expect(resumeRow(connection, "agent-run", ids.run)?.status).toBe("dispatched"),
    );
    expect(agentRun.settleApplied).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "dispatched" }),
      undefined,
    );
  });

  it("settles invalidated when a limited child run leaves its wait", async () => {
    const connection = openConnection();
    const agentRun = portSpies();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies(), agentRun };
    const { store } = serviceWith(connection, spies);
    store.append({
      aggregate: { aggregateType: "agent-run", aggregateId: ids.run },
      expectedVersion: 0,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: runRecord() })],
    });
    expect(listPendingUsageResumes(connection)).toHaveLength(1);

    // A cancelled child can never be resumed by the opt-in: the parent's
    // subtree withdrawal ends the pending recovery instead of waking an
    // orphan at the provider's reset.
    appendRunStatusChanged(store, 1, { toStatus: "cancelled", version: 2 });

    await vi.waitFor(() =>
      expect(resumeRow(connection, "agent-run", ids.run)?.status).toBe("invalidated"),
    );
    expect(listPendingUsageResumes(connection)).toHaveLength(0);
    expect(agentRun.dispatch).not.toHaveBeenCalled();
  });

  it("settles invalidated when the wait's declared reset fact changes", async () => {
    const connection = openConnection();
    const agentRun = portSpies();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies(), agentRun };
    const { store } = serviceWith(connection, spies);
    store.append({
      aggregate: { aggregateType: "agent-run", aggregateId: ids.run },
      expectedVersion: 0,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: runRecord() })],
    });

    appendRunStatusChanged(store, 1, {
      toStatus: "waiting",
      version: 2,
      usageLimit: { kind: "temporary", resetsAt: "2026-07-19T14:00:00.000Z" },
    });

    await vi.waitFor(() =>
      expect(resumeRow(connection, "agent-run", ids.run)?.status).toBe("invalidated"),
    );
    expect(agentRun.dispatch).not.toHaveBeenCalled();
  });

  it("stays armed while a child run keeps waiting on the same declared reset", async () => {
    const connection = openConnection();
    const agentRun = portSpies();
    const spies = { chat: portSpies(), work: portSpies(), code: portSpies(), agentRun };
    const { store } = serviceWith(connection, spies);
    store.append({
      aggregate: { aggregateType: "agent-run", aggregateId: ids.run },
      expectedVersion: 0,
      events: [pending(USAGE_RESUME_SCHEDULED, { resume: runRecord() })],
    });

    // The same wait renewing with the same declared reset is still the
    // opt-in the person armed — the record binds the reset fact, not the
    // wait's occurrence.
    appendRunStatusChanged(store, 1, {
      toStatus: "waiting",
      version: 2,
      usageLimit: { kind: "exhausted", resetsAt: RESET },
    });

    await Promise.resolve();
    expect(resumeRow(connection, "agent-run", ids.run)?.status).toBe("scheduled");
    expect(listPendingUsageResumes(connection)).toHaveLength(1);

    fireDue(Date.parse(RESET));
    await vi.waitFor(() => expect(agentRun.dispatch).toHaveBeenCalledOnce());
  });
});
