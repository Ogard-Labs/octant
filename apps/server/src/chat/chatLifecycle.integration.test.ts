import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeChatAttachmentId,
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeProviderObservedState,
  type AggregateVersion,
  type ChatSettings,
  type ChatThreadId,
  type ProviderProbeResult,
} from "@octant/contracts";
import { Effect, Queue, Stream } from "effect";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { afterEach, describe, expect, it } from "vitest";
import { ContextHarnessService } from "../context/contextHarnessService";
import { makeProviderCapacityScheduler } from "../context/contextRuntime";
import {
  CHAT_SETTINGS_AGGREGATE_ID,
  readChatContent,
  readChatSettings,
  readChatThread,
  readChatThreads,
  readChatThreadView,
  readPendingChatPurges,
  searchChatThreads,
} from "../persistence/chatProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import type { PersistenceService } from "../persistence/persistenceService";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ResearchRouter } from "./research/researchRouter";
import { ChatService } from "./chatService";
import { ThreadWorkService } from "./threadWorkService";

const directories: Array<string> = [];
const now = "2026-07-20T08:00:00.000Z";
const ids = {
  actor: "86000000-0000-4000-8000-000000000001",
  correlation: "86000000-0000-4000-8000-000000000002",
  providerA: "86000000-0000-4000-8000-000000000003",
  providerB: "86000000-0000-4000-8000-000000000004",
  attachment: "86000000-0000-4000-8000-000000000005",
  workItem: "86000000-0000-4000-8000-000000000006",
  settingsEvent: "86000000-0000-4000-8000-000000000007",
} as const;

type DriverBehavior = "checkpoint-disconnect" | "complete" | "pending";

interface SentTurn {
  readonly providerInstanceId: string;
  readonly attachmentIds: ReadonlyArray<string>;
  readonly toolNames: ReadonlyArray<string>;
}

interface LifecycleFixture {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly sentTurns: Array<SentTurn>;
  readonly interruptedSessions: Array<string>;
  persistence: PersistenceService;
  service: ChatService;
  contextHarness: ContextHarnessService;
  threadWork: ThreadWorkService;
  restart(): Promise<void>;
  close(): void;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function nextUuid() {
  let value = 100;
  return () => `86000000-0000-4000-8000-${(value++).toString(16).padStart(12, "0")}`;
}

function probe(
  instanceId: string,
  modelId: string,
  overrides: Partial<ProviderProbeResult> = {},
): ProviderProbeResult {
  return decodeProviderObservedState({
    instanceId: decodeProviderInstanceId(instanceId),
    readiness: "ready",
    processState: "running",
    models: [
      {
        id: modelId,
        displayName: modelId,
        contextLimit: 8_000,
        reasoning: "supported",
        inputModalities: ["text", "document"],
        options: [],
        source: "discovered",
        verification: "verified",
      },
    ],
    capabilities: {
      streaming: "supported",
      resume: "supported",
      interruption: "supported",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "supported",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "supported",
      diffs: "supported",
      taskProgress: "supported",
      nativeChildAgents: "supported",
      nativeAttachments: "supported",
      nativeWebResearch: "supported",
      appManagedTools: "supported",
      citations: "supported",
    },
    observedAt: now,
    ...overrides,
  });
}

function makeDriver(input: {
  readonly instanceId: string;
  readonly probe: ProviderProbeResult;
  readonly behaviors: Array<DriverBehavior>;
  readonly sentTurns: Array<SentTurn>;
  readonly interruptedSessions: Array<string>;
}): ProviderDriver {
  return {
    kind: "openai-compatible",
    probe: () => Effect.succeed(input.probe),
    acquire: () => {
      const behavior = input.behaviors.shift() ?? "complete";
      const queue = Effect.runSync(Queue.unbounded<never>());
      return Effect.succeed({
        subscribe: Effect.succeed(Stream.fromQueue(queue)),
        start: (startInput: { readonly sessionId: string }) =>
          Effect.succeed({ sessionId: startInput.sessionId }),
        send: (turn: {
          readonly sessionId: string;
          readonly attachments: ReadonlyArray<{ readonly attachmentId: string }>;
          readonly tools: ReadonlyArray<{ readonly name: string }>;
        }) =>
          Effect.gen(function* () {
            input.sentTurns.push({
              providerInstanceId: input.instanceId,
              attachmentIds: turn.attachments.map((attachment) => attachment.attachmentId),
              toolNames: turn.tools.map((tool) => tool.name),
            });
            yield* Queue.offer(queue, {
              kind: "text-delta",
              sessionId: turn.sessionId,
              text: behavior === "checkpoint-disconnect" ? "checkpoint" : "streaming",
            } as never);
            if (behavior === "pending") return;
            if (behavior === "checkpoint-disconnect") {
              yield* Queue.shutdown(queue);
              return;
            }
            yield* Queue.offer(queue, { kind: "completed", sessionId: turn.sessionId } as never);
          }),
        interrupt: (sessionId: string) =>
          Effect.sync(() => {
            input.interruptedSessions.push(sessionId);
          }),
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      });
    },
  } as unknown as ProviderDriver;
}

function makePersistence(databasePath: string): PersistenceService {
  const connection = openSqlite(databasePath);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  return {
    connection,
    journal,
    projections: runtime.projections,
    readShellSettings: () => undefined,
    readWindowWorkspace: () => undefined,
    readWindowWorkspaces: () => [],
    readProject: () => undefined,
    readProjects: () => [],
    searchProjects: () => [],
    readMemoryEntry: () => undefined,
    readProjectMemory: () => ({ active: [], history: [] }),
    readProviderInstance: () => undefined,
    readProviderInstances: () => [],
    readProviderDefaults: () => ({
      defaultProviderInstanceId: ids.providerA,
      version: 1 as AggregateVersion,
      updatedAt: now,
      permissionPersistence: { mode: "approval-gated" },
    }),
    readChatSettings: () => readChatSettings(connection),
    readChatThread: (threadId: ChatThreadId) => readChatThread(connection, threadId),
    readChatThreads: () => readChatThreads(connection),
    readChatThreadView: (threadId: ChatThreadId) => readChatThreadView(connection, threadId),
    readChatContent: (contentId: string) => readChatContent(connection, contentId),
    searchChatThreads: (query: string) => searchChatThreads(connection, query),
    readPendingChatPurges: () => readPendingChatPurges(connection),
    status: () => ({ state: "current", integrity: "ok" }),
  } as unknown as PersistenceService;
}

function seedSettings(persistence: PersistenceService): void {
  const settings = {
    defaultProviderInstanceId: ids.providerA,
    defaultModelId: "model-a",
    defaultResearchEnabled: false,
    defaultResearchRouting: "automatic",
    searxngBaseUrl: "https://search.example.test",
    defaultPersonalityInstructions: "Be calm.",
    version: 1 as AggregateVersion,
    updatedAt: now,
  } as ChatSettings;
  persistence.journal.append({
    aggregate: { aggregateType: "chat-settings", aggregateId: CHAT_SETTINGS_AGGREGATE_ID },
    expectedVersion: 0,
    events: [
      {
        eventId: ids.settingsEvent,
        eventName: "chat.settings-updated@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { kind: "settings-updated", settings },
      },
    ],
  });
}

function createFixture(behaviors?: {
  readonly providerA?: Array<DriverBehavior>;
  readonly providerB?: Array<DriverBehavior>;
  readonly providerBReadiness?: ProviderProbeResult["readiness"];
}): LifecycleFixture {
  const dataDirectory = mkdtempSync(join(tmpdir(), "octant-chat-lifecycle-"));
  directories.push(dataDirectory);
  const databasePath = join(dataDirectory, "events.sqlite3");
  const uuid = nextUuid();
  const sentTurns: SentTurn[] = [];
  const interruptedSessions: string[] = [];
  const providerA = makeDriver({
    instanceId: ids.providerA,
    probe: probe(ids.providerA, "model-a"),
    behaviors: [...(behaviors?.providerA ?? [])],
    sentTurns,
    interruptedSessions,
  });
  const providerB = makeDriver({
    instanceId: ids.providerB,
    probe: probe(ids.providerB, "model-b", {
      readiness: behaviors?.providerBReadiness ?? "ready",
      capabilities: {
        ...probe(ids.providerB, "model-b").capabilities,
        nativeAttachments: "unsupported",
      },
    }),
    behaviors: [...(behaviors?.providerB ?? [])],
    sentTurns,
    interruptedSessions,
  });
  const drivers = new Map<string, ProviderDriver>([
    [ids.providerA, providerA],
    [ids.providerB, providerB],
  ]);

  const createRuntime = (persistence: PersistenceService) => {
    const contextHarness = new ContextHarnessService({ persistence, uuid, clock: () => now });
    const threadWork = new ThreadWorkService({ persistence, uuid, clock: () => now });
    return {
      threadWork,
      contextHarness,
      service: new ChatService({
        persistence,
        dataDirectory,
        uuid,
        clock: () => now,
        threadWork,
        driver: (providerInstanceId) => {
          const driver = drivers.get(String(providerInstanceId));
          if (driver === undefined) throw new Error("Fixture provider is not registered.");
          return driver;
        },
        contextHarness,
        capacityScheduler: makeProviderCapacityScheduler({
          now: () => Date.parse(now),
          random: () => 0.5,
          maxRetryJitterMs: 0,
          ambiguousReservationTtlMs: 60_000,
        }),
        researchRouter: new ResearchRouter({
          searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
          providerNativeExecute: async () => ({
            query: "x",
            backend: "provider-native",
            results: [],
          }),
        }),
        turnTimeoutMs: 5_000,
      }),
    };
  };

  const persistence = makePersistence(databasePath);
  seedSettings(persistence);
  const runtime = createRuntime(persistence);
  const fixture: LifecycleFixture = {
    dataDirectory,
    databasePath,
    sentTurns,
    interruptedSessions,
    persistence,
    service: runtime.service,
    contextHarness: runtime.contextHarness,
    threadWork: runtime.threadWork,
    async restart() {
      fixture.persistence.connection.close();
      fixture.persistence = makePersistence(databasePath);
      const restarted = createRuntime(fixture.persistence);
      fixture.service = restarted.service;
      fixture.contextHarness = restarted.contextHarness;
      fixture.threadWork = restarted.threadWork;
      await fixture.service.recoverPendingDeletions();
    },
    close() {
      fixture.persistence.connection.close();
    },
  };
  return fixture;
}

async function until(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5_000) throw new Error("Timed out waiting for lifecycle state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function replayAll(service: ChatService, threadId: ChatThreadId) {
  const frames = [];
  for await (const frame of service.subscribe(threadId, 0)) frames.push(frame);
  return frames;
}

describe("Chat lifecycle integration", () => {
  it("retries with the original attempt provider after the thread selection changes", async () => {
    const fixture = createFixture({
      providerA: ["checkpoint-disconnect", "complete"],
      providerB: ["complete"],
    });
    const created = await fixture.service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retry",
    });
    if (created.kind !== "thread-created") throw new Error("Expected a created Chat thread.");
    await fixture.service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Fail on provider A",
    });
    const failed = fixture.service.read(created.thread.id);
    const turn = failed.turns[0]!;
    const attempt = turn.attempts[0]!;
    expect(attempt.outcome).toBe("interrupted");
    const handedOff = await fixture.service.execute({
      kind: "change-chat-provider",
      threadId: created.thread.id,
      expectedVersion: failed.thread.version,
      providerInstanceId: ids.providerB,
      modelId: "model-b",
    });
    if (handedOff.kind !== "thread-updated") throw new Error("Expected a provider handoff.");

    const retried = await fixture.service.execute({
      kind: "retry-chat-turn",
      threadId: created.thread.id,
      expectedVersion: handedOff.thread.version,
      turnId: turn.id,
      attemptId: attempt.id,
    });
    expect(retried).toMatchObject({
      kind: "attempt-updated",
      attempt: { providerInstanceId: ids.providerA, modelId: "model-a", outcome: "queued" },
    });
    expect(fixture.sentTurns.map((sent) => sent.providerInstanceId)).toEqual([
      ids.providerA,
      ids.providerA,
    ]);
    expect(fixture.service.read(created.thread.id).turns[0]?.attempts.at(-1)?.outcome).toBe(
      "completed",
    );
    fixture.close();
  });

  it("validates interrupt ownership before aborting another thread's attempt", async () => {
    const fixture = createFixture({ providerA: ["pending"] });
    const running = await fixture.service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Running",
    });
    if (running.kind !== "thread-created") throw new Error("Expected a created Chat thread.");
    const pendingSend = fixture.service.execute({
      kind: "send-chat-turn",
      threadId: running.thread.id,
      expectedVersion: running.thread.version,
      prompt: "Keep running",
    });
    await until(
      () => fixture.service.read(running.thread.id).turns[0]?.attempts[0]?.outcome === "streaming",
    );
    const runningView = fixture.service.read(running.thread.id);
    const runningTurn = runningView.turns[0]!;
    const runningAttempt = runningTurn.attempts[0]!;
    const other = await fixture.service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Other",
    });
    if (other.kind !== "thread-created") throw new Error("Expected a created Chat thread.");

    await expect(
      fixture.service.execute({
        kind: "interrupt-chat-turn",
        threadId: other.thread.id,
        expectedVersion: other.thread.version,
        turnId: crypto.randomUUID(),
        attemptId: runningAttempt.id,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortedWrongAttempt = fixture.interruptedSessions.includes(
      String(runningAttempt.providerSessionId),
    );
    const afterInvalid = fixture.service.read(running.thread.id).turns[0]?.attempts[0];
    if (afterInvalid?.outcome === "streaming") {
      await fixture.service.execute({
        kind: "interrupt-chat-turn",
        threadId: running.thread.id,
        expectedVersion: fixture.service.read(running.thread.id).thread.version,
        turnId: runningTurn.id,
        attemptId: runningAttempt.id,
      });
    }
    await pendingSend;
    expect(abortedWrongAttempt).toBe(false);
    fixture.close();
  });

  it("rejects a handoff to a target provider that is not ready", async () => {
    const fixture = createFixture({ providerBReadiness: "unavailable" });
    const created = await fixture.service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Readiness-gated handoff",
    });
    if (created.kind !== "thread-created") throw new Error("Expected a created Chat thread.");

    await expect(
      fixture.service.execute({
        kind: "change-chat-provider",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        providerInstanceId: ids.providerB,
        modelId: "model-b",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(fixture.service.read(created.thread.id).thread.providerInstanceId).toBe(ids.providerA);
    fixture.close();
  });

  it("persists a checkpointed disconnected turn for replay after restart", async () => {
    const fixture = createFixture({ providerA: ["checkpoint-disconnect"] });
    const created = await fixture.service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Restart-safe checkpoint",
    });
    if (created.kind !== "thread-created") throw new Error("Expected a created Chat thread.");

    await fixture.service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Keep the checkpoint.",
    });

    const beforeRestart = fixture.service.read(created.thread.id);
    expect(beforeRestart.turns[0]?.attempts[0]).toMatchObject({
      outcome: "interrupted",
      responseRefs: [expect.any(Object)],
    });
    expect(beforeRestart.contents.map((content) => content.body)).toContain("checkpoint");
    expect(
      (await replayAll(fixture.service, created.thread.id)).map((frame) => frame.event.kind),
    ).toEqual(expect.arrayContaining(["thread-created", "turn-created", "attempt-updated"]));

    await fixture.restart();
    const restarted = fixture.service.read(created.thread.id);
    expect(restarted).toMatchObject({
      turns: [{ attempts: [{ outcome: "interrupted" }] }],
    });
    expect(restarted.contents.map((content) => content.body)).toContain("checkpoint");
    expect((await replayAll(fixture.service, created.thread.id)).at(-1)?.sequence).toBe(
      restarted.lastSequence,
    );
    fixture.close();
  });

  it("cancels, validates handoff, omits unsupported historical attachments, and persists research and work state", async () => {
    const fixture = createFixture({
      providerA: ["complete", "pending"],
      providerB: ["complete", "complete"],
    });
    const created = await fixture.service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Handoff lifecycle",
    });
    if (created.kind !== "thread-created") throw new Error("Expected a created Chat thread.");

    const attachment = await fixture.service.uploadAttachment({
      threadId: created.thread.id,
      attachmentId: decodeChatAttachmentId(ids.attachment),
      displayName: "historical-note.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("kept locally"),
    });
    const afterUpload = fixture.service.read(created.thread.id);
    await fixture.service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: afterUpload.thread.version,
      prompt: "First provider turn.",
      attachmentIds: [attachment.id],
    });
    expect(fixture.service.read(created.thread.id).turns[0]?.attempts[0]?.outcome).toBe(
      "completed",
    );

    const beforeCancellation = fixture.service.read(created.thread.id);
    const pendingSend = fixture.service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: beforeCancellation.thread.version,
      prompt: "Cancel this turn.",
    });
    await until(
      () => fixture.service.read(created.thread.id).turns[1]?.attempts[0]?.outcome === "streaming",
    );
    const streaming = fixture.service.read(created.thread.id);
    const pendingTurn = streaming.turns[1]!;
    const pendingAttempt = pendingTurn.attempts[0]!;
    await fixture.service.execute({
      kind: "interrupt-chat-turn",
      threadId: created.thread.id,
      expectedVersion: streaming.thread.version,
      turnId: pendingTurn.id,
      attemptId: pendingAttempt.id,
    });
    await pendingSend;
    expect(fixture.service.read(created.thread.id).turns[1]?.attempts[0]?.outcome).toBe(
      "cancelled",
    );
    expect(fixture.interruptedSessions).toContain(String(pendingAttempt.providerSessionId));

    const beforeRejectedHandoff = fixture.service.read(created.thread.id);
    await expect(
      fixture.service.execute({
        kind: "change-chat-provider",
        threadId: created.thread.id,
        expectedVersion: beforeRejectedHandoff.thread.version,
        providerInstanceId: ids.providerB,
        modelId: "missing-model",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.service.read(created.thread.id).thread.providerInstanceId).toBe(ids.providerA);

    const beforeHandoff = fixture.service.read(created.thread.id);
    const handedOff = await fixture.service.execute({
      kind: "change-chat-provider",
      threadId: created.thread.id,
      expectedVersion: beforeHandoff.thread.version,
      providerInstanceId: ids.providerB,
      modelId: "model-b",
    });
    if (handedOff.kind !== "thread-updated") throw new Error("Expected a provider handoff update.");
    expect(handedOff).toMatchObject({
      thread: {
        handoffWarning: {
          targetProviderInstanceId: ids.providerB,
          targetModelId: "model-b",
          omittedAttachments: [
            {
              attachmentId: attachment.id,
              displayName: "historical-note.txt",
              mediaType: "text/plain",
              reason: "native-attachments-unsupported",
            },
          ],
        },
      },
    });

    const searxng = await fixture.service.execute({
      kind: "change-chat-research",
      threadId: created.thread.id,
      expectedVersion: handedOff.thread.version,
      researchEnabled: true,
      researchRouting: "searxng",
    });
    if (searxng.kind !== "thread-updated") throw new Error("Expected a research update.");
    await fixture.service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: searxng.thread.version,
      prompt: "Use configured search.",
    });
    const searxngTurn = fixture.sentTurns.at(-1);
    expect(searxngTurn).toMatchObject({
      providerInstanceId: ids.providerB,
      attachmentIds: [],
      toolNames: ["octant_web_research"],
    });
    expect(fixture.sentTurns[0]?.attachmentIds).toEqual([attachment.id]);
    expect(fixture.service.read(created.thread.id).attachments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: attachment.id })]),
    );
    const contextSnapshot = fixture.contextHarness.inspect(
      decodeContextSubjectRef({
        aggregateType: "chat-thread",
        aggregateId: String(created.thread.id),
      }),
    );
    expect(contextSnapshot.next.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: { kind: "file", referenceId: String(attachment.id) },
          label: "historical-note.txt",
          state: "omitted",
          includedSize: 0,
        }),
      ]),
    );
    const omittedAttachment = contextSnapshot.next.manifest.entries.find(
      (entry) => entry.source.kind === "file" && entry.source.referenceId === String(attachment.id),
    );
    expect(contextSnapshot.next.plan.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: omittedAttachment?.id,
          state: "omitted",
          reason: "ineligible",
        }),
      ]),
    );

    const beforeNativeResearch = fixture.service.read(created.thread.id);
    const nativeResearch = await fixture.service.execute({
      kind: "change-chat-research",
      threadId: created.thread.id,
      expectedVersion: beforeNativeResearch.thread.version,
      researchEnabled: true,
      researchRouting: "provider-native",
    });
    if (nativeResearch.kind !== "thread-updated") throw new Error("Expected a research update.");
    await fixture.service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: nativeResearch.thread.version,
      prompt: "Use native research.",
    });
    expect(fixture.sentTurns.at(-1)).toMatchObject({
      providerInstanceId: ids.providerB,
      toolNames: [],
    });

    await fixture.service.execute({
      kind: "add-chat-work-item",
      threadId: created.thread.id,
      expectedVersion: 0 as AggregateVersion,
      itemId: ids.workItem,
      title: "Review the handoff",
      status: "pending",
      position: 0,
      origin: "user",
    });
    await fixture.service.execute({
      kind: "open-chat-follow-up",
      threadId: created.thread.id,
      expectedVersion: 0 as AggregateVersion,
      triggerSequence: 9,
      reason: "Review the handoff",
      origin: "manual",
    });

    await fixture.restart();
    const restarted = fixture.service.read(created.thread.id);
    expect(restarted).toMatchObject({
      thread: {
        handoffWarning: {
          omittedAttachments: [expect.objectContaining({ attachmentId: attachment.id })],
        },
      },
    });
    expect(restarted.workItems).toEqual([
      expect.objectContaining({ id: ids.workItem, title: "Review the handoff" }),
    ]);
    expect(restarted.followUp).toMatchObject({ state: "open", reason: "Review the handoff" });
    const archived = await fixture.service.execute({
      kind: "change-chat-thread-lifecycle",
      threadId: created.thread.id,
      expectedVersion: restarted.thread.version,
      lifecycle: "archived",
    });
    expect(archived).toMatchObject({ kind: "thread-updated", thread: { lifecycle: "archived" } });
    fixture.close();
  });

  it("resumes an interrupted purge after restart and leaves deleted content absent", async () => {
    const fixture = createFixture({ providerA: ["complete"] });
    const created = await fixture.service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Purge lifecycle",
    });
    if (created.kind !== "thread-created") throw new Error("Expected a created Chat thread.");
    await fixture.service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Delete this content.",
    });
    const view = fixture.service.read(created.thread.id);
    const contentIds = view.contents.map((content) => content.contentId);
    expect(contentIds).not.toHaveLength(0);

    fixture.persistence.connection.exec(`
      CREATE TRIGGER fail_deleted_lifecycle_event
      BEFORE INSERT ON event_journal
      WHEN NEW.event_name = 'chat.deleted@1'
      BEGIN
        SELECT RAISE(ABORT, 'deterministic purge interruption');
      END;
    `);
    await expect(
      fixture.service.execute({
        kind: "delete-chat-thread",
        threadId: created.thread.id,
        expectedVersion: view.thread.version,
      }),
    ).rejects.toThrow();
    expect(fixture.persistence.readChatThread(created.thread.id)?.lifecycle).toBe("deleting");
    expect(fixture.persistence.readPendingChatPurges()).toHaveLength(1);
    fixture.persistence.connection.exec("DROP TRIGGER fail_deleted_lifecycle_event");

    await fixture.restart();
    expect(fixture.persistence.readChatThread(created.thread.id)?.lifecycle).toBe("deleted");
    await expect(
      fixture.service.bootstrap().then((bootstrap) => bootstrap.threads),
    ).resolves.toEqual([]);
    for (const contentId of contentIds) {
      expect(fixture.persistence.readChatContent(String(contentId))).toBeUndefined();
    }
    try {
      fixture.service.read(created.thread.id);
      expect.unreachable("Deleted thread must not be readable.");
    } catch (error) {
      expect(error).toMatchObject({ failure: { category: "invalid" } });
    }
    fixture.close();
  });
});
