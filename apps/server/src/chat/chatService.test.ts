import { mkdtempSync, rmSync, accessSync, constants, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeChatAttachmentId,
  decodeChatAttempt,
  decodeChatAttemptId,
  decodeChatContentId,
  decodeChatTurnId,
  decodeContextManifestId,
  decodeContextEntry,
  decodeContextPlan,
  decodeContextSubjectRef,
  decodeContextSummaryId,
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeProviderObservedState,
  decodeProviderServiceLimits,
  type AggregateVersion,
  type CapacityReservationId,
  type ChatSettings,
  type ChatThreadId,
  type ContextInspectorSnapshot,
  type ContextSummaryId,
  type GlobalSequence,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderProbeResult,
  type ProviderContextBlock,
  type MentionableThreadId,
  type WindowId,
  type ChatThread,
} from "@octant/contracts";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  decodeContentSha256,
  decodePreviewContextSelectionId,
  decodePreviewTargetId,
} from "@octant/contracts/previews";
import { decodeCanvasContextSelectionId } from "@octant/contracts/canvasContext";
import { decodeCanvasId, decodeCanvasVersionId } from "@octant/contracts/canvas";
import type { HostId } from "@octant/contracts/host";
import type {
  MultiModelPool,
  MultiModelPoolCandidate,
  MultiModelRoutingVendorId,
} from "@octant/contracts/multi-model-pool";
import type { MultiModelCandidateRuntimeFacts } from "@octant/domain/multi-model-pool-policy";
import { Effect, Queue, Stream } from "effect";
import { activeChatTurns, defaultShellSettings } from "@octant/domain";
import type { ProviderAcquireInput, ProviderDriver } from "@octant/provider-sdk/driver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextHarnessService } from "../context/contextHarnessService";
import { makeProviderCapacityScheduler } from "../context/contextRuntime";
import type { ProviderCapacityScheduler } from "../context/providerCapacityScheduler";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { readDiagnosticsFailureIncident } from "../persistence/diagnosticsExportProjection";
import {
  CHAT_SETTINGS_AGGREGATE_ID,
  readChatContent,
  readChatSettings,
  readChatThreadView,
  readPendingChatPurges,
  searchChatThreads,
} from "../persistence/chatProjection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type { PersistenceService } from "../persistence/persistenceService";
import { ExtensionActivationService } from "../extensions/extensionActivationService";
import {
  createExtensionChatResolver,
  createStoredExtensionMaterialLoader,
  UNAVAILABLE_EXTENSION_TOOL_EXECUTION,
} from "../extensions/extensionChatResolver";
import { makeOpenAiCompatibleDriver } from "../providers/openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { ResearchRouter } from "./research/researchRouter";
import { ThreadWorkService } from "./threadWorkService";
import { ChatService, ChatServiceError } from "./chatService";

const directories: Array<string> = [];
const now = "2026-07-19T22:10:00.000Z";
const ids = {
  actor: "84000000-0000-4000-8000-000000000001",
  correlation: "84000000-0000-4000-8000-000000000002",
  provider: "84000000-0000-4000-8000-000000000003",
  project: "84000000-0000-4000-8000-000000000004",
  attachment: "84000000-0000-4000-8000-000000000005",
  memory: "84000000-0000-4000-8000-000000000006",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function settings(): ChatSettings {
  return {
    defaultProviderInstanceId: ids.provider,
    defaultModelId: "model-a",
    defaultResearchEnabled: true,
    defaultResearchRouting: "automatic",
    searxngBaseUrl: "https://search.example.test",
    defaultPersonalityInstructions: "Be calm.",
    version: 1 as AggregateVersion,
    updatedAt: now,
  } as ChatSettings;
}

function probeFixture(overrides?: Partial<ProviderProbeResult>): ProviderProbeResult {
  return decodeProviderObservedState({
    instanceId: decodeProviderInstanceId(ids.provider),
    readiness: "ready",
    processState: "running",
    models: [
      {
        id: "model-a",
        displayName: "Model A",
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

function withProbe(
  driver: ProviderDriver,
  probeResult: ProviderProbeResult,
  probeFor?: (providerInstanceId: string) => ProviderProbeResult | undefined,
): ProviderDriver {
  return {
    ...driver,
    probe:
      driver.probe ??
      ((input) => Effect.succeed(probeFor?.(String(input.instanceId)) ?? probeResult) as never),
  };
}

function openFixture(options?: {
  readonly driver?: ProviderDriver;
  /** Reports distinct provider facts per instance, for cross-provider routing. */
  readonly probeFor?: (providerInstanceId: string) => ProviderProbeResult | undefined;
  /** Refuses to construct a driver for an instance, as an unusable configuration does. */
  readonly refuseDriverFor?: (providerInstanceId: string) => Error | undefined;
  readonly settings?: ChatSettings;
  readonly probe?: ProviderProbeResult;
  readonly contextFacts?: ProviderDriver["contextFacts"];
  readonly seedSettings?: boolean;
  readonly providerEnabled?: boolean;
  readonly agentEligibleDefaults?: ReadonlyArray<{
    readonly providerInstanceId: string;
    readonly modelId: string;
  }>;
  readonly chatEnabled?: { current: boolean };
  readonly hiddenThreadIds?: () => ReadonlySet<string>;
  readonly resolveSideChatSourceContext?: (input: {
    readonly sidecarThreadId: ChatThreadId;
    readonly windowId?: WindowId;
  }) => Promise<import("./chatService").SideChatSourceContext | undefined>;
  readonly resolveThreadMentionContext?: (input: {
    readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
    readonly windowId?: WindowId;
  }) => Promise<ReadonlyArray<import("./chatService").ChatThreadMentionContext>>;
  readonly turnOutcome?: "completed" | "waiting" | "interrupted";
  readonly providerNativeExecute?: (
    input: import("./research/researchRouter").ResearchExecuteInput,
  ) => Promise<import("./research/researchRouter").ProviderNativeResearchResultSet>;
  readonly resolveAppManagedTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: ChatThread;
  }) =>
    | {
        readonly definitions: ReadonlyArray<{
          readonly name: string;
          readonly inputSchema: Record<string, unknown>;
        }>;
        readonly execute: () => Promise<{ readonly result: unknown }>;
      }
    | undefined;
  readonly resolveExtensionSelectionContext?: (input: {
    readonly phase: "send" | "replay" | "resume" | "provider-handoff";
    readonly thread: ChatThread;
    readonly selections: ReadonlyArray<import("@octant/contracts/extensions").ExtensionSelection>;
  }) => Promise<{
    readonly selections: ReadonlyArray<import("@octant/contracts/extensions").ExtensionSelection>;
    readonly entries: ReadonlyArray<{
      readonly contextEntry: ReturnType<typeof decodeContextEntry>;
      readonly providerContext?: ProviderContextBlock;
    }>;
    readonly toolSet?: {
      readonly definitions: ReadonlyArray<{
        readonly name: string;
        readonly inputSchema: Record<string, unknown>;
      }>;
      readonly execute: (input: {
        readonly name: string;
        readonly inputJson: string;
        readonly signal?: AbortSignal;
      }) => Promise<{ readonly result: unknown; readonly isError?: boolean }>;
    };
  }>;
  readonly gatherMultiModelRuntimeFacts?: (input: {
    readonly pool: import("@octant/contracts/multi-model-pool").MultiModelPool;
    readonly mode: import("@octant/contracts/modes").OctantMode;
    readonly activeHostId: import("@octant/contracts/host").HostId;
  }) => Promise<
    ReadonlyArray<import("@octant/domain/multi-model-pool-policy").MultiModelCandidateRuntimeFacts>
  >;
  readonly contextMaintenanceTimeoutMs?: number;
  readonly contextMaintenanceShutdownTimeoutMs?: number;
}): {
  readonly dataDirectory: string;
  readonly persistence: PersistenceService;
  readonly service: ChatService;
  readonly contextHarness: ContextHarnessService;
  readonly capacityScheduler: ProviderCapacityScheduler;
  readonly threadReservationIds: ReadonlyArray<string>;
  readonly fakeDriver: {
    readonly acquireInputs: ProviderAcquireInput[];
    readonly startedSessionIds: string[];
    readonly startInputs: Array<{
      readonly sessionId: string;
      readonly modelId: string;
      readonly modelOptionValues?: Readonly<Record<string, string>>;
    }>;
    readonly resumeInputs: Array<{
      readonly sessionId: string;
      readonly resumeCursor: { readonly driverKind: string; readonly value: string };
    }>;
    readonly sentTurns: Array<{
      readonly sessionId: string;
      readonly prompt: string;
      readonly context?: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
      readonly attachments: ReadonlyArray<{
        readonly bytes: Uint8Array;
        readonly displayName: string;
      }>;
      readonly tools: ReadonlyArray<{ readonly name: string }>;
    }>;
    readonly driver: ProviderDriver;
    readonly queue: Queue.Queue<never>;
  };
} {
  const dataDirectory = mkdtempSync(join(tmpdir(), "octant-chat-service-"));
  directories.push(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const persistence = {
    connection,
    journal,
    projections: runtime.projections,
    readShellSettings: () =>
      options?.chatEnabled === undefined
        ? undefined
        : {
            settings: { ...defaultShellSettings(), chatEnabled: options.chatEnabled.current },
            aggregateVersion: 1,
          },
    readWindowWorkspace: () => undefined,
    readWindowWorkspaces: () => [],
    readProject: (projectId: string) =>
      String(projectId) === ids.project
        ? {
            id: ids.project,
            type: "chat",
            title: "Memory project",
            lifecycle: "active",
            rank: "a0",
            version: 1,
            createdAt: now,
            updatedAt: now,
          }
        : undefined,
    readProjects: () => [],
    searchProjects: () => [],
    readMemoryEntry: () => undefined,
    readProjectMemory: (projectId: string) =>
      String(projectId) === ids.project
        ? {
            active: [
              {
                id: ids.memory,
                projectId: ids.project,
                kind: "fact",
                content: "Remember the launch date.",
                provenance: { kind: "user-authored" },
                author: { kind: "local-user", actorId: ids.actor },
                status: "active",
                version: 1,
                createdAt: now,
                updatedAt: now,
              },
            ],
            history: [],
          }
        : { active: [], history: [] },
    readProviderInstance: () => ({
      id: decodeProviderInstanceId(ids.provider),
      displayName: "Fixture provider",
      driverKind: "openai-compatible",
      enabled: options?.providerEnabled ?? true,
      configuration: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    readProviderInstances: () => [],
    readProviderDefaults: () => ({
      defaultProviderInstanceId: ids.provider,
      version: 1 as AggregateVersion,
      updatedAt: now,
      permissionPersistence: { mode: "approval-gated" },
      ...(options?.agentEligibleDefaults === undefined
        ? {}
        : { agentEligibleModels: options.agentEligibleDefaults }),
    }),
    readChatSettings: () => readChatSettings(connection),
    readChatThread: (threadId: ChatThreadId) => readChatThreadView(connection, threadId)?.thread,
    readChatThreads: () => {
      const rows = connection
        .prepare(
          "SELECT thread_json FROM chat_thread_projection WHERE lifecycle != 'deleted' ORDER BY updated_at DESC",
        )
        .all() as Array<{ readonly thread_json: string }>;
      return rows.map((row) => JSON.parse(row.thread_json));
    },
    readChatThreadView: (threadId: ChatThreadId) => readChatThreadView(connection, threadId),
    readChatContent: (contentId: string) => readChatContent(connection, contentId),
    searchChatThreads: (query: string) => searchChatThreads(connection, query),
    readPendingChatPurges: () => readPendingChatPurges(connection),
    status: () => ({ state: "current", integrity: "ok" }),
  } as unknown as PersistenceService;

  if (options?.seedSettings !== false) {
    journal.append({
      aggregate: { aggregateType: "chat-settings", aggregateId: CHAT_SETTINGS_AGGREGATE_ID },
      expectedVersion: 0,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName: "chat.settings-updated@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: { kind: "settings-updated", settings: options?.settings ?? settings() },
        },
      ],
    });
  }

  const acquireInputs: ProviderAcquireInput[] = [];
  const startedSessionIds: string[] = [];
  const startInputs: Array<{
    readonly sessionId: string;
    readonly modelId: string;
    readonly modelOptionValues?: Readonly<Record<string, string>>;
  }> = [];
  const resumeInputs: Array<{
    readonly sessionId: string;
    readonly resumeCursor: { readonly driverKind: string; readonly value: string };
  }> = [];
  const sentTurns: Array<{
    readonly sessionId: string;
    readonly prompt: string;
    readonly context?: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
    readonly attachments: ReadonlyArray<{
      readonly bytes: Uint8Array;
      readonly displayName: string;
    }>;
    readonly tools: ReadonlyArray<{ readonly name: string }>;
  }> = [];
  const queue = Effect.runSync(Queue.unbounded<never>());
  const connectionDriver = {
    events: Stream.fromQueue(queue),
    start: (input: {
      readonly sessionId: string;
      readonly modelId: string;
      readonly modelOptionValues?: Readonly<Record<string, string>>;
    }) =>
      Effect.sync(() => {
        startedSessionIds.push(input.sessionId);
        startInputs.push(input);
        return {
          sessionId: input.sessionId,
          resumeCursor: {
            driverKind: "openai-compatible" as const,
            value: `session-${input.sessionId}`,
          },
        };
      }),
    resume: (input: {
      readonly sessionId: string;
      readonly resumeCursor: { readonly driverKind: string; readonly value: string };
    }) =>
      Effect.sync(() => {
        resumeInputs.push(input);
        // Real drivers (Codex/Claude) only re-establish the session and return
        // a handle; they emit no terminal events from resume alone. Events come
        // from send.
        return { sessionId: input.sessionId, resumeCursor: input.resumeCursor };
      }),
    send: (input: {
      readonly sessionId: string;
      readonly prompt: string;
      readonly context?: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
      readonly attachments: ReadonlyArray<{
        readonly bytes: Uint8Array;
        readonly displayName: string;
      }>;
      readonly tools: ReadonlyArray<{ readonly name: string }>;
    }) =>
      Effect.gen(function* () {
        sentTurns.push(input);
        const outcome = options?.turnOutcome ?? "completed";
        if (outcome === "waiting") {
          yield* Queue.offer(queue, { kind: "waiting", sessionId: input.sessionId } as never);
          return;
        }
        if (outcome === "interrupted") {
          yield* Queue.offer(queue, {
            kind: "interrupted",
            sessionId: input.sessionId,
            message: "checkpoint",
          } as never);
          return;
        }
        yield* Queue.offer(queue, {
          kind: "text-delta",
          sessionId: input.sessionId,
          text: "Fixture response",
        } as never);
        yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
      }),
    interrupt: () => Effect.void,
    stop: () => Effect.void,
    answerApproval: () => Effect.void,
    answerUserInput: () => Effect.void,
    answerTool: () => Effect.void,
  };
  const probe = options?.probe ?? probeFixture();
  const driver = withProbe(
    options?.driver ??
      ({
        acquire: (input: ProviderAcquireInput) => {
          acquireInputs.push(input);
          return Effect.succeed(connectionDriver);
        },
        ...(options?.contextFacts === undefined ? {} : { contextFacts: options.contextFacts }),
      } as unknown as ProviderDriver),
    probe,
    options?.probeFor,
  );

  const contextHarness = new ContextHarnessService({
    persistence,
    uuid: () => crypto.randomUUID(),
    clock: () => now,
  });
  const capacityScheduler = makeProviderCapacityScheduler({
    now: () => Date.parse(now),
    random: () => 0.5,
    maxRetryJitterMs: 0,
    ambiguousReservationTtlMs: 60_000,
  });
  const threadReservationIds: string[] = [];
  const submitCapacity = capacityScheduler.submit.bind(capacityScheduler);
  capacityScheduler.submit = (request) => {
    if (request.origin === "thread") threadReservationIds.push(String(request.reservationId));
    return submitCapacity(request);
  };
  const researchRouter = new ResearchRouter({
    searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
    ...(options?.providerNativeExecute === undefined
      ? {}
      : { providerNativeExecute: options.providerNativeExecute }),
  });
  const threadWork = new ThreadWorkService({
    persistence,
    uuid: () => crypto.randomUUID(),
    clock: () => now,
  });

  const service = new ChatService({
    persistence,
    dataDirectory,
    uuid: () => crypto.randomUUID(),
    clock: () => now,
    driver: (providerInstanceId) => {
      const refusal = options?.refuseDriverFor?.(String(providerInstanceId));
      if (refusal !== undefined) throw refusal;
      return driver;
    },
    contextHarness,
    capacityScheduler,
    researchRouter,
    threadWork,
    turnTimeoutMs: 5_000,
    ...(options?.contextMaintenanceTimeoutMs === undefined
      ? {}
      : { contextMaintenanceTimeoutMs: options.contextMaintenanceTimeoutMs }),
    ...(options?.contextMaintenanceShutdownTimeoutMs === undefined
      ? {}
      : { contextMaintenanceShutdownTimeoutMs: options.contextMaintenanceShutdownTimeoutMs }),
    ...(options?.hiddenThreadIds === undefined ? {} : { hiddenThreadIds: options.hiddenThreadIds }),
    ...(options?.resolveSideChatSourceContext === undefined
      ? {}
      : { resolveSideChatSourceContext: options.resolveSideChatSourceContext }),
    ...(options?.resolveThreadMentionContext === undefined
      ? {}
      : { resolveThreadMentionContext: options.resolveThreadMentionContext }),
    ...(options?.resolveAppManagedTools === undefined
      ? {}
      : { resolveAppManagedTools: options.resolveAppManagedTools }),
    ...(options?.resolveExtensionSelectionContext === undefined
      ? {}
      : { resolveExtensionSelectionContext: options.resolveExtensionSelectionContext }),
    ...(options?.gatherMultiModelRuntimeFacts === undefined
      ? {}
      : { gatherMultiModelRuntimeFacts: options.gatherMultiModelRuntimeFacts }),
  });

  return {
    dataDirectory,
    persistence,
    service,
    contextHarness,
    capacityScheduler,
    threadReservationIds,
    fakeDriver: {
      acquireInputs,
      startedSessionIds,
      startInputs,
      resumeInputs,
      sentTurns,
      driver,
      queue,
    },
  };
}

async function until(
  predicate: () => boolean,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * The turn runner releases its provider slot in a scope finalizer that runs
 * after the attempt is persisted. Wait for the latest thread reservation to
 * reach a terminal state instead of sleeping before the next send asks the
 * scheduler for capacity.
 */
async function untilThreadSlotReleased(fixture: {
  readonly capacityScheduler: ProviderCapacityScheduler;
  readonly threadReservationIds: ReadonlyArray<string>;
}): Promise<void> {
  const reservationId = fixture.threadReservationIds.at(-1);
  if (reservationId === undefined) throw new Error("No thread reservation was submitted.");
  await until(() => {
    const reservation = fixture.capacityScheduler.getReservation(
      reservationId as CapacityReservationId,
    );
    return (
      reservation === undefined ||
      reservation.state === "released" ||
      reservation.state === "reconciled"
    );
  });
}

interface SentTurn {
  readonly prompt: string;
  readonly context?: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
}

/** The fixed opening of the maintenance instruction the summary generator sends. */
const MAINTENANCE_PROMPT_PREFIX = "Summarize the conversation excerpts";

/**
 * A driver for the compaction tests: it reports usage on every turn, so each
 * finished turn reconciles its capacity reservation and the maintenance request
 * that follows can be admitted instead of queueing behind an unreconciled slot.
 * Each acquire owns its event queue, the way a real connection does.
 *
 * A maintenance request is answered with a summary that names the turns its
 * excerpts came from, so a test can tell which conversation a reused summary
 * would restate — an ordinary reply could not be told apart from a live turn.
 * Each ordinary reply is numbered for the same reason: two identical replies
 * cannot be told apart in a request that carries one of them.
 */
function compactionDriver(
  sent: Array<SentTurn>,
  options?: {
    readonly wedgeMaintenanceSend?: boolean;
    readonly wedgeMaintenanceStop?: boolean;
    /**
     * What the provider reports the summary cost, which is what the harness
     * plans the summary at. A summary the provider reports as nearly as large
     * as the material it replaced is what makes the replan drop it again.
     */
    readonly maintenanceOutputTokens?: number;
  },
): ProviderDriver {
  let replies = 0;
  return {
    acquire: () =>
      Effect.sync(() => {
        const queue = Effect.runSync(Queue.unbounded<never>());
        let maintenanceSession: string | undefined;
        return {
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: {
            readonly sessionId: string;
            readonly prompt: string;
            readonly context?: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
          }) =>
            Effect.suspend(() => {
              sent.push({
                prompt: input.prompt,
                ...(input.context ? { context: input.context } : {}),
              });
              const maintenance = input.prompt.startsWith(MAINTENANCE_PROMPT_PREFIX);
              if (maintenance) maintenanceSession = input.sessionId;
              if (maintenance && options?.wedgeMaintenanceSend === true) return Effect.never;
              if (!maintenance) replies += 1;
              const reply = `Fixture response ${replies}`;
              return Effect.gen(function* () {
                yield* Queue.offer(queue, {
                  kind: "text-delta",
                  sessionId: input.sessionId,
                  text: maintenance ? compactedSummaryText(input.prompt) : reply,
                } as never);
                yield* Queue.offer(queue, {
                  kind: "usage",
                  sessionId: input.sessionId,
                  inputTokens: 10,
                  outputTokens:
                    maintenance && options?.maintenanceOutputTokens !== undefined
                      ? options.maintenanceOutputTokens
                      : 5,
                } as never);
                yield* Queue.offer(queue, {
                  kind: "completed",
                  sessionId: input.sessionId,
                } as never);
              });
            }),
          interrupt: () => Effect.void,
          stop: (session: string) =>
            Effect.suspend(() =>
              options?.wedgeMaintenanceStop === true && session === maintenanceSession
                ? Effect.never
                : Effect.void,
            ),
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        };
      }),
  } as unknown as ProviderDriver;
}

/**
 * A driver whose first reply writes text and then fails, and which answers
 * every later send normally.
 *
 * It reproduces the turn a thread must not brief itself on: the fragment stays
 * journaled against a `failed` attempt, so a retry leaves the turn holding both
 * the abandoned text and the real answer. Maintenance requests are answered the
 * way `compactionDriver` answers them, so a plan that compacts under budget
 * pressure can be told apart from one that did not need to.
 */
function abandonedReplyDriver(
  sent: Array<SentTurn>,
  texts: { readonly abandoned: string; readonly answer: string },
): ProviderDriver {
  let sends = 0;
  return {
    acquire: () =>
      Effect.sync(() => {
        const queue = Effect.runSync(Queue.unbounded<never>());
        return {
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: {
            readonly sessionId: string;
            readonly prompt: string;
            readonly context?: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
          }) =>
            Effect.gen(function* () {
              sent.push({
                prompt: input.prompt,
                ...(input.context ? { context: input.context } : {}),
              });
              sends += 1;
              const emit = (event: Record<string, unknown>) =>
                Queue.offer(queue, { sessionId: input.sessionId, ...event } as never);
              if (sends === 1) {
                yield* emit({ kind: "text-delta", text: texts.abandoned });
                yield* emit({ kind: "usage", inputTokens: 10, outputTokens: 5 });
                yield* emit({
                  kind: "failed",
                  failure: { category: "provider-failed", message: "boom" },
                });
                return;
              }
              yield* emit({
                kind: "text-delta",
                text: input.prompt.startsWith(MAINTENANCE_PROMPT_PREFIX)
                  ? compactedSummaryText(input.prompt)
                  : texts.answer,
              });
              yield* emit({ kind: "usage", inputTokens: 10, outputTokens: 5 });
              yield* emit({ kind: "completed" });
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        };
      }),
  } as unknown as ProviderDriver;
}

/**
 * The conversation a snapshot's plan says its turn sends, keyed by the opening
 * of the material — which is exactly how the manifest labels an entry.
 *
 * The plan is this turn's durable record of the request, so a block with no
 * kept entry behind it, or a kept entry with no block, is the journal
 * describing a request that was never made. A summary entry is keyed by the
 * text it carries rather than its fixed label, because the text is what the
 * provider receives. These fixtures carry no workspace context that renders as
 * a message, so conversation entries account for every message block sent.
 */
function plannedConversationKeys(
  snapshot: ContextInspectorSnapshot,
  summaryContent: (summaryId: ContextSummaryId) => string | undefined,
): ReadonlyArray<string> {
  const entryById = new Map(
    snapshot.next.manifest.entries.map((entry) => [String(entry.id), entry]),
  );
  return snapshot.next.plan.entries
    .flatMap((planEntry) => {
      const entry = entryById.get(String(planEntry.entryId));
      if (entry === undefined || entry.category !== "conversation") return [];
      if (planEntry.state !== "included" && planEntry.state !== "cached") return [];
      const text =
        entry.source.kind === "summary"
          ? summaryContent(decodeContextSummaryId(entry.source.referenceId))
          : entry.label;
      return text === undefined ? [] : [conversationKey(text)];
    })
    .toSorted();
}

function dispatchedConversationKeys(
  context: ReadonlyArray<{ readonly kind: string; readonly text: string }> | undefined,
): ReadonlyArray<string> {
  return (context ?? [])
    .filter(
      (block) =>
        block.kind === "user-message" ||
        block.kind === "assistant-message" ||
        block.kind === "conversation-summary",
    )
    .map((block) => conversationKey(block.text))
    .toSorted();
}

/** A context entry's label is the first 64 characters of its material. */
function conversationKey(text: string): string {
  return text.slice(0, 64).trim();
}

function compactedSummaryText(prompt: string): string {
  const labels = [
    ...new Set([...prompt.matchAll(/Turn (\d+):/g)].map((match) => `Turn ${match[1]}`)),
  ];
  return `Compacted: ${labels.join(", ")}`;
}

/** Context facts small enough that a few long turns no longer fit one request. */
function compactionContextFacts(probe: ProviderProbeResult): ProviderDriver["contextFacts"] {
  return {
    observeModelLimits: () =>
      Effect.succeed([
        {
          providerInstanceId: probe.instanceId,
          modelId: probe.models[0]!.id,
          contextWindow: 1_200,
          reasoning: "included",
          source: "runtime-reported",
          confidence: "high",
          observedAt: probe.observedAt,
        },
      ]),
    observeServiceLimits: () =>
      Effect.succeed(
        decodeProviderServiceLimits({
          providerInstanceId: probe.instanceId,
          scope: "provider-instance",
          requests: { status: "unavailable" },
          tokens: { status: "unavailable" },
          concurrency: { status: "unavailable" },
          retry: { status: "inactive" },
          quota: "unknown",
          source: "runtime-reported",
          confidence: "medium",
          updatedAt: probe.observedAt,
        }),
      ),
  } as unknown as ProviderDriver["contextFacts"];
}

function countRows(
  connection: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  sql: string,
  ...args: unknown[]
): number {
  const row = connection.prepare(sql).get(...args) as { readonly count: number } | undefined;
  return row?.count ?? 0;
}

function authoritativeExtensionSnapshot(
  componentDesired = true,
  componentKind: "skill-instructions" | "mcp-tool" = "skill-instructions",
): ExtensionSnapshot {
  return {
    sequence: 12,
    snapshotAt: now,
    packages: [
      {
        extensionId: "30000000-0000-4000-8000-000000000001",
        packageId: "31000000-0000-4000-8000-000000000001",
        slug: "generic-build",
        displayName: "Generic build",
        stateVersion: 4,
        version: "1.2.3",
        digest: `sha256:${"a".repeat(64)}`,
        source: { kind: "catalog", catalogId: "octant", entryId: "generic-build" },
        compatibility: {
          platforms: ["macos"],
          modes: ["chat"],
          providerFamilies: ["openai-compatible"],
        },
        activation: extensionActivation(false),
        components: [
          {
            component: {
              id: componentKind === "skill-instructions" ? "instructions" : "execute",
              kind: componentKind,
              displayName: "Generic build guidance",
              declaredCapabilities:
                componentKind === "skill-instructions" ? ["instructions"] : ["mcp"],
              ...(componentKind === "skill-instructions"
                ? { contentReference: "content:instructions" }
                : {}),
            },
            activation: extensionActivation(componentDesired),
            effectiveState: componentDesired
              ? { kind: "effective" }
              : { kind: "blocked", reason: "component-disabled" },
          },
        ],
        diagnostics: [],
      },
    ],
    skills: [],
    collisions: [],
  } as never;
}

function extensionActivation(componentDesired: boolean) {
  return {
    installed: true,
    trusted: true,
    pluginDesired: true,
    componentDesired,
    compatible: true,
    policyAllowed: true,
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  };
}

function genericChatStream(text: string): Response {
  const body = [
    {
      id: "chatcmpl_generic",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl_generic",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    "[DONE]",
  ]
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("ChatService", () => {
  it("honors a pre-admitted thread id for linked Chat creation", async () => {
    const { service } = openFixture();
    const threadId = "84000000-0000-4000-8000-000000000099" as ChatThreadId;

    const created = await service.execute({
      kind: "create-chat-thread",
      threadId,
      hostId: "local",
      title: "Linked reviewer",
    });

    expect(created).toMatchObject({ kind: "thread-created", thread: { id: threadId } });
  });

  it("hides Side Chat sidecar threads from bootstrap and search while keeping them readable", async () => {
    const hidden = new Set<string>();
    const { service } = openFixture({ hiddenThreadIds: () => hidden });
    const listed = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Release notes",
    });
    const sidecar = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Side Chat about Release notes",
    });
    if (listed.kind !== "thread-created" || sidecar.kind !== "thread-created") {
      throw new Error("Expected thread-created results.");
    }
    hidden.add(String(sidecar.thread.id));

    const bootstrap = await service.bootstrap();

    expect(bootstrap.threads.map((thread) => thread.title)).toEqual(["Release notes"]);
    expect(service.search("Side Chat")).toEqual([]);
    // The sidecar is unlisted, not unreadable: its own Side Chat tab opens it by id.
    expect(service.read(sidecar.thread.id).thread.title).toBe("Side Chat about Release notes");
  });

  it("carries the source thread's context on a sidecar's first ordinary send", async () => {
    const windowId = "84000000-0000-4000-8000-000000000099" as WindowId;
    const asked: Array<{ sidecarThreadId: string; windowId?: string }> = [];
    const { service, fakeDriver } = openFixture({
      resolveSideChatSourceContext: async (input) => {
        asked.push({
          sidecarThreadId: String(input.sidecarThreadId),
          ...(input.windowId === undefined ? {} : { windowId: String(input.windowId) }),
        });
        return {
          kind: "resolved",
          text: "Read-only context from other threads.\n\nReferenced thread: Release notes (chat, Recents)\nuser: ship the notes",
        };
      },
    });
    const sidecar = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Side Chat about Release notes",
    });
    if (sidecar.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await service.execute(
      {
        kind: "send-chat-turn",
        threadId: sidecar.thread.id,
        expectedVersion: sidecar.thread.version,
        prompt: "What is this thread about?",
      },
      { windowId },
    );

    expect(asked).toEqual([{ sidecarThreadId: String(sidecar.thread.id), windowId }]);
    expect(fakeDriver.sentTurns).toHaveLength(1);
    const contextText = (fakeDriver.sentTurns[0]?.context ?? [])
      .map((block) => block.text)
      .join("\n");
    expect(contextText).toContain("Referenced thread: Release notes");
    expect(contextText).toContain("ship the notes");
    // The sidecar asks an ordinary question; the source context is supplied by
    // the host, never smuggled into the prompt by the renderer.
    expect(fakeDriver.sentTurns[0]?.prompt).toBe("What is this thread about?");
  });

  it("refuses a sidecar send when its source thread is no longer readable", async () => {
    const { service, fakeDriver } = openFixture({
      resolveSideChatSourceContext: async () => ({ kind: "unreadable" }),
    });
    const sidecar = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Side Chat about Release notes",
    });
    if (sidecar.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute(
        {
          kind: "send-chat-turn",
          threadId: sidecar.thread.id,
          expectedVersion: sidecar.thread.version,
          prompt: "What is this thread about?",
        },
        { windowId: "84000000-0000-4000-8000-000000000099" as WindowId },
      ),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(fakeDriver.sentTurns).toHaveLength(0);
  });

  it("leaves an ordinary Chat thread's turn untouched by the Side Chat resolver", async () => {
    const { service, fakeDriver } = openFixture({
      // Undefined means "not a sidecar": an ordinary thread must not gain a
      // source-context block, and must not be refused.
      resolveSideChatSourceContext: async () => undefined,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Release notes",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await service.execute(
      {
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Draft the notes",
      },
      { windowId: "84000000-0000-4000-8000-000000000099" as WindowId },
    );

    expect(fakeDriver.sentTurns).toHaveLength(1);
    expect(
      (fakeDriver.sentTurns[0]?.context ?? []).map((block) => block.text).join("\n"),
    ).not.toContain("Referenced thread");
  });

  it("resolves a turn's `#thread` mentions on the server and stores only what the user typed", async () => {
    const windowId = "84000000-0000-4000-8000-000000000099" as WindowId;
    const asked: Array<{ threadMentionIds: ReadonlyArray<string>; windowId?: string }> = [];
    const { service, fakeDriver, contextHarness } = openFixture({
      resolveThreadMentionContext: async (input) => {
        asked.push({
          threadMentionIds: input.threadMentionIds.map(String),
          ...(input.windowId === undefined ? {} : { windowId: String(input.windowId) }),
        });
        return input.threadMentionIds.map((threadId) => ({
          kind: "resolved" as const,
          threadId,
          text: "Read-only context from other threads.\n\nReferenced thread: Release notes (chat, Recents)\nuser: ship the notes",
        }));
      },
    });
    const planTurn = vi.spyOn(contextHarness, "planTurn");
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Launch plan",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await service.execute(
      {
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Compare this with #[Release notes]",
        threadMentionIds: ["release-notes-thread"],
      },
      { windowId },
    );

    // Ids only: the transcript is read by the host on this send's own window,
    // never taken from the command.
    expect(asked).toEqual([{ threadMentionIds: ["release-notes-thread"], windowId }]);
    const contextText = (fakeDriver.sentTurns[0]?.context ?? [])
      .map((block) => block.text)
      .join("\n");
    expect(contextText).toContain("Referenced thread: Release notes");
    expect(contextText).toContain("ship the notes");
    // The user's message is exactly what they typed, in the prompt and in the
    // durable content the transcript and the export read back.
    expect(fakeDriver.sentTurns[0]?.prompt).toBe("Compare this with #[Release notes]");
    const view = service.read(created.thread.id);
    expect(view.contents.filter((content) => content.role === "user").map((c) => c.body)).toEqual([
      "Compare this with #[Release notes]",
    ]);
    // Mention context is workspace context like any other selection, so the
    // planner may compact or omit it; it is never `required`.
    const mentionEntries = planTurn.mock.calls
      .at(-1)?.[0]
      .entries.filter((entry) => String(entry.source.referenceId).startsWith("thread-mention:"));
    expect(mentionEntries).toHaveLength(1);
    expect(mentionEntries?.[0]?.category).toBe("workspace-context");
    expect(mentionEntries?.[0]?.posture).toBe("compressible");
  });

  it("does not carry a turn's mention context into the next turn", async () => {
    const windowId = "84000000-0000-4000-8000-000000000099" as WindowId;
    const { service, fakeDriver } = openFixture({
      resolveThreadMentionContext: async (input) =>
        input.threadMentionIds.map((threadId) => ({
          kind: "resolved" as const,
          threadId,
          text: "Referenced thread: Release notes (chat, Recents)\nuser: ship the notes",
        })),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Launch plan",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await service.execute(
      {
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Compare this with #[Release notes]",
        threadMentionIds: ["release-notes-thread"],
      },
      { windowId },
    );
    const afterFirst = service.read(created.thread.id);
    await service.execute(
      {
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: afterFirst.thread.version,
        prompt: "Now draft the summary",
      },
      { windowId },
    );

    // A mention is context for the turn that made it. The second turn replays
    // the first turn's message, and that message is the user's own words.
    const secondContext = (fakeDriver.sentTurns[1]?.context ?? []).map((block) => block.text);
    expect(secondContext).toContain("Compare this with #[Release notes]");
    expect(secondContext.join("\n")).not.toContain("Referenced thread");
    expect(secondContext.join("\n")).not.toContain("ship the notes");
  });

  it("says a mention could not be read rather than quoting a thread the sender may not open", async () => {
    const { service, fakeDriver } = openFixture({
      resolveThreadMentionContext: async (input) =>
        input.threadMentionIds.map((threadId) => ({ kind: "unreadable" as const, threadId })),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Launch plan",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await service.execute(
      {
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Compare this with #[Release notes]",
        threadMentionIds: ["release-notes-thread"],
      },
      { windowId: "84000000-0000-4000-8000-000000000099" as WindowId },
    );

    const contextText = (fakeDriver.sentTurns[0]?.context ?? [])
      .map((block) => block.text)
      .join("\n");
    expect(contextText).toContain("could not be read");
    expect(contextText).not.toContain("Referenced thread");
    expect(fakeDriver.sentTurns[0]?.prompt).toBe("Compare this with #[Release notes]");
  });

  it("leaves a turn without mentions untouched by the mention resolver", async () => {
    const resolveThreadMentionContext = vi.fn(async () => []);
    const { service, fakeDriver } = openFixture({ resolveThreadMentionContext });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Launch plan",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await service.execute(
      {
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Draft the notes",
      },
      { windowId: "84000000-0000-4000-8000-000000000099" as WindowId },
    );

    expect(resolveThreadMentionContext).not.toHaveBeenCalled();
    expect(fakeDriver.sentTurns[0]?.prompt).toBe("Draft the notes");
    expect(
      (fakeDriver.sentTurns[0]?.context ?? []).map((block) => block.text).join("\n"),
    ).not.toContain("could not be read");
  });

  it("rejects Chat and work mutations while Chat mode is disabled", async () => {
    const chatEnabled = { current: true };
    const { service, persistence } = openFixture({ chatEnabled });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retained",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const before = countRows(persistence.connection, "SELECT COUNT(*) AS count FROM event_journal");
    chatEnabled.current = false;

    for (const command of [
      {
        kind: "rename-chat-thread",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        title: "Blocked rename",
      },
      {
        kind: "add-chat-work-item",
        threadId: created.thread.id,
        expectedVersion: 0,
        itemId: crypto.randomUUID(),
        title: "Blocked work",
        status: "pending",
        position: 0,
        origin: "user",
      },
      {
        kind: "delete-chat-thread",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        confirmed: true,
      },
    ]) {
      await expect(service.execute(command)).rejects.toMatchObject({
        failure: { category: "unavailable" },
      });
    }

    await expect(
      service.uploadAttachment({
        threadId: created.thread.id,
        attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000088"),
        displayName: "blocked.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("blocked"),
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(countRows(persistence.connection, "SELECT COUNT(*) AS count FROM event_journal")).toBe(
      before,
    );
    expect(persistence.readChatThread(created.thread.id)).toBeDefined();
  });

  it("bootstraps settings and threads", async () => {
    const { service } = openFixture();
    const bootstrap = await service.bootstrap();
    expect(bootstrap.settings.defaultResearchRouting).toBe("automatic");
    expect(bootstrap.threads).toEqual([]);
  });

  it("excludes archived Chat threads from the bootstrap navigation source", async () => {
    const { service } = openFixture();
    const active = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Active conversation",
    });
    const archived = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Archived conversation",
    });
    if (active.kind !== "thread-created" || archived.kind !== "thread-created") {
      throw new Error("Expected thread-created results.");
    }
    await service.execute({
      kind: "change-chat-thread-lifecycle",
      threadId: archived.thread.id,
      expectedVersion: archived.thread.version,
      lifecycle: "archived",
    });

    expect((await service.bootstrap()).threads.map((thread) => thread.id)).toEqual([
      active.thread.id,
    ]);
  });

  it("bootstraps an explicitly unconfigured fresh store and blocks thread creation", async () => {
    const { service } = openFixture({ seedSettings: false });
    await expect(service.bootstrap()).resolves.toMatchObject({
      settings: {
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        version: 0,
      },
      threads: [],
    });
    expect((await service.bootstrap()).settings.defaultProviderInstanceId).toBeUndefined();

    await expect(
      service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Needs defaults",
      }),
    ).rejects.toMatchObject({
      failure: {
        category: "unavailable",
        message: "Configure a default Chat provider and model before creating a conversation.",
      },
    });
  });

  it("returns aggregate-head versions from bootstrap and search after attachment updates", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Aggregate list",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    await service.uploadAttachment({
      threadId: created.thread.id,
      attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000091"),
      displayName: "head.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("head"),
    });

    const current = service.read(created.thread.id).thread.version;
    expect((await service.bootstrap()).threads[0]?.version).toBe(current);
    expect(service.search("Aggregate list")[0]?.version).toBe(current);
  });

  it("rejects zero-byte uploads before attachment journaling", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Empty upload",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const before = countRows(persistence.connection, "SELECT COUNT(*) AS count FROM event_journal");

    await expect(
      service.uploadAttachment({
        threadId: created.thread.id,
        attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000092"),
        displayName: "empty.txt",
        mediaType: "text/plain",
        bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(countRows(persistence.connection, "SELECT COUNT(*) AS count FROM event_journal")).toBe(
      before,
    );
  });

  it("preserves invalid thread-work failures through the Chat command boundary", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Work errors",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "edit-chat-work-item",
        threadId: created.thread.id,
        expectedVersion: 0,
        itemId: crypto.randomUUID(),
        title: "Missing",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("rejects stale sends before persisting content or context plans", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Stale send",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    await service.execute({
      kind: "rename-chat-thread",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      title: "Advanced",
    });
    const beforeContext = countRows(
      persistence.connection,
      "SELECT COUNT(*) AS count FROM event_journal WHERE event_name IN ('context.manifest-created@1', 'context.plan-created@1')",
    );
    const beforeContent = countRows(
      persistence.connection,
      "SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ?",
      String(created.thread.id),
    );

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Must not be planned",
      }),
    ).rejects.toMatchObject({ failure: { category: "stale" } });
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM event_journal WHERE event_name IN ('context.manifest-created@1', 'context.plan-created@1')",
      ),
    ).toBe(beforeContext);
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ?",
        String(created.thread.id),
      ),
    ).toBe(beforeContent);
  });

  it("validates default provider, model, and SearXNG endpoint before saving", async () => {
    const disabled = openFixture({ providerEnabled: false });
    await expect(
      disabled.service.execute({
        kind: "update-chat-settings",
        expectedVersion: 1,
        defaultProviderInstanceId: ids.provider,
        defaultModelId: "model-a",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm.",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });

    await expect(
      disabled.service.execute({
        kind: "update-chat-settings",
        expectedVersion: 1,
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm.",
      }),
    ).resolves.toMatchObject({ kind: "settings-updated" });
    expect(
      disabled.persistence.readChatSettings()?.settings.defaultProviderInstanceId,
    ).toBeUndefined();
    expect(disabled.persistence.readChatSettings()?.settings.defaultModelId).toBeUndefined();

    const { service } = openFixture();
    await expect(
      service.execute({
        kind: "update-chat-settings",
        expectedVersion: 1,
        defaultProviderInstanceId: ids.provider,
        defaultModelId: "missing-model",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm.",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    const noNativeResearch = probeFixture();
    const researchUnavailable = openFixture({
      probe: probeFixture({
        capabilities: { ...noNativeResearch.capabilities, nativeWebResearch: "unsupported" },
      }),
    });
    await expect(
      researchUnavailable.service.execute({
        kind: "update-chat-settings",
        expectedVersion: 1,
        defaultProviderInstanceId: ids.provider,
        defaultModelId: "model-a",
        defaultResearchEnabled: true,
        defaultResearchRouting: "provider-native",
        defaultPersonalityInstructions: "Be calm.",
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });

    await expect(
      service.execute({
        kind: "update-chat-settings",
        expectedVersion: 1,
        defaultResearchEnabled: true,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm.",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    await expect(
      service.execute({
        kind: "update-chat-settings",
        expectedVersion: 1,
        defaultProviderInstanceId: ids.provider,
        defaultModelId: "model-a",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        searxngBaseUrl: "https://search.example.test/?q=unsafe",
        defaultPersonalityInstructions: "Be calm.",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    const updated = await service.execute({
      kind: "update-chat-settings",
      expectedVersion: 1,
      defaultProviderInstanceId: ids.provider,
      defaultModelId: "model-a",
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      searxngBaseUrl: "https://search.example.test/base",
      defaultPersonalityInstructions: "Be calm.",
    });
    expect(updated).toMatchObject({
      kind: "settings-updated",
      settings: { searxngBaseUrl: "https://search.example.test/base/" },
    });
  });

  it("copies authoritative Chat Settings into each new thread", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Settings snapshot",
    });

    expect(created).toMatchObject({
      kind: "thread-created",
      thread: {
        providerInstanceId: ids.provider,
        modelId: "model-a",
        researchEnabled: true,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
      },
    });
  });

  it("rejects moving a thread into a missing Chat Project", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Project boundary",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "move-chat-thread",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        projectId: "84000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(service.read(created.thread.id).thread.projectId).toBeUndefined();
  });

  it("rolls back user content when the turn event cannot commit", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Atomic content",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    persistence.connection.exec(`
      CREATE TRIGGER fail_chat_turn_insert
      BEFORE INSERT ON event_journal
      WHEN NEW.event_name = 'chat.turn-created@1'
      BEGIN
        SELECT RAISE(ABORT, 'fixture turn failure');
      END;
    `);

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Must roll back",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ?",
        String(created.thread.id),
      ),
    ).toBe(0);
  });

  it("removes finalized attachment bytes when the attachment event cannot commit", async () => {
    const { service, persistence, dataDirectory } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Atomic attachment",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const attachmentId = decodeChatAttachmentId("84000000-0000-4000-8000-000000000090");
    persistence.connection.exec(`
      CREATE TRIGGER fail_chat_attachment_insert
      BEFORE INSERT ON event_journal
      WHEN NEW.event_name = 'chat.attachment-updated@1'
      BEGIN
        SELECT RAISE(ABORT, 'fixture attachment failure');
      END;
    `);

    await expect(
      service.uploadAttachment({
        threadId: created.thread.id,
        attachmentId,
        displayName: "atomic.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("atomic"),
      }),
    ).rejects.toMatchObject({ _tag: "JournalWriteFailed" });
    expect(() =>
      accessSync(join(dataDirectory, "threads", created.thread.id, attachmentId, "finalized.bin")),
    ).toThrow();
  });

  it("rolls back assistant checkpoints when the attempt event cannot commit", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Queue.offer(queue, {
              kind: "text-delta",
              sessionId: input.sessionId,
              text: "Must roll back",
            } as never),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service, persistence } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Atomic assistant",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    persistence.connection.exec(`
      CREATE TRIGGER fail_chat_attempt_insert
      BEFORE INSERT ON event_journal
      WHEN NEW.event_name = 'chat.attempt-updated@1'
      BEGIN
        SELECT RAISE(ABORT, 'fixture attempt failure');
      END;
    `);

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Begin",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ? AND content_role = 'assistant'",
        String(created.thread.id),
      ),
    ).toBe(0);
  });

  it("rolls back citation snippets when the citation event cannot commit", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "citation",
                sessionId: input.sessionId,
                citationId: "provider-citation-rollback",
                sourceTitle: "Rollback source",
                sourceUrl: "https://octant.dev/rollback",
                snippet: "Must roll back",
              } as never);
              yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service, persistence } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Atomic citation",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    persistence.connection.exec(`
      CREATE TRIGGER fail_chat_citation_insert
      BEFORE INSERT ON event_journal
      WHEN NEW.event_name = 'chat.citation-recorded@1'
      BEGIN
        SELECT RAISE(ABORT, 'fixture citation failure');
      END;
    `);

    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Research",
    });
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ? AND content_role = 'snippet'",
        String(created.thread.id),
      ),
    ).toBe(0);
  });

  it("creates a thread, uploads an attachment, sends a turn, and confines provider access to scratch", async () => {
    const { service, fakeDriver, dataDirectory, contextHarness } = openFixture();
    const planSpy = vi.spyOn(contextHarness, "planTurn");
    const userProjectRoot = join(dataDirectory, "user-project-root");
    mkdtempSync(userProjectRoot);

    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Hello",
      projectId: ids.project,
    });
    expect(created.kind).toBe("thread-created");
    if (created.kind !== "thread-created") {
      throw new Error("Expected thread-created result.");
    }

    const upload = await service.uploadAttachment({
      threadId: created.thread.id,
      attachmentId: decodeChatAttachmentId(ids.attachment),
      displayName: "note.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("fixture"),
    });
    expect(upload.status).toBe("finalized");
    const attachmentBytes = new TextEncoder().encode("fixture");

    const afterUpload = service.read(created.thread.id);
    const sendTurn = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: afterUpload.thread.version,
      prompt: "Say hello",
      attachmentIds: [upload.id],
    });
    expect(sendTurn.kind).toBe("turn-created");

    const afterSend = service.read(created.thread.id);
    expect(afterSend.turns[0]?.attempts[0]?.outcome).toBe("completed");

    const view = afterSend;
    expect(view).toMatchObject({
      thread: { researchRouting: "automatic" },
      turns: [{ attempts: [{ outcome: "completed" }] }],
    });
    expect(view.turns[0]?.attempts[0]?.providerSessionId).toBeDefined();

    const scratchRoot = fakeDriver.acquireInputs[0]?.projectRoot;
    expect(fakeDriver.acquireInputs[0]).toMatchObject({ mode: "chat", projectRoot: scratchRoot });
    expect(scratchRoot).toBeDefined();
    expect(scratchRoot).not.toContain(userProjectRoot);
    expect(scratchRoot).toContain(join(dataDirectory, "scratch"));

    const planned = planSpy.mock.calls.at(-1)?.[0];
    expect(planned?.entries.map((entry) => entry.category)).toEqual(
      expect.arrayContaining([
        "user-instructions",
        "project-memory",
        "current-request",
        "workspace-context",
        "octant-tools",
      ]),
    );
    expect(planned?.entries.some((entry) => entry.state === "referenced")).toBe(true);
    expect(fakeDriver.sentTurns[0]?.attachments[0]).toMatchObject({
      displayName: "note.txt",
      bytes: attachmentBytes,
    });
    expect(fakeDriver.sentTurns[0]?.context).toEqual(
      expect.arrayContaining([
        { kind: "instructions", text: "Be calm." },
        { kind: "project-memory", text: "Remember the launch date." },
      ]),
    );
  });

  it("purges an unsent attachment but refuses to discard durable turn evidence", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Attachment drafts",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const discarded = await service.uploadAttachment({
      threadId: created.thread.id,
      attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000091"),
      displayName: "discard-me.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("draft"),
    });

    await expect(service.discardAttachment(created.thread.id, discarded.id)).resolves.toMatchObject(
      {
        id: discarded.id,
        status: "purged",
      },
    );
    expect(service.read(created.thread.id).attachments).toEqual([
      expect.objectContaining({ id: discarded.id, status: "purged" }),
    ]);
    await expect(service.readAttachment(created.thread.id, discarded.id)).rejects.toMatchObject({
      failure: { category: "invalid" },
    });

    const retained = await service.uploadAttachment({
      threadId: created.thread.id,
      attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000092"),
      displayName: "retain-me.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("evidence"),
    });
    const current = service.read(created.thread.id);
    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: current.thread.version,
      prompt: "Use this evidence",
      attachmentIds: [retained.id],
    });

    await expect(service.discardAttachment(created.thread.id, retained.id)).rejects.toMatchObject({
      failure: { category: "invalid" },
    });
    await expect(service.readAttachment(created.thread.id, retained.id)).resolves.toEqual(
      new TextEncoder().encode("evidence"),
    );
  });

  it("recovers abandoned finalized drafts while retaining turn-referenced attachments", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Attachment recovery",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const abandoned = await service.uploadAttachment({
      threadId: created.thread.id,
      attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000093"),
      displayName: "abandoned.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("abandoned"),
    });
    const retained = await service.uploadAttachment({
      threadId: created.thread.id,
      attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000094"),
      displayName: "retained.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("retained"),
    });
    const current = service.read(created.thread.id);
    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: current.thread.version,
      prompt: "Retain this",
      attachmentIds: [retained.id],
    });

    await service.recoverManagedAttachments();

    expect(service.read(created.thread.id).attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: abandoned.id, status: "purged" }),
        expect.objectContaining({ id: retained.id, status: "finalized" }),
      ]),
    );
    await expect(service.readAttachment(created.thread.id, retained.id)).resolves.toEqual(
      new TextEncoder().encode("retained"),
    );
  });

  it("attributes explicit preview selections through the context planner as removable workspace context", async () => {
    const { service, fakeDriver, dataDirectory, contextHarness } = openFixture();
    const planSpy = vi.spyOn(contextHarness, "planTurn");
    const userProjectRoot = join(dataDirectory, "user-project-root");
    mkdtempSync(userProjectRoot);

    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Hello",
      projectId: ids.project,
    });
    expect(created.kind).toBe("thread-created");
    if (created.kind !== "thread-created") {
      throw new Error("Expected thread-created result.");
    }

    const selectionId = decodePreviewContextSelectionId("11111111-2222-4333-8444-555555555555");
    const targetId = decodePreviewTargetId("22222222-3333-4444-8555-666666666666");
    const afterCreate = service.read(created.thread.id);
    const sendTurn = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: afterCreate.thread.version,
      prompt: "Summarize the report",
      previewSelections: [
        {
          id: selectionId,
          displayName: "report.pdf",
          selection: {
            kind: "pdf",
            targetId,
            sourceVersion: {
              contentSha256: decodeContentSha256(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              ),
              byteSize: 1024,
              observedAt: "2026-07-22T00:00:00.000Z",
            },
            page: 1,
          },
        },
      ],
    });
    expect(sendTurn.kind).toBe("turn-created");

    const planned = planSpy.mock.calls.at(-1)?.[0];
    const selectionEntries = planned?.entries.filter(
      (entry) => entry.source.kind === "preview-selection",
    );
    expect(selectionEntries).toHaveLength(1);
    expect(selectionEntries?.[0]?.state).toBe("referenced");
    expect(selectionEntries?.[0]?.posture).toBe("compressible");
    expect(selectionEntries?.[0]?.label).toBe("report.pdf");
    expect(fakeDriver.acquireInputs[0]).toMatchObject({ mode: "chat" });
  });

  it("attributes explicit canvas selections through the context planner as removable workspace context", async () => {
    const { service, fakeDriver, contextHarness } = openFixture();
    const planSpy = vi.spyOn(contextHarness, "planTurn");

    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Hello",
      projectId: ids.project,
    });
    expect(created.kind).toBe("thread-created");
    if (created.kind !== "thread-created") {
      throw new Error("Expected thread-created result.");
    }

    const selectionId = decodeCanvasContextSelectionId("33333333-3333-4333-8333-333333333333");
    const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
    const versionId = decodeCanvasVersionId("22222222-2222-4222-8222-222222222222");
    const afterCreate = service.read(created.thread.id);
    const sendTurn = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: afterCreate.thread.version,
      prompt: "Use the quarterly canvas",
      canvasSelections: [
        {
          id: selectionId,
          canvasId,
          versionId,
          sequence: 2,
          displayName: "Quarterly summary",
          scope: "whole-canvas",
        },
      ],
    });
    expect(sendTurn.kind).toBe("turn-created");

    const planned = planSpy.mock.calls.at(-1)?.[0];
    const selectionEntries = planned?.entries.filter(
      (entry) => entry.source.kind === "canvas-selection",
    );
    expect(selectionEntries).toHaveLength(1);
    expect(selectionEntries?.[0]?.state).toBe("referenced");
    expect(selectionEntries?.[0]?.posture).toBe("compressible");
    expect(selectionEntries?.[0]?.label).toBe("Quarterly summary");
    expect(fakeDriver.acquireInputs[0]).toMatchObject({ mode: "chat" });
  });

  it("revalidates structured extension selections at send, persists exact identity, and forwards only planned context", async () => {
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-1" },
    };
    const resolveExtensionSelectionContext = vi.fn(async (input) => ({
      selections: input.selections,
      entries: [
        {
          contextEntry: decodeContextEntry({
            id: "30000000-0000-4000-8000-000000000002",
            source: { kind: "plugin", referenceId: "plugin:build-tools" },
            category: "extension-instructions",
            label: "Build guidance",
            eligibility: {
              providerInstanceId: ids.provider,
              status: "eligible",
              reason: "selected-provider",
            },
            posture: "required",
            retention: "active",
            priority: 0,
            originalSize: 8,
            includedSize: 8,
            tokens: { kind: "known", tokens: 8, accuracy: "exact-tokenizer" },
            state: "included",
            introducedAtTurn: 1,
            lastUsedAtTurn: 1,
            reuseCount: 0,
            preview: { redacted: true, label: "Build guidance" },
          }),
          providerContext: {
            kind: "instructions" as const,
            text: "Use only the selected build guidance.",
          },
        },
      ],
      toolSet: {
        definitions: [
          {
            name: "build_project",
            inputSchema: { type: "object", properties: {}, required: [] },
          },
        ],
        execute: vi.fn(async () => ({ result: { status: "built" } })),
      },
    }));
    const { service, fakeDriver } = openFixture({ resolveExtensionSelectionContext });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Extensions",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const sent = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Build this",
      extensionSelections: [extensionSelection],
    });

    expect(sent.kind).toBe("turn-created");
    if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
    expect(resolveExtensionSelectionContext).toHaveBeenCalledWith({
      phase: "send",
      thread: expect.objectContaining({ id: created.thread.id }),
      selections: [extensionSelection],
    });
    expect(sent.turn.extensionSelections).toEqual([
      {
        ...extensionSelection,
        origin: { kind: "turn", reference: String(sent.turn.id) },
      },
    ]);
    expect(fakeDriver.sentTurns[0]?.context).toContainEqual({
      kind: "instructions",
      text: "Use only the selected build guidance.",
    });
    expect(fakeDriver.sentTurns[0]?.tools.map(({ name }) => name)).toEqual([
      "octant_web_research",
      "build_project",
    ]);
  });

  it("blocks provider handoff before provider acquisition when extension authority drifts", async () => {
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-handoff" },
    };
    const resolveExtensionSelectionContext = vi.fn(async (input) => {
      if (input.phase === "provider-handoff") {
        throw new ChatServiceError({
          category: "unavailable",
          message: "Selected extension authority changed before provider handoff.",
        });
      }
      return { selections: input.selections, entries: [] };
    });
    const { service, fakeDriver } = openFixture({ resolveExtensionSelectionContext });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Blocked provider handoff",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const sent = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Do not hand off",
      extensionSelections: [extensionSelection],
    });

    expect(sent.kind).toBe("turn-created");
    expect(resolveExtensionSelectionContext.mock.calls.map(([input]) => input.phase)).toEqual([
      "send",
      "provider-handoff",
    ]);
    expect(fakeDriver.acquireInputs).toHaveLength(0);
    expect(fakeDriver.sentTurns).toHaveLength(0);
    expect(service.read(created.thread.id).turns[0]?.attempts[0]?.outcome).toBe("interrupted");
  });

  it("reattaches an interrupted provider session via ProviderConnection.resume with the exact persisted resume cursor and becomes Waiting without sending", async () => {
    const { service, fakeDriver } = openFixture({ turnOutcome: "interrupted" });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Resume session",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const sent = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Continue this",
    });
    if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "interrupted",
    );
    const interrupted = service.read(created.thread.id);
    const interruptedAttempt = interrupted.turns[0]!.attempts[0]!;
    expect(interruptedAttempt.outcome).toBe("interrupted");
    expect(interruptedAttempt.resumeCursor).toEqual({
      driverKind: "openai-compatible",
      value: `session-${String(interruptedAttempt.providerSessionId)}`,
    });
    const sentTurnCount = fakeDriver.sentTurns.length;

    const resumed = await service.execute({
      kind: "resume-chat-turn",
      threadId: created.thread.id,
      expectedVersion: interrupted.thread.version,
      turnId: sent.turn.id,
      attemptId: interruptedAttempt.id,
    });
    expect(resumed).toMatchObject({ kind: "attempt-updated" });
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts.at(-1)?.outcome === "waiting",
      { timeoutMs: 10_000 },
    );

    expect(fakeDriver.resumeInputs).toHaveLength(1);
    expect(fakeDriver.resumeInputs[0]?.resumeCursor).toEqual(interruptedAttempt.resumeCursor);
    expect(fakeDriver.resumeInputs[0]?.sessionId).toBe(
      String(interruptedAttempt.providerSessionId),
    );
    // Session reattachment must NOT call send — that would create a new
    // provider turn, duplicating the original prompt, context, attachments,
    // and tools into a session that already contains the interrupted turn.
    expect(fakeDriver.sentTurns).toHaveLength(sentTurnCount);
    const finalView = service.read(created.thread.id);
    const resumedAttempt = finalView.turns[0]!.attempts.at(-1)!;
    // Resume reattaches the session and becomes Waiting — no generation is
    // continued. Real drivers emit no terminal events from resume alone.
    expect(resumedAttempt.outcome).toBe("waiting");
    expect(resumedAttempt.providerSessionId).toBe(interruptedAttempt.providerSessionId);
    expect(resumedAttempt.resumeCursor).toEqual(interruptedAttempt.resumeCursor);
    expect(resumedAttempt.id).not.toBe(interruptedAttempt.id);
  });

  it("fails closed before ProviderConnection.resume when extension authority drifts at the resume boundary", async () => {
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-resume" },
    };
    const resolveExtensionSelectionContext = vi.fn(async (input: { readonly phase: string }) => {
      if (input.phase === "resume") {
        throw new ChatServiceError({
          category: "unavailable",
          message: "Selected extension authority drifted before provider resume.",
        });
      }
      return { selections: [extensionSelection], entries: [] };
    });
    const { service, fakeDriver } = openFixture({
      turnOutcome: "interrupted",
      resolveExtensionSelectionContext,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Blocked resume",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const sent = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Do not resume",
      extensionSelections: [extensionSelection],
    });
    if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "interrupted",
    );
    const interrupted = service.read(created.thread.id);
    const interruptedAttempt = interrupted.turns[0]!.attempts[0]!;
    const acquireCount = fakeDriver.acquireInputs.length;
    const resumeCount = fakeDriver.resumeInputs.length;
    const sentTurnCount = fakeDriver.sentTurns.length;

    await expect(
      service.execute({
        kind: "resume-chat-turn",
        threadId: created.thread.id,
        expectedVersion: interrupted.thread.version,
        turnId: sent.turn.id,
        attemptId: interruptedAttempt.id,
      }),
    ).rejects.toThrow();
    expect(resolveExtensionSelectionContext.mock.calls.map(([input]) => input.phase)).toContain(
      "resume",
    );
    // Stale selections contribute zero provider side effects: no new acquire,
    // no resume call, no send, no context/tool/credential leakage.
    expect(fakeDriver.acquireInputs).toHaveLength(acquireCount);
    expect(fakeDriver.resumeInputs).toHaveLength(resumeCount);
    expect(fakeDriver.sentTurns).toHaveLength(sentTurnCount);
    const finalView = service.read(created.thread.id);
    const resumeAttempt = finalView.turns[0]!.attempts.at(-1)!;
    expect(resumeAttempt.id).toBe(interruptedAttempt.id);
    expect(resumeAttempt.outcome).toBe("interrupted");
  });

  it("fails closed before probe/credential/attachment/app-tool/context work when extension authority drifts at the resume boundary", async () => {
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-resume-strict" },
    };
    let probeCallCount = 0;
    let appManagedToolsCallCount = 0;
    const resolveExtensionSelectionContext = vi.fn(async (input: { readonly phase: string }) => {
      if (input.phase === "resume") {
        throw new ChatServiceError({
          category: "unavailable",
          message: "Selected extension authority drifted before provider resume.",
        });
      }
      return { selections: [extensionSelection], entries: [] };
    });
    const acquireInputs: ProviderAcquireInput[] = [];
    const resumeInputs: Array<{
      readonly sessionId: string;
      readonly resumeCursor: { readonly driverKind: string; readonly value: string };
    }> = [];
    const sentTurns: Array<{ readonly sessionId: string; readonly prompt: string }> = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connectionDriver = {
      events: Stream.fromQueue(queue),
      start: (input: { readonly sessionId: string }) =>
        Effect.sync(() => {
          return {
            sessionId: input.sessionId,
            resumeCursor: {
              driverKind: "openai-compatible" as const,
              value: `session-${input.sessionId}`,
            },
          };
        }),
      resume: (input: {
        readonly sessionId: string;
        readonly resumeCursor: { readonly driverKind: string; readonly value: string };
      }) =>
        Effect.sync(() => {
          resumeInputs.push(input);
          return { sessionId: input.sessionId, resumeCursor: input.resumeCursor };
        }),
      send: (input: { readonly sessionId: string; readonly prompt: string }) =>
        Effect.gen(function* () {
          sentTurns.push(input);
          yield* Queue.offer(queue, { kind: "interrupted", sessionId: input.sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const spyDriver = {
      kind: "openai-compatible" as const,
      probe: () =>
        Effect.sync(() => {
          probeCallCount += 1;
          return probeFixture();
        }),
      acquire: (input: ProviderAcquireInput) => {
        acquireInputs.push(input);
        return Effect.succeed(connectionDriver);
      },
    } as unknown as ProviderDriver;
    const { service } = openFixture({
      driver: spyDriver,
      turnOutcome: "interrupted",
      resolveExtensionSelectionContext,
      resolveAppManagedTools: () => {
        appManagedToolsCallCount += 1;
        return undefined;
      },
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Strict drift boundary",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const sent = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Do not resume strictly",
      extensionSelections: [extensionSelection],
    });
    if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "interrupted",
    );
    const interrupted = service.read(created.thread.id);
    const interruptedAttempt = interrupted.turns[0]!.attempts[0]!;
    const probeCountBeforeResume = probeCallCount;
    const appToolsCountBeforeResume = appManagedToolsCallCount;
    const acquireCountBeforeResume = acquireInputs.length;
    const resumeCountBeforeResume = resumeInputs.length;
    const sentTurnCountBeforeResume = sentTurns.length;
    const threadVersionBeforeResume = interrupted.thread.version;

    await expect(
      service.execute({
        kind: "resume-chat-turn",
        threadId: created.thread.id,
        expectedVersion: interrupted.thread.version,
        turnId: sent.turn.id,
        attemptId: interruptedAttempt.id,
      }),
    ).rejects.toThrow();

    // Only the authoritative extension revalidation ("resume" phase) may run.
    // All provider/credential/attachment/app-tool/context side effects must
    // remain zero.
    expect(probeCallCount).toBe(probeCountBeforeResume);
    expect(appManagedToolsCallCount).toBe(appToolsCountBeforeResume);
    expect(acquireInputs).toHaveLength(acquireCountBeforeResume);
    expect(resumeInputs).toHaveLength(resumeCountBeforeResume);
    expect(sentTurns).toHaveLength(sentTurnCountBeforeResume);
    // No new attempt/journal mutation may be committed.
    const finalView = service.read(created.thread.id);
    expect(finalView.thread.version).toBe(threadVersionBeforeResume);
    const resumeAttempt = finalView.turns[0]!.attempts.at(-1)!;
    expect(resumeAttempt.id).toBe(interruptedAttempt.id);
    expect(resumeAttempt.outcome).toBe("interrupted");
  });

  it("rejects resume of an attempt without a persisted provider resume cursor", async () => {
    const noCursorQueue = Effect.runSync(Queue.unbounded<never>());
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.succeed(probeFixture()),
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(noCursorQueue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          resume: () => Effect.void,
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Queue.offer(noCursorQueue, {
                kind: "interrupted",
                sessionId: input.sessionId,
                message: "checkpoint",
              } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never),
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "No cursor",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const sent = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "No cursor",
    });
    if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "interrupted",
    );
    const interrupted = service.read(created.thread.id);
    const interruptedAttempt = interrupted.turns[0]!.attempts[0]!;
    expect(interruptedAttempt.resumeCursor).toBeUndefined();
    await expect(
      service.execute({
        kind: "resume-chat-turn",
        threadId: created.thread.id,
        expectedVersion: interrupted.thread.version,
        turnId: sent.turn.id,
        attemptId: interruptedAttempt.id,
      }),
    ).rejects.toThrow();
  });

  it("maps a stale-resume provider failure to Waiting, preserving identity and cursor without subsequent provider actions", async () => {
    const staleResumeQueue = Effect.runSync(Queue.unbounded<never>());
    const staleResumeDriver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.succeed(probeFixture()),
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(staleResumeQueue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({
              sessionId: input.sessionId,
              resumeCursor: {
                driverKind: "openai-compatible" as const,
                value: `session-${input.sessionId}`,
              },
            }),
          resume: () =>
            Effect.fail({
              kind: "provider-failure" as const,
              category: "stale-resume" as const,
              message: "Provider session is no longer available for resume.",
            } as never),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Queue.offer(staleResumeQueue, {
                kind: "interrupted",
                sessionId: input.sessionId,
                message: "checkpoint",
              } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never),
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver: staleResumeDriver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Stale resume",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const sent = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Will go stale",
    });
    if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "interrupted",
    );
    const interrupted = service.read(created.thread.id);
    const interruptedAttempt = interrupted.turns[0]!.attempts[0]!;
    expect(interruptedAttempt.resumeCursor).toBeDefined();

    const resumed = await service.execute({
      kind: "resume-chat-turn",
      threadId: created.thread.id,
      expectedVersion: interrupted.thread.version,
      turnId: sent.turn.id,
      attemptId: interruptedAttempt.id,
    });
    expect(resumed).toMatchObject({ kind: "attempt-updated" });
    // stale-resume must map to Waiting, never Done or failed.
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts.at(-1)?.outcome === "waiting",
      { timeoutMs: 10_000 },
    );
    const finalView = service.read(created.thread.id);
    const resumeAttempt = finalView.turns[0]!.attempts.at(-1)!;
    expect(resumeAttempt.outcome).toBe("waiting");
    // Identity and cursor remain auditable on the new attempt.
    expect(resumeAttempt.providerSessionId).toBe(interruptedAttempt.providerSessionId);
    expect(resumeAttempt.resumeCursor).toEqual(interruptedAttempt.resumeCursor);
    expect(resumeAttempt.id).not.toBe(interruptedAttempt.id);
  });

  it("fails closed when selected extension tools collide with research or app-managed tools", async () => {
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "server" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-collision" },
    };
    for (const collision of ["octant_web_research", "octant_app_tool"]) {
      const resolveExtensionSelectionContext = vi.fn(async (input) => ({
        selections: input.selections,
        entries: [],
        toolSet: {
          definitions: [
            { name: collision, inputSchema: { type: "object", properties: {}, required: [] } },
          ],
          execute: async () => ({ result: { status: "extension" } }),
        },
      }));
      const resolveAppManagedTools =
        collision === "octant_app_tool"
          ? () => ({
              definitions: [
                {
                  name: "octant_app_tool",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
              ],
              execute: async () => ({ result: { status: "app" } }),
            })
          : undefined;
      const { service, fakeDriver } = openFixture({
        resolveExtensionSelectionContext,
        ...(resolveAppManagedTools === undefined ? {} : { resolveAppManagedTools }),
      });
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Extension collision",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

      await expect(
        service.execute(
          {
            kind: "send-chat-turn",
            threadId: created.thread.id,
            expectedVersion: created.thread.version,
            prompt: "Do not widen tool authority",
            extensionSelections: [extensionSelection],
          },
          { windowId: "84000000-0000-4000-8000-000000000099" as WindowId },
        ),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
      expect(fakeDriver.sentTurns).toHaveLength(0);
    }
  });

  it("bounds selected extension tools to the capacity left after app-managed tools", async () => {
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "server" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-capacity" },
    };
    const appDefinitions = Array.from({ length: 6 }, (_, index) => ({
      name: `app-tool-${index}`,
      inputSchema: { type: "object", properties: {}, required: [] },
    }));
    const extensionDefinitions = Array.from({ length: 4 }, (_, index) => ({
      name: `extension-tool-${index}`,
      inputSchema: { type: "object", properties: {}, required: [] },
    }));
    const { service, fakeDriver } = openFixture({
      resolveAppManagedTools: () => ({
        definitions: appDefinitions,
        execute: async () => ({ result: { status: "app" } }),
      }),
      resolveExtensionSelectionContext: async (input) => ({
        selections: input.selections,
        entries: [],
        toolSet: {
          definitions: extensionDefinitions,
          execute: async () => ({ result: { status: "extension" } }),
        },
      }),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Bound extension tools",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute(
        {
          kind: "send-chat-turn",
          threadId: created.thread.id,
          expectedVersion: created.thread.version,
          prompt: "Use a bounded tool set",
          extensionSelections: [extensionSelection],
        },
        { windowId: "84000000-0000-4000-8000-000000000099" as WindowId },
      ),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(fakeDriver.sentTurns).toHaveLength(0);
  });

  it("uses the authoritative extension resolver for Generic OpenAI send and replay", async () => {
    const requestBodies: unknown[] = [];
    let generatingTurn = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) {
        return Response.json({ data: [{ id: "model-a" }] });
      }
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      generatingTurn += 1;
      return generatingTurn === 1
        ? new Response(null, { status: 500 })
        : genericChatStream("generic replay completed");
    });
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const configuration: OpenAiCompatibleProviderConfiguration = {
      kind: "openai-compatible-http",
      baseUrl: "https://generic-provider.example/v1",
      authentication: "bearer",
      protocol: "chat-completions",
      manualModelIds: ["model-a" as never],
    };
    const driver = makeOpenAiCompatibleDriver({
      instanceId: decodeProviderInstanceId(ids.provider),
      configuration,
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "private-key" },
      fetch,
      clock: () => now,
      correlationId: () => ids.correlation,
    });
    const observed = await Effect.runPromise(
      Effect.scoped(driver.probe({ instanceId: decodeProviderInstanceId(ids.provider) })),
    );
    runtimeRegistry.setObservedState({
      ...observed,
      capabilities: { ...observed.capabilities, appManagedTools: "supported" },
    });
    const snapshot = authoritativeExtensionSnapshot();
    const activation = new ExtensionActivationService({
      policy: {
        resolve: () => ({
          revision: 1,
          projectRevision: 1,
          threadRevision: 1,
          hostAllowed: true,
          modeAllowed: true,
          projectAllowed: true,
          threadAllowed: true,
          policyAllowed: true,
        }),
      },
      catalogStatus: () => "available",
    });
    const loadMaterial = vi.fn(async () => ({
      context: {
        kind: "instructions" as const,
        text: "Use authoritative Generic OpenAI-compatible guidance.",
      },
      tools: [
        {
          name: "build_project",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    }));
    const resolveExtensionSelectionContext = createExtensionChatResolver({
      snapshot: () => snapshot,
      resolveEffectiveState: (current, query) => activation.resolve(current, query),
      providerFamily: () => "openai-compatible" as never,
      materialLoader: { load: loadMaterial },
      toolExecution: {
        availability: () => "available",
        execute: async () => ({ result: { status: "built" } }),
      },
    });
    const { service } = openFixture({ driver, resolveExtensionSelectionContext });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Generic extension handoff",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const effective = activation.resolve(snapshot, {
      scope: {
        hostId: "local",
        mode: "chat",
        projectId: null,
        threadId: created.thread.id,
        providerFamily: "openai-compatible",
      },
    } as never);
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: effective.catalogEpoch,
      origin: { kind: "draft" as const, reference: "generic-draft" },
    };

    const first = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Build once",
      extensionSelections: [extensionSelection],
    });
    if (first.kind !== "turn-created") throw new Error("Expected turn-created result.");
    const failed = service.read(created.thread.id);
    expect(failed.turns[0]?.attempts[0]?.outcome).toBe("failed");
    const retried = await service.execute({
      kind: "retry-chat-turn",
      threadId: created.thread.id,
      expectedVersion: failed.thread.version,
      turnId: first.turn.id,
      attemptId: failed.turns[0]!.attempts[0]!.id,
    });
    expect(retried).toMatchObject({ kind: "attempt-updated" });
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts.at(-1)?.outcome === "completed",
      { timeoutMs: 10_000 },
    );

    expect(loadMaterial).toHaveBeenCalledTimes(4);
    expect(requestBodies).toHaveLength(2);
    for (const body of requestBodies) {
      expect(JSON.stringify(body)).toContain(
        "Use authoritative Generic OpenAI-compatible guidance.",
      );
      expect(body).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({ name: "build_project" }),
          }),
        ]),
      });
    }
  });

  it("loads and sends zero extension material when the authoritative live selection is blocked", async () => {
    const snapshot = authoritativeExtensionSnapshot(false);
    const activation = new ExtensionActivationService({
      policy: {
        resolve: () => ({
          revision: 1,
          projectRevision: 1,
          threadRevision: 1,
          hostAllowed: true,
          modeAllowed: true,
          projectAllowed: true,
          threadAllowed: true,
          policyAllowed: true,
        }),
      },
      catalogStatus: () => "available",
    });
    const loadMaterial = vi.fn();
    const resolveExtensionSelectionContext = createExtensionChatResolver({
      snapshot: () => snapshot,
      resolveEffectiveState: (current, query) => activation.resolve(current, query),
      providerFamily: () => "openai-compatible" as never,
      materialLoader: { load: loadMaterial },
      toolExecution: {
        availability: () => "available",
        execute: async () => ({ result: {} }),
      },
    });
    const { service, fakeDriver } = openFixture({ resolveExtensionSelectionContext });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Blocked extension",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const effective = activation.resolve(snapshot, {
      scope: {
        hostId: "local",
        mode: "chat",
        projectId: null,
        threadId: created.thread.id,
        providerFamily: "openai-compatible",
      },
    } as never);

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Do not load",
        extensionSelections: [
          {
            kind: "plugin",
            extensionId: "30000000-0000-4000-8000-000000000001",
            packageId: "31000000-0000-4000-8000-000000000001",
            componentId: "instructions",
            packageVersion: "1.2.3",
            packageDigest: `sha256:${"a".repeat(64)}`,
            catalogEpoch: effective.catalogEpoch,
            origin: { kind: "draft", reference: "blocked-draft" },
          },
        ],
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(loadMaterial).not.toHaveBeenCalled();
    expect(fakeDriver.sentTurns).toHaveLength(0);
  });

  it("blocks a stored MCP tool before reading source text or sending to the provider", async () => {
    const snapshot = authoritativeExtensionSnapshot(true, "mcp-tool");
    const activation = new ExtensionActivationService({
      policy: {
        resolve: () => ({
          revision: 1,
          projectRevision: 1,
          threadRevision: 1,
          hostAllowed: true,
          modeAllowed: true,
          projectAllowed: true,
          threadAllowed: true,
          policyAllowed: true,
        }),
      },
      catalogStatus: () => "available",
    });
    const readVerifiedComponentText = vi.fn(async () => "export async function execute() {}");
    const resolveExtensionSelectionContext = createExtensionChatResolver({
      snapshot: () => snapshot,
      resolveEffectiveState: (current, query) => activation.resolve(current, query),
      providerFamily: () => "openai-compatible" as never,
      materialLoader: createStoredExtensionMaterialLoader({ readVerifiedComponentText }),
      toolExecution: UNAVAILABLE_EXTENSION_TOOL_EXECUTION,
    });
    const { service, fakeDriver } = openFixture({ resolveExtensionSelectionContext });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Unavailable stored extension tool",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const effective = activation.resolve(snapshot, {
      scope: {
        hostId: "local",
        mode: "chat",
        projectId: null,
        threadId: created.thread.id,
        providerFamily: "openai-compatible",
      },
    } as never);

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Do not execute or inject source",
        extensionSelections: [
          {
            kind: "plugin",
            extensionId: "30000000-0000-4000-8000-000000000001",
            packageId: "31000000-0000-4000-8000-000000000001",
            componentId: "execute",
            packageVersion: "1.2.3",
            packageDigest: `sha256:${"a".repeat(64)}`,
            catalogEpoch: effective.catalogEpoch,
            origin: { kind: "draft", reference: "stored-mcp-tool-draft" },
          },
        ],
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(readVerifiedComponentText).not.toHaveBeenCalled();
    expect(fakeDriver.sentTurns).toHaveLength(0);
  });

  it("rejects an overlapping send while the accepted attempt owns the thread scratch", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => sendGate);
              yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "One at a time",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const first = service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "First response",
    });
    await until(() => service.read(created.thread.id).turns.length === 1);
    const current = service.read(created.thread.id).thread;

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: current.version,
        prompt: "Second response",
      }),
    ).rejects.toMatchObject({ failure: { category: "waiting" } });

    await expect(
      service.execute({
        kind: "delete-chat-thread",
        threadId: created.thread.id,
        expectedVersion: current.version,
      }),
    ).rejects.toMatchObject({ failure: { category: "waiting" } });

    releaseSend();
    await expect(first).resolves.toMatchObject({ kind: "turn-created" });
    expect(service.read(created.thread.id).turns).toHaveLength(1);
  });

  it("keeps a cancelled runner admission-busy until its cleanup releases scratch", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    let releaseSend!: () => void;
    let releaseStop!: () => void;
    let stopStarted = false;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => sendGate);
              yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () =>
            Effect.promise(() => {
              stopStarted = true;
              return stopGate;
            }),
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Cleanup guard",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const first = service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Cancel me",
    });
    await until(() => service.read(created.thread.id).turns.length === 1);
    const queued = service.read(created.thread.id);
    const attempt = queued.turns[0]!.attempts[0]!;

    await service.execute({
      kind: "interrupt-chat-turn",
      threadId: created.thread.id,
      expectedVersion: queued.thread.version,
      turnId: queued.turns[0]!.id,
      attemptId: attempt.id,
    });
    releaseSend();
    await until(() => stopStarted);
    const cancelled = service.read(created.thread.id);
    expect(cancelled.turns[0]!.attempts[0]!.outcome).toBe("cancelled");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: cancelled.thread.version,
        prompt: "Do not reuse scratch yet",
      }),
    ).rejects.toMatchObject({ failure: { category: "waiting" } });

    releaseStop();
    await expect(first).resolves.toMatchObject({ kind: "turn-created" });
  });

  it("rejects a queued stale send before it can journal an orphaned context plan", async () => {
    const probeResult = probeFixture();
    let releaseProbe!: (result: ProviderProbeResult) => void;
    const probeGate = new Promise<ProviderProbeResult>((resolve) => {
      releaseProbe = resolve;
    });
    const driver = {
      probe: () => Effect.promise(() => probeGate),
    } as unknown as ProviderDriver;
    const { service, contextHarness } = openFixture({ driver });
    const planTurn = vi.spyOn(contextHarness, "planTurn");
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Serialized planning",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const providerChange = service.execute({
      kind: "change-chat-provider",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      providerInstanceId: ids.provider,
      modelId: "model-a",
    });
    const staleSend = service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Do not plan this stale request.",
    });

    releaseProbe(probeResult);
    await expect(providerChange).resolves.toMatchObject({ kind: "thread-updated" });
    await expect(staleSend).rejects.toMatchObject({ failure: { category: "stale" } });
    expect(planTurn).not.toHaveBeenCalled();
  });

  it("persists declared model option values on the thread and hands them to session start", async () => {
    const probeResult = probeFixture();
    const effortModel = {
      ...probeResult.models[0]!,
      options: [
        {
          id: "effort",
          displayName: "Effort",
          kind: "selection" as const,
          values: ["low", "high"] as [string, ...string[]],
        },
      ],
    };
    const { service, fakeDriver } = openFixture({
      probe: probeFixture({
        models: [effortModel, { ...effortModel, id: "model-b" as never, options: [] }],
      }),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Effort",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "change-chat-provider",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        providerInstanceId: ids.provider,
        modelId: "model-a",
        modelOptionValues: { effort: "max" },
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    const updated = await service.execute({
      kind: "change-chat-provider",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      providerInstanceId: ids.provider,
      modelId: "model-a",
      modelOptionValues: { effort: "high" },
    });
    if (updated.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
    expect(updated.thread.modelOptionValues).toEqual({ effort: "high" });
    expect(service.read(created.thread.id).thread.modelOptionValues).toEqual({ effort: "high" });

    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: updated.thread.version,
      prompt: "Think hard",
    });
    expect(fakeDriver.startInputs).toHaveLength(1);
    expect(fakeDriver.startInputs[0]).toMatchObject({
      modelId: "model-a",
      modelOptionValues: { effort: "high" },
    });

    // A branch runs the same model, so it keeps the settings chosen for it.
    const afterSend = service.read(created.thread.id);
    const branched = await service.execute({
      kind: "branch-chat-thread",
      threadId: created.thread.id,
      expectedVersion: afterSend.thread.version,
      turnId: afterSend.turns[0]!.id,
      title: "Same effort",
    });
    if (branched.kind !== "thread-created") throw new Error("Expected thread-created result.");
    expect(service.read(branched.thread.id).thread.modelOptionValues).toEqual({ effort: "high" });

    // Switching to a model that declares no such option drops the stale value.
    const afterTurn = service.read(created.thread.id);
    const switched = await service.execute({
      kind: "change-chat-provider",
      threadId: created.thread.id,
      expectedVersion: afterTurn.thread.version,
      providerInstanceId: ids.provider,
      modelId: "model-b",
    });
    if (switched.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
    expect(switched.thread.modelOptionValues).toBeUndefined();
  });

  it("refuses the turn when the probed model no longer offers a persisted option value", async () => {
    const baseModel = probeFixture().models[0]!;
    const effortValues = (values: ReadonlyArray<string>): ProviderProbeResult =>
      probeFixture({
        models: [
          {
            ...baseModel,
            options: [
              {
                id: "effort",
                displayName: "Effort",
                kind: "selection" as const,
                values: values as [string, ...string[]],
              },
            ],
          },
        ],
      });
    let catalog = effortValues(["low", "high"]);
    const acquireCalls: string[] = [];
    const driver = {
      probe: () => Effect.succeed(catalog),
      acquire: () => {
        acquireCalls.push("acquire");
        throw new Error("A retired option must not reach the provider as a default.");
      },
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retired effort",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const updated = await service.execute({
      kind: "change-chat-provider",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      providerInstanceId: ids.provider,
      modelId: "model-a",
      modelOptionValues: { effort: "high" },
    });
    if (updated.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
    expect(updated.thread.modelOptionValues).toEqual({ effort: "high" });

    // The provider retires the tier after the selection was persisted.
    catalog = effortValues(["low"]);

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: updated.thread.version,
        prompt: "Think hard",
      }),
    ).rejects.toMatchObject({
      failure: { category: "unsupported", message: expect.stringContaining("effort=high") },
    });
    // Reported, not silently substituted: no turn ran on the provider default.
    expect(acquireCalls).toEqual([]);
    expect(service.read(created.thread.id).turns).toHaveLength(0);
  });

  it("sends accepted prior transcript and unresolved work as provider context", async () => {
    const { service, fakeDriver } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Context",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    await service.execute({
      kind: "add-chat-work-item",
      threadId: created.thread.id,
      expectedVersion: 0,
      itemId: crypto.randomUUID(),
      title: "Verify context delivery",
      status: "pending",
      position: 0,
      origin: "user",
    });
    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "First question",
    });
    const afterFirst = service.read(created.thread.id);
    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: afterFirst.thread.version,
      prompt: "Second question",
    });

    expect(fakeDriver.sentTurns[1]?.context).toEqual(
      expect.arrayContaining([
        { kind: "instructions", text: "Be calm." },
        { kind: "user-message", text: "First question" },
        { kind: "work-item", text: "Verify context delivery" },
      ]),
    );
    expect(
      fakeDriver.sentTurns[1]?.context?.some((block) => block.text === "Second question"),
    ).toBe(false);
  });

  it("keeps an abandoned reply's prompt but not its text in the next turn's context", async () => {
    const sent: Array<SentTurn> = [];
    const { service } = openFixture({
      driver: abandonedReplyDriver(sent, {
        abandoned: "Abandoned fragment",
        answer: "Real answer",
      }),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Abandoned reply",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "First question",
    });
    await until(() => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "failed");
    // The fragment really is journaled — the assertions below are about what
    // the planner does with it, not about whether it exists.
    expect(service.read(created.thread.id).turns[0]?.attempts[0]?.responseRefs).toHaveLength(1);

    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: service.read(created.thread.id).thread.version,
      prompt: "Second question",
    });

    const context = sent.at(-1)?.context ?? [];
    expect(context).toContainEqual({ kind: "user-message", text: "First question" });
    expect(context.filter((block) => block.kind === "assistant-message")).toEqual([]);
  });

  it("carries exactly one answer for a turn that failed and was retried", async () => {
    const sent: Array<SentTurn> = [];
    const { service } = openFixture({
      driver: abandonedReplyDriver(sent, {
        abandoned: "Abandoned fragment",
        answer: "Real answer",
      }),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retried turn",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const first = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "First question",
    });
    if (first.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(() => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "failed");
    const failed = service.read(created.thread.id);
    await service.execute({
      kind: "retry-chat-turn",
      threadId: created.thread.id,
      expectedVersion: failed.thread.version,
      turnId: first.turn.id,
      attemptId: failed.turns[0]!.attempts[0]!.id,
    });
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts.at(-1)?.outcome === "completed",
    );

    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: service.read(created.thread.id).thread.version,
      prompt: "Second question",
    });

    const context = sent.at(-1)?.context ?? [];
    expect(context.filter((block) => block.kind === "assistant-message")).toEqual([
      { kind: "assistant-message", text: "Real answer" },
    ]);
  });

  it("spends no context budget on an abandoned reply, so real material is not compacted", async () => {
    const probe = probeFixture();
    const sent: Array<SentTurn> = [];
    // Sized against the compaction fixture's window: the thread's real
    // material fits with room to spare, and only the abandoned fragment can
    // push the plan over. If the fragment is costed, the oldest real turn is
    // the entry the planner drops and compacts to pay for it.
    const fixture = openFixture({
      probe,
      driver: {
        ...abandonedReplyDriver(sent, {
          abandoned: `Abandoned: ${"fragment ".repeat(88)}`.trim(),
          answer: "Real answer",
        }),
        contextFacts: compactionContextFacts(probe),
      } as unknown as ProviderDriver,
    });
    const { service } = fixture;
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Budget",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const firstPrompt = `Turn 1: ${"detail ".repeat(170)}`.trim();
    const first = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: firstPrompt,
    });
    if (first.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(() => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "failed");
    const failed = service.read(created.thread.id);
    await service.execute({
      kind: "retry-chat-turn",
      threadId: created.thread.id,
      expectedVersion: failed.thread.version,
      turnId: first.turn.id,
      attemptId: failed.turns[0]!.attempts[0]!.id,
    });
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts.at(-1)?.outcome === "completed",
    );
    await untilThreadSlotReleased(fixture);

    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: service.read(created.thread.id).thread.version,
      prompt: `Turn 2: ${"detail ".repeat(170)}`.trim(),
    });

    const context = sent.at(-1)?.context ?? [];
    expect(context).toContainEqual({ kind: "user-message", text: firstPrompt });
    expect(context).toContainEqual({ kind: "assistant-message", text: "Real answer" });
    expect(context.filter((block) => block.kind === "conversation-summary")).toEqual([]);
  });

  it("persists provider citations and links them to the durable attempt", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "citation",
                sessionId: input.sessionId,
                citationId: "provider-citation-1",
                sourceTitle: "Octant reference",
                sourceUrl: "https://octant.dev/reference",
                snippet: "A cited fact.",
              } as never);
              yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service, persistence } = openFixture({
      driver,
      providerNativeExecute: async () => ({
        query: "x",
        backend: "provider-native",
        results: [],
      }),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Citations",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const configured = await service.execute({
      kind: "change-chat-research",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      researchEnabled: true,
      researchRouting: "provider-native",
    });
    if (configured.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: configured.thread.version,
      prompt: "Research this",
    });

    const attempt = service.read(created.thread.id).turns[0]!.attempts[0]!;
    expect(attempt.citationIds).toHaveLength(1);
    const row = persistence.connection
      .prepare("SELECT citation_json FROM chat_citation_projection WHERE thread_id = ?")
      .get(created.thread.id) as { readonly citation_json: string } | undefined;
    expect(row).toBeDefined();
    const citation = JSON.parse(row!.citation_json) as {
      readonly backend: string;
      readonly sourceUrl: string;
      readonly snippetRef?: { readonly contentId: string };
    };
    expect(citation).toMatchObject({
      backend: "provider-native",
      sourceUrl: "https://octant.dev/reference",
    });
    expect(citation.snippetRef).toBeDefined();
    expect(persistence.readChatContent(citation.snippetRef!.contentId)?.body).toBe("A cited fact.");
  });

  it("persists interrupted when managed scratch setup fails after turn creation", async () => {
    const { service, dataDirectory } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Scratch recovery",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const scratchRoot = join(dataDirectory, "scratch", created.thread.id);
    rmSync(scratchRoot, { recursive: true, force: true });
    symlinkSync(dataDirectory, scratchRoot, "dir");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Do not remain queued",
      }),
    ).resolves.toMatchObject({ kind: "turn-created" });

    expect(service.read(created.thread.id).turns[0]?.attempts[0]?.outcome).toBe("interrupted");
  });

  it("advances replay across unrelated global journal pages", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Paged replay",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const replay = persistence.journal.replay.bind(persistence.journal);
    const targetEnvelope = replay({ afterSequence: 0 as GlobalSequence, limit: 100 }).find(
      (event) => event.eventName === "chat.thread-created@1",
    );
    if (targetEnvelope === undefined) throw new Error("Expected thread-created envelope.");
    const unrelatedPage = Array.from({ length: 100 }, (_, index) => ({
      ...targetEnvelope,
      globalSequence: (index + 1) as GlobalSequence,
      eventName: "fixture.unrelated@1",
    }));
    const replaySpy = vi.spyOn(persistence.journal, "replay").mockImplementation((cursor) => {
      if (replaySpy.mock.calls.length === 1) return unrelatedPage as never;
      if (cursor.afterSequence === 0) {
        throw new Error("global replay cursor did not advance");
      }
      return [{ ...targetEnvelope, globalSequence: 101 as GlobalSequence }] as never;
    });

    const first = await service.subscribe(created.thread.id, 0).next();
    expect(first.done).toBe(false);
    expect(first.value?.event.kind).toBe("thread-created");
    expect(replaySpy.mock.calls[1]?.[0].afterSequence).toBe(100);
  });

  it("keeps per-thread replay free of global settings and other-thread citations", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "citation",
                sessionId: input.sessionId,
                citationId: `citation-${input.sessionId}`,
                sourceTitle: "Scoped source",
                sourceUrl: `https://octant.dev/${input.sessionId}`,
              } as never);
              yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver });
    const first = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "First thread",
    });
    const second = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Second thread",
    });
    if (first.kind !== "thread-created" || second.kind !== "thread-created") {
      throw new Error("Expected thread-created results.");
    }
    await service.execute({
      kind: "send-chat-turn",
      threadId: first.thread.id,
      expectedVersion: first.thread.version,
      prompt: "First",
    });
    await service.execute({
      kind: "send-chat-turn",
      threadId: second.thread.id,
      expectedVersion: second.thread.version,
      prompt: "Second",
    });

    const frames = [];
    for await (const frame of service.subscribe(first.thread.id, 0)) frames.push(frame);
    const citations = frames.filter((frame) => frame.event.kind === "citation-recorded");
    expect(citations).toHaveLength(1);
    expect(citations[0]?.event).toMatchObject({
      kind: "citation-recorded",
      citation: { threadId: first.thread.id },
    });
    expect(frames.some((frame) => frame.event.kind === "settings-updated")).toBe(false);
  });

  it("blocks access after deletion is requested and purges managed content before deleted", async () => {
    const { service, persistence, dataDirectory } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Delete me",
    });
    expect(created.kind).toBe("thread-created");
    if (created.kind !== "thread-created") {
      throw new Error("Expected thread-created result.");
    }
    const threadId = created.thread.id;

    const turn = await service.execute({
      kind: "send-chat-turn",
      threadId,
      expectedVersion: created.thread.version,
      prompt: "persist me",
    });
    expect(turn.kind).toBe("turn-created");
    await until(() => service.read(threadId).turns[0]?.attempts[0]?.outcome === "completed", {
      timeoutMs: 10_000,
    });

    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ?",
        String(threadId),
      ),
    ).toBeGreaterThan(0);

    const beforeDelete = service.read(threadId);
    const deleted = await service.execute({
      kind: "delete-chat-thread",
      threadId,
      expectedVersion: beforeDelete.thread.version,
    });
    expect(deleted.kind).toBe("deleted");

    try {
      service.read(threadId);
      expect.unreachable("Deleted thread must not be readable.");
    } catch (error) {
      expect(error).toMatchObject({ failure: { category: "invalid" } });
    }

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId,
        expectedVersion: (beforeDelete.thread.version + 1) as AggregateVersion,
        prompt: "blocked",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    const scratchPath = join(dataDirectory, "scratch", String(threadId));
    expect(persistence.readChatThread(threadId)?.lifecycle).toBe("deleted");
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM chat_content_store WHERE thread_id = ?",
        String(threadId),
      ),
    ).toBe(0);
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM chat_turn_projection WHERE thread_id = ?",
        String(threadId),
      ),
    ).toBe(0);
    expect(() => accessSync(scratchPath, constants.F_OK)).toThrow();

    const purgedAgain = await service.finalizePendingDeletion(threadId);
    expect(purgedAgain.kind).toBe("deleted");
  });

  it("rejects retry for completed attempts", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retry policy",
    });
    expect(created.kind).toBe("thread-created");
    if (created.kind !== "thread-created") {
      throw new Error("Expected thread-created result.");
    }
    const turn = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "one",
    });
    expect(turn.kind).toBe("turn-created");
    if (turn.kind !== "turn-created") {
      throw new Error("Expected turn-created result.");
    }
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "completed",
      { timeoutMs: 10_000 },
    );
    const view = service.read(created.thread.id);
    const attempt = view.turns[0]!.attempts[0]!;
    expect(attempt.outcome).toBe("completed");
    try {
      await service.execute({
        kind: "retry-chat-turn",
        threadId: created.thread.id,
        expectedVersion: view.thread.version,
        turnId: turn.turn.id,
        attemptId: attempt.id,
      });
      expect.unreachable("retry should be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatServiceError);
      expect((error as ChatServiceError).failure.category).toBe("invalid");
      expect((error as ChatServiceError).failure.message).toContain("Cannot retry");
    }
  });

  it("retries failed attempts with a fresh provider session", async () => {
    const failQueue = Effect.runSync(Queue.unbounded<never>());
    const successQueue = Effect.runSync(Queue.unbounded<never>());
    const startedSessionIds: string[] = [];
    const sentToolNames: string[][] = [];
    let acquireCount = 0;
    const switchingDriver = {
      acquire: () => {
        acquireCount += 1;
        if (acquireCount === 1) {
          return Effect.succeed({
            events: Stream.fromQueue(failQueue),
            start: (startInput: { readonly sessionId: string }) =>
              Effect.sync(() => {
                startedSessionIds.push(startInput.sessionId);
                return { sessionId: startInput.sessionId };
              }),
            send: (sendInput: {
              readonly sessionId: string;
              readonly tools: ReadonlyArray<{ readonly name: string }>;
            }) =>
              Effect.gen(function* () {
                sentToolNames.push(sendInput.tools.map(({ name }) => name));
                yield* Queue.offer(failQueue, {
                  kind: "failed",
                  sessionId: sendInput.sessionId,
                  failure: { category: "provider-failed", message: "boom" },
                } as never);
              }),
            interrupt: () => Effect.void,
            stop: () => Effect.void,
            answerApproval: () => Effect.void,
            answerUserInput: () => Effect.void,
            answerTool: () => Effect.void,
          });
        }
        return Effect.succeed({
          events: Stream.fromQueue(successQueue),
          start: (startInput: { readonly sessionId: string }) =>
            Effect.sync(() => {
              startedSessionIds.push(startInput.sessionId);
              return { sessionId: startInput.sessionId };
            }),
          send: (sendInput: {
            readonly sessionId: string;
            readonly tools: ReadonlyArray<{ readonly name: string }>;
          }) =>
            Effect.gen(function* () {
              sentToolNames.push(sendInput.tools.map(({ name }) => name));
              yield* Queue.offer(successQueue, {
                kind: "text-delta",
                sessionId: sendInput.sessionId,
                text: "Retry succeeded",
              } as never);
              yield* Queue.offer(successQueue, {
                kind: "completed",
                sessionId: sendInput.sessionId,
              } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        });
      },
    } as unknown as ProviderDriver;
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-retry" },
    };
    const resolveExtensionSelectionContext = vi.fn(async (input) => ({
      selections: input.selections,
      entries: [],
      toolSet: {
        definitions: [
          {
            name: "build_project",
            inputSchema: { type: "object", properties: {}, required: [] },
          },
        ],
        execute: async () => ({ result: { status: "built" } }),
      },
    }));
    const { service, persistence } = openFixture({
      driver: switchingDriver,
      resolveExtensionSelectionContext,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retry handoff",
    });
    expect(created.kind).toBe("thread-created");
    if (created.kind !== "thread-created") {
      throw new Error("Expected thread-created result.");
    }

    const failedTurn = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "fail once",
      extensionSelections: [extensionSelection],
    });
    expect(failedTurn.kind).toBe("turn-created");
    const failedView = service.read(created.thread.id);
    expect(failedView.turns[0]?.attempts[0]?.outcome).toBe("failed");

    const view = failedView;
    const turn = view.turns[0]!;
    const failedAttempt = turn.attempts[0]!;
    const firstSession = failedAttempt.providerSessionId;
    expect(readDiagnosticsFailureIncident(persistence.connection, failedAttempt.id)).toEqual({
      correlationId: failedAttempt.id,
      domain: "provider",
      failureCode: "provider-failed",
      outcome: "failed",
      observedAt: now,
    });
    const failureEvents = persistence.journal
      .replay({ afterSequence: 0 as never, limit: 256 })
      .filter((event) => String(event.correlationId) === String(failedAttempt.id));
    const failedAttemptEvent = failureEvents.find(
      (event) => event.eventName === "chat.attempt-updated@1",
    );
    const supportIncident = failureEvents.find(
      (event) => event.eventName === "diagnostics.failure-incident-recorded@2",
    );
    expect(failedAttemptEvent).toMatchObject({ aggregateType: "chat-thread" });
    expect(supportIncident).toMatchObject({ aggregateType: "chat-thread" });
    expect(supportIncident?.globalSequence).toBe((failedAttemptEvent?.globalSequence ?? 0) + 1);

    const retried = await service.execute({
      kind: "retry-chat-turn",
      threadId: created.thread.id,
      expectedVersion: view.thread.version,
      turnId: turn.id,
      attemptId: failedAttempt.id,
    });
    expect(retried.kind).toBe("attempt-updated");
    if (retried.kind !== "attempt-updated") {
      throw new Error("Expected attempt-updated result.");
    }
    expect(retried.attempt.providerSessionId).not.toBe(firstSession);
    expect(acquireCount).toBe(2);
    expect(startedSessionIds).toHaveLength(2);
    expect(startedSessionIds[1]).not.toBe(startedSessionIds[0]);
    const afterRetry = service.read(created.thread.id);
    const latestAttempt = afterRetry.turns[0]!.attempts.at(-1)!;
    expect(latestAttempt.outcome).toBe("completed");
    expect(latestAttempt.providerSessionId).toBe(retried.attempt.providerSessionId);
    expect(resolveExtensionSelectionContext.mock.calls.map(([input]) => input.phase)).toEqual([
      "send",
      "provider-handoff",
      "replay",
      "provider-handoff",
    ]);
    expect(sentToolNames).toHaveLength(2);
    expect(sentToolNames[0]).toContain("build_project");
    expect(sentToolNames[1]).toContain("build_project");
    expect(afterRetry.turns[0]!.extensionSelections).toEqual([
      {
        ...extensionSelection,
        origin: { kind: "turn", reference: String(turn.id) },
      },
    ]);
  });

  it("records provider acquisition failure in the same failed-attempt transaction", async () => {
    const acquisitionFailure = {
      category: "unauthenticated" as const,
      message: "Provider credential was rejected.",
    };
    const { service, persistence } = openFixture({
      driver: {
        acquire: () => Effect.fail(acquisitionFailure),
      } as unknown as ProviderDriver,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Acquisition failure",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const accepted = await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Start the provider.",
    });
    if (accepted.kind !== "turn-created") throw new Error("Expected turn-created result.");

    await until(() => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "failed");
    const attempt = service.read(created.thread.id).turns[0]!.attempts[0]!;
    expect(readDiagnosticsFailureIncident(persistence.connection, attempt.id)).toEqual({
      correlationId: attempt.id,
      domain: "provider",
      failureCode: "unauthenticated",
      outcome: "failed",
      observedAt: now,
    });
    const failureEvents = persistence.journal
      .replay({ afterSequence: 0 as never, limit: 256 })
      .filter((event) => String(event.correlationId) === String(attempt.id));
    expect(failureEvents.map((event) => event.eventName)).toEqual([
      "chat.attempt-updated@1",
      "diagnostics.failure-incident-recorded@2",
    ]);
  });

  it("fails closed when retry content is missing before deletion", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Queue.offer(queue, {
              kind: "failed",
              sessionId: input.sessionId,
              failure: { category: "provider-failed", message: "fixture failure" },
            } as never),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service, persistence } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Missing retry content",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Do not erase me",
    });
    const view = service.read(created.thread.id);
    const turn = view.turns[0]!;
    const failedAttempt = turn.attempts[0]!;
    expect(failedAttempt.outcome).toBe("failed");
    persistence.connection
      .prepare("DELETE FROM chat_content_store WHERE content_id = ?")
      .run(String(turn.userMessageRef.contentId));

    await expect(
      service.execute({
        kind: "retry-chat-turn",
        threadId: created.thread.id,
        expectedVersion: view.thread.version,
        turnId: turn.id,
        attemptId: failedAttempt.id,
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    const turnRow = persistence.connection
      .prepare("SELECT turn_json FROM chat_turn_projection WHERE turn_id = ?")
      .get(String(turn.id)) as { readonly turn_json: string };
    expect(JSON.parse(turnRow.turn_json).attempts).toHaveLength(1);
  });

  it("fails oversized provider output without persisting unreadable transcript content", async () => {
    const oversized = "x".repeat(1_000_001);
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "text-delta",
                sessionId: input.sessionId,
                text: oversized,
              } as never);
              yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service, persistence } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Oversized output",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "grow too large",
    });

    const attempt = service.read(created.thread.id).turns[0]!.attempts[0]!;
    expect(attempt.outcome).not.toBe("completed");
    expect(attempt.responseRefs).toHaveLength(0);
    expect(
      countRows(persistence.connection, "SELECT COUNT(*) AS count FROM chat_content_store"),
    ).toBe(1);
  });

  it("rejects cross-thread attachments before writing turn history", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Attachment policy",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const other = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Other thread",
    });
    if (other.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const upload = await service.uploadAttachment({
      threadId: other.thread.id,
      attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000099"),
      displayName: "other.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("other"),
    });

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "blocked",
        attachmentIds: [upload.id],
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(service.read(created.thread.id).turns).toHaveLength(0);
  });

  it("rejects cross-thread attachment uploads before staging", async () => {
    const { service } = openFixture();
    const owner = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Owner thread",
    });
    if (owner.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const other = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Other thread",
    });
    if (other.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const attachmentId = decodeChatAttachmentId("84000000-0000-4000-8000-000000000099");
    await service.uploadAttachment({
      threadId: owner.thread.id,
      attachmentId,
      displayName: "owner.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("owner"),
    });

    await expect(
      service.uploadAttachment({
        threadId: other.thread.id,
        attachmentId,
        displayName: "stolen.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("stolen"),
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("rejects attachment uploads to archived threads before journaling", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Archived",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const archived = await service.execute({
      kind: "change-chat-thread-lifecycle",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      lifecycle: "archived",
    });
    if (archived.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
    const before = countRows(persistence.connection, "SELECT COUNT(*) AS count FROM event_journal");

    await expect(
      service.uploadAttachment({
        threadId: created.thread.id,
        attachmentId: decodeChatAttachmentId("84000000-0000-4000-8000-000000000089"),
        displayName: "archived.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("archived"),
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(countRows(persistence.connection, "SELECT COUNT(*) AS count FROM event_journal")).toBe(
      before,
    );
  });

  it("restores an archived thread to active so Chat can resume", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Restorable",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const archived = await service.execute({
      kind: "change-chat-thread-lifecycle",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      lifecycle: "archived",
    });
    if (archived.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

    await expect(
      service.execute({
        kind: "change-chat-thread-lifecycle",
        threadId: created.thread.id,
        expectedVersion: archived.thread.version,
        lifecycle: "active",
      }),
    ).resolves.toMatchObject({ kind: "thread-updated", thread: { lifecycle: "active" } });
  });

  it("allows explicit provider-native research without an app executor", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Provider-native policy",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const configured = await service.execute({
      kind: "change-chat-research",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      researchEnabled: true,
      researchRouting: "provider-native",
    });
    if (configured.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: configured.thread.version,
        prompt: "research natively",
      }),
    ).resolves.toMatchObject({ kind: "turn-created" });
    expect(service.read(created.thread.id).turns[0]?.attempts[0]?.outcome).toBe("completed");
  });

  it("rejects explicit SearXNG routing when SearXNG is not configured", async () => {
    const { service } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Research policy",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const configured = await service.execute({
      kind: "change-chat-research",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      researchEnabled: true,
      researchRouting: "searxng",
    });
    expect(configured.kind).toBe("thread-updated");
    if (configured.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
    await service.execute({
      kind: "update-chat-settings",
      expectedVersion: 1,
      defaultProviderInstanceId: ids.provider,
      defaultModelId: "model-a",
      defaultResearchEnabled: true,
      defaultResearchRouting: "automatic",
      defaultPersonalityInstructions: "Be calm.",
    });

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: configured.thread.version,
        prompt: "blocked",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(service.read(created.thread.id).turns).toHaveLength(0);
  });

  it("rejects automatic research when no configured backend is compatible", async () => {
    const supported = probeFixture();
    const { service } = openFixture({
      probe: probeFixture({
        capabilities: {
          ...supported.capabilities,
          appManagedTools: "unsupported",
          nativeWebResearch: "unsupported",
        },
      }),
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Automatic research policy",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "blocked",
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });
    expect(service.read(created.thread.id).turns).toHaveLength(0);
  });

  it("uses a conservative output reserve when runtime model facts omit max output", async () => {
    const probe = probeFixture();
    const { service } = openFixture({
      probe,
      contextFacts: {
        observeModelLimits: () =>
          Effect.succeed([
            {
              providerInstanceId: probe.instanceId,
              modelId: probe.models[0]!.id,
              contextWindow: 8_000,
              reasoning: "included",
              source: "runtime-reported",
              confidence: "high",
              observedAt: probe.observedAt,
            },
          ]),
        observeServiceLimits: () =>
          Effect.succeed(
            decodeProviderServiceLimits({
              providerInstanceId: probe.instanceId,
              scope: "provider-instance",
              requests: { status: "unavailable" },
              tokens: { status: "unavailable" },
              concurrency: { status: "unavailable" },
              retry: { status: "inactive" },
              quota: "unknown",
              source: "runtime-reported",
              confidence: "medium",
              updatedAt: probe.observedAt,
            }),
          ),
      },
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Conservative model limits",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "use conservative limits",
      }),
    ).resolves.toMatchObject({ kind: "turn-created" });
  });

  it("compacts the conversation a send drops to fit and sends the summary in its place", async () => {
    const probe = probeFixture();
    const sent: Array<SentTurn> = [];
    const fixture = openFixture({
      probe,
      driver: {
        ...compactionDriver(sent),
        contextFacts: compactionContextFacts(probe),
      } as unknown as ProviderDriver,
    });
    const { service, contextHarness, persistence } = fixture;
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Long conversation",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    let version = created.thread.version;
    for (let turn = 0; turn < 4; turn += 1) {
      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: version,
        prompt: `Turn ${turn}: ${"detail ".repeat(228)}`.trim(),
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(
        () =>
          service
            .read(created.thread.id)
            .turns.at(-1)
            ?.attempts.some((attempt) => attempt.outcome === "completed") === true,
      );
      await untilThreadSlotReleased(fixture);
      version = service.read(created.thread.id).thread.version;
    }

    // The third send no longer fits, so its plan drops the oldest conversation.
    // That material has to come back as a journaled summary the provider is
    // actually sent, not simply vanish from the request.
    const snapshot = contextHarness.inspect(
      decodeContextSubjectRef({ aggregateType: "chat-thread", aggregateId: created.thread.id }),
    );
    const summarized = snapshot.next.plan.entries.filter((entry) => entry.state === "summarized");
    expect(summarized.length).toBeGreaterThan(0);
    expect(snapshot.summaries.length).toBeGreaterThan(0);
    const summary = snapshot.summaries.at(-1)!;
    const summaryContent = contextHarness.summaryContent(summary.id);
    expect(summaryContent).toMatch(/^Compacted: Turn \d/);
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM event_journal WHERE event_name = 'context.summary-created@1'",
      ),
    ).toBeGreaterThan(0);
    // The provider is sent the summary, and is no longer sent the conversation
    // it stands for — the transcript still holds every original message.
    expect(sent.at(-1)?.context).toContainEqual({
      kind: "conversation-summary",
      text: summaryContent,
    });
    expect(sent.at(-1)?.context?.some((block) => block.text.startsWith("Turn 0:"))).toBe(false);
    expect(summarized.every((entry) => entry.reason === "summarized")).toBe(true);
    // Exactly one live summary: a summary that was itself compacted is
    // replaced, never stacked alongside its successor.
    expect(
      sent.at(-1)?.context?.filter((block) => block.kind === "conversation-summary"),
    ).toHaveLength(1);
    // The summary stands where the conversation it replaced did: ahead of the
    // turns that survived, and behind the instructions that frame them. The
    // compacted manifest appends it last, so nothing about rebuilding the
    // request from that manifest's plan would put it here on its own.
    const kinds = (sent.at(-1)?.context ?? []).map((block) => block.kind);
    expect(kinds.indexOf("conversation-summary")).toBe(kinds.indexOf("instructions") + 1);
    expect(kinds.indexOf("conversation-summary")).toBeLessThan(kinds.indexOf("assistant-message"));
    // What reached the provider is what the turn was journaled as sending.
    expect(dispatchedConversationKeys(sent.at(-1)?.context)).toEqual(
      plannedConversationKeys(snapshot, (summaryId) => contextHarness.summaryContent(summaryId)),
    );
    expect(service.read(created.thread.id).turns).toHaveLength(4);

    // Permanent deletion must leave no text derived from this thread's
    // messages behind. The summary was generated from the conversation, so it
    // is thread content: the journal keeps the summary's identity and
    // provenance, and the text itself has to be purged with everything else.
    const beforeDelete = service.read(created.thread.id);
    await expect(
      service.execute({
        kind: "delete-chat-thread",
        threadId: created.thread.id,
        expectedVersion: beforeDelete.thread.version,
      }),
    ).resolves.toMatchObject({ kind: "deleted" });

    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM event_journal WHERE payload_json LIKE '%Compacted: Turn%'",
      ),
    ).toBe(0);
    expect(contextHarness.summaryContent(summary.id)).toBeUndefined();
    // The tombstone and the summary's own identity stay: only content goes.
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM event_journal WHERE event_name = 'context.summary-created@1'",
      ),
    ).toBeGreaterThan(0);
  });

  it("leaves out the summary the compacted plan priced out of the request", async () => {
    const probe = probeFixture();
    const sent: Array<SentTurn> = [];
    const fixture = openFixture({
      probe,
      driver: {
        // A summary the provider reports as nearly as large as the material it
        // replaced: it is journaled, and the replan then has to drop it to fit.
        ...compactionDriver(sent, { maintenanceOutputTokens: 320 }),
        contextFacts: compactionContextFacts(probe),
      } as unknown as ProviderDriver,
    });
    const { service, contextHarness } = fixture;
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Costly summary",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    let version = created.thread.version;
    for (let turn = 0; turn < 4; turn += 1) {
      const accepted = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: version,
        prompt: `Turn ${turn}: ${"detail ".repeat(228)}`.trim(),
      });
      if (accepted.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(
        () =>
          service
            .read(created.thread.id)
            .turns.at(-1)
            ?.attempts.some((attempt) => attempt.outcome === "completed") === true,
      );
      await untilThreadSlotReleased(fixture);
      version = service.read(created.thread.id).thread.version;
    }

    const snapshot = contextHarness.inspect(
      decodeContextSubjectRef({ aggregateType: "chat-thread", aggregateId: created.thread.id }),
    );
    const summary = snapshot.summaries.at(-1)!;
    const summaryEntry = snapshot.next.manifest.entries.find(
      (entry) => entry.source.kind === "summary" && entry.source.referenceId === String(summary.id),
    );
    const plannedSummary = snapshot.next.plan.entries.find(
      (entry) => String(entry.entryId) === String(summaryEntry?.id),
    );
    // The premise: maintenance ran and journaled a summary this turn's replan
    // could not afford to send.
    expect(plannedSummary).toMatchObject({ state: "omitted", reason: "omitted-to-fit" });
    // So the turn sends no summary. The material it stands for is journaled and
    // reusable by a later turn, and the model is told nothing that this turn's
    // plan does not account for — a request that carried it anyway would exceed
    // the very budget compaction was invoked to respect.
    expect(sent.at(-1)?.prompt.startsWith("Turn 3:")).toBe(true);
    expect(dispatchedConversationKeys(sent.at(-1)?.context)).toEqual(
      plannedConversationKeys(snapshot, (summaryId) => contextHarness.summaryContent(summaryId)),
    );
    expect(sent.at(-1)?.context?.some((block) => block.kind === "conversation-summary")).toBe(
      false,
    );
  });

  it("sends only the conversation the compacted plan kept", async () => {
    const probe = probeFixture();
    const sent: Array<SentTurn> = [];
    const fixture = openFixture({
      probe,
      driver: {
        ...compactionDriver(sent),
        contextFacts: compactionContextFacts(probe),
      } as unknown as ProviderDriver,
    });
    const { service, contextHarness } = fixture;
    // Replanning against the compacted manifest is what decides this turn's
    // request, and the chat planner's own summary entry is the cheapest thing
    // in it, so today the summary is the only entry that replan ever drops.
    // The dispatch may not rely on that: it is journaled under the new plan, so
    // every entry the new plan omits has to leave the request with it.
    const maintain = contextHarness.maintainContext.bind(contextHarness);
    let droppedLabel: string | undefined;
    vi.spyOn(contextHarness, "maintainContext").mockImplementation(async (input) => {
      droppedLabel = undefined;
      const maintained = await maintain(input);
      if (maintained.kind !== "summary-created") return maintained;
      const entryById = new Map(
        maintained.snapshot.next.manifest.entries.map((entry) => [String(entry.id), entry]),
      );
      const dropped = maintained.snapshot.next.plan.entries.find((entry) => {
        const manifestEntry = entryById.get(String(entry.entryId));
        return (
          entry.state === "included" &&
          manifestEntry?.category === "conversation" &&
          manifestEntry.source.kind === "message"
        );
      });
      if (dropped === undefined) return maintained;
      droppedLabel = entryById.get(String(dropped.entryId))?.label;
      const plan = decodeContextPlan({
        ...maintained.snapshot.next.plan,
        entries: maintained.snapshot.next.plan.entries.map((entry) =>
          entry === dropped
            ? {
                entryId: entry.entryId,
                state: "omitted",
                tokens: entry.tokens,
                reason: "omitted-to-fit",
              }
            : entry,
        ),
      });
      return {
        ...maintained,
        snapshot: { ...maintained.snapshot, next: { ...maintained.snapshot.next, plan } },
      };
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Replanned away",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    let version = created.thread.version;
    for (let turn = 0; turn < 4; turn += 1) {
      const accepted = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: version,
        prompt: `Turn ${turn}: ${"detail ".repeat(228)}`.trim(),
      });
      if (accepted.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(
        () =>
          service
            .read(created.thread.id)
            .turns.at(-1)
            ?.attempts.some((attempt) => attempt.outcome === "completed") === true,
      );
      await untilThreadSlotReleased(fixture);
      version = service.read(created.thread.id).thread.version;
    }

    expect(droppedLabel).toBeDefined();
    expect(sent.at(-1)?.prompt.startsWith("Turn 3:")).toBe(true);
    expect(sent.at(-1)?.context?.filter((block) => block.text.startsWith(droppedLabel!))).toEqual(
      [],
    );
    // The summary the same plan kept is still sent, so this is the plan being
    // followed rather than the conversation being dropped wholesale.
    expect(sent.at(-1)?.context?.some((block) => block.kind === "conversation-summary")).toBe(true);
  });

  it("still sends a turn whose maintenance request never answers", async () => {
    const probe = probeFixture();
    const sent: Array<SentTurn> = [];
    const fixture = openFixture({
      probe,
      // Maintenance is a child of the turn and the turn awaits it, so a
      // maintenance provider that never answers must not hold the user's send.
      // A wedged provider does not answer its teardown either, and teardown
      // runs in a finalizer the deadline cannot interrupt, so the stop is
      // wedged too: without its own bound it holds the send just as long.
      contextMaintenanceTimeoutMs: 100,
      contextMaintenanceShutdownTimeoutMs: 100,
      driver: {
        ...compactionDriver(sent, { wedgeMaintenanceSend: true, wedgeMaintenanceStop: true }),
        contextFacts: compactionContextFacts(probe),
      } as unknown as ProviderDriver,
    });
    const { service, contextHarness, persistence, capacityScheduler } = fixture;
    const maintenanceReservationIds: string[] = [];
    const submit = capacityScheduler.submit.bind(capacityScheduler);
    vi.spyOn(capacityScheduler, "submit").mockImplementation((request) => {
      if (request.origin === "subagent") {
        maintenanceReservationIds.push(String(request.reservationId));
      }
      return submit(request);
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Wedged maintenance",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    let version = created.thread.version;
    for (let turn = 0; turn < 2; turn += 1) {
      const accepted = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: version,
        prompt: `Turn ${turn}: ${"detail ".repeat(228)}`.trim(),
      });
      if (accepted.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(
        () =>
          service
            .read(created.thread.id)
            .turns.at(-1)
            ?.attempts.some((attempt) => attempt.outcome === "completed") === true,
      );
      await untilThreadSlotReleased(fixture);
      version = service.read(created.thread.id).thread.version;
    }

    // The second send outgrew the window, so maintenance was attempted — and
    // the send still reached the provider on the deterministic reduction the
    // planner had already made, with nothing journaled as compacted.
    expect(sent.some((request) => request.prompt.startsWith(MAINTENANCE_PROMPT_PREFIX))).toBe(true);
    expect(sent.at(-1)?.prompt.startsWith("Turn 1:")).toBe(true);
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM event_journal WHERE event_name = 'context.summary-created@1'",
      ),
    ).toBe(0);
    expect(sent.at(-1)?.context?.some((block) => block.kind === "conversation-summary")).toBe(
      false,
    );
    const snapshot = contextHarness.inspect(
      decodeContextSubjectRef({ aggregateType: "chat-thread", aggregateId: created.thread.id }),
    );
    expect(
      snapshot.next.plan.entries.some(
        (entry) => entry.state === "omitted" && entry.reason === "omitted-to-fit",
      ),
    ).toBe(true);
    // Every expired maintenance request reached a terminal state rather than
    // staying running until the host restarts. The provider was never confirmed
    // to have stopped, so `ambiguous` — not `reconciled` — is the honest one.
    expect(maintenanceReservationIds.length).toBeGreaterThan(0);
    for (const reservationId of maintenanceReservationIds) {
      expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
    }
  });

  it("does not reuse a summary that covers the turns an edit supersedes", async () => {
    const probe = probeFixture();
    const sent: Array<SentTurn> = [];
    const fixture = openFixture({
      probe,
      driver: {
        ...compactionDriver(sent),
        contextFacts: compactionContextFacts(probe),
      } as unknown as ProviderDriver,
    });
    const { service, persistence } = fixture;
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Edited after compaction",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    let version = created.thread.version;
    for (let turn = 0; turn < 4; turn += 1) {
      const accepted = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: version,
        prompt: `Turn ${turn}: ${"detail ".repeat(228)}`.trim(),
      });
      if (accepted.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(
        () =>
          service
            .read(created.thread.id)
            .turns.at(-1)
            ?.attempts.some((attempt) => attempt.outcome === "completed") === true,
      );
      await untilThreadSlotReleased(fixture);
      version = service.read(created.thread.id).thread.version;
    }
    expect(
      countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM event_journal WHERE event_name = 'context.summary-created@1'",
      ),
    ).toBeGreaterThan(0);

    // Revising the second turn re-runs the thread from before it, so turn 1 and
    // everything after it is superseded conversation.
    const edited = service.read(created.thread.id).turns[1]!;
    const before = sent.length;
    const revision = await service.execute({
      kind: "edit-chat-turn",
      threadId: created.thread.id,
      turnId: edited.id,
      expectedVersion: version,
      prompt: "Revised second turn",
    });
    if (revision.kind !== "turn-created") throw new Error("Expected turn-created result.");
    await until(
      () =>
        service
          .read(created.thread.id)
          .turns.at(-1)
          ?.attempts.some((attempt) => attempt.outcome === "completed") === true,
    );

    // A summary journaled before the edit stands for turn 1 and later, so
    // reusing it would put back exactly the conversation the edit excludes —
    // whether it covers that material wholly or only in part.
    const dispatched = sent
      .slice(before)
      .filter((request) => !request.prompt.startsWith(MAINTENANCE_PROMPT_PREFIX))
      .at(-1);
    expect(dispatched?.prompt).toBe("Revised second turn");
    expect(dispatched?.context?.filter((block) => /Turn [123]/.test(block.text))).toEqual([]);
    // Turn 0 still precedes the revision, so it is sent rather than dropped.
    expect(dispatched?.context?.some((block) => block.text.includes("Turn 0"))).toBe(true);
  });

  it("uses reviewed fallback limits for ready models without context metadata", async () => {
    const probe = probeFixture({
      models: [
        {
          id: "model-a" as never,
          displayName: "Metadata-light Model",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
          source: "discovered",
          verification: "verified",
        },
      ],
    });
    const { service } = openFixture({ probe });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Metadata-light model",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Use the fallback context limits.",
      }),
    ).resolves.toMatchObject({ kind: "turn-created" });
  });

  it("fails closed before planning when the saved model disappears from a ready provider", async () => {
    const { service, contextHarness } = openFixture({ probe: probeFixture({ models: [] }) });
    const planTurn = vi.spyOn(contextHarness, "planTurn");
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Missing model",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Do not accept this model.",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(planTurn).not.toHaveBeenCalled();
    expect(service.read(created.thread.id).turns).toHaveLength(0);
  });

  it("continues a conversation on the chosen fallback provider when its own provider drops the model", async () => {
    const fallbackProvider = "84000000-0000-4000-8000-000000000007";
    const { service } = openFixture({
      probe: probeFixture({ models: [] }),
      probeFor: (providerInstanceId) =>
        providerInstanceId === fallbackProvider
          ? probeFixture({ instanceId: decodeProviderInstanceId(fallbackProvider) })
          : undefined,
      settings: {
        ...settings(),
        providerFallback: { providerInstanceId: fallbackProvider, modelId: "model-a" },
      } as ChatSettings,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Fallback route",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Keep this conversation alive.",
      }),
    ).resolves.toMatchObject({ kind: "turn-created" });

    const view = service.read(created.thread.id);
    expect(view.turns[0]?.attempts[0]?.providerInstanceId).toBe(fallbackProvider);
    expect(view.thread.providerInstanceId).toBe(ids.provider);
  });

  it("continues a conversation on the chosen fallback provider when its own driver cannot be built", async () => {
    const fallbackProvider = "84000000-0000-4000-8000-000000000007";
    const { service } = openFixture({
      probeFor: (providerInstanceId) =>
        providerInstanceId === fallbackProvider
          ? probeFixture({ instanceId: decodeProviderInstanceId(fallbackProvider) })
          : undefined,
      refuseDriverFor: (providerInstanceId) =>
        providerInstanceId === ids.provider
          ? new Error("Provider driver configuration is invalid.")
          : undefined,
      settings: {
        ...settings(),
        providerFallback: { providerInstanceId: fallbackProvider, modelId: "model-a" },
      } as ChatSettings,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Unusable configuration",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Keep going on the fallback.",
      }),
    ).resolves.toMatchObject({ kind: "turn-created" });
    expect(service.read(created.thread.id).turns[0]?.attempts[0]?.providerInstanceId).toBe(
      fallbackProvider,
    );
  });

  it("keeps a researching conversation on its own provider when the fallback has no research backend", async () => {
    const fallbackProvider = "84000000-0000-4000-8000-000000000007";
    const { service } = openFixture({
      probe: probeFixture({ models: [] }),
      probeFor: (providerInstanceId) =>
        providerInstanceId === fallbackProvider
          ? probeFixture({
              instanceId: decodeProviderInstanceId(fallbackProvider),
              capabilities: {
                ...probeFixture().capabilities,
                nativeWebResearch: "unsupported",
                appManagedTools: "unsupported",
              },
            })
          : undefined,
      settings: {
        ...settings(),
        providerFallback: { providerInstanceId: fallbackProvider, modelId: "model-a" },
      } as ChatSettings,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Researching thread",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const configured = await service.execute({
      kind: "change-chat-research",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      researchEnabled: true,
      researchRouting: "automatic",
    });
    if (configured.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: configured.thread.version,
        prompt: "Research this.",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(service.read(created.thread.id).turns).toHaveLength(0);
  });

  it("keeps a conversation on its own provider when the chosen fallback cannot serve the same turn", async () => {
    const fallbackProvider = "84000000-0000-4000-8000-000000000007";
    const { service } = openFixture({
      probe: probeFixture({ models: [] }),
      probeFor: (providerInstanceId) =>
        providerInstanceId === fallbackProvider
          ? probeFixture({
              instanceId: decodeProviderInstanceId(fallbackProvider),
              readiness: "unauthenticated",
            })
          : undefined,
      settings: {
        ...settings(),
        providerFallback: { providerInstanceId: fallbackProvider, modelId: "model-a" },
      } as ChatSettings,
    });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Unusable fallback",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await expect(
      service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Report the real reason.",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(service.read(created.thread.id).turns).toHaveLength(0);
  });

  it("offers Zen-only tools to the exact authenticated assistant thread and zero ordinary threads", async () => {
    const windowId = "84000000-0000-4000-8000-000000000099" as WindowId;
    let assistantThreadId: string | undefined;
    const resolveAppManagedTools = vi.fn(
      (input: { readonly windowId: WindowId; readonly thread: ChatThread }) =>
        input.windowId === windowId && String(input.thread.id) === assistantThreadId
          ? {
              definitions: [
                {
                  name: "octant_zen_search_threads",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
              ],
              execute: async () => ({ result: { status: "ok" } }),
            }
          : undefined,
    );
    const { service, fakeDriver } = openFixture({ resolveAppManagedTools });
    const ordinary = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Ordinary chat",
    });
    const assistant = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Navigator",
    });
    if (ordinary.kind !== "thread-created" || assistant.kind !== "thread-created") {
      throw new Error("Expected thread-created results.");
    }
    assistantThreadId = String(assistant.thread.id);

    await (
      service.execute as never as (
        command: unknown,
        context: { readonly windowId: WindowId },
      ) => Promise<unknown>
    )(
      {
        kind: "send-chat-turn",
        threadId: ordinary.thread.id,
        expectedVersion: ordinary.thread.version,
        prompt: "ordinary",
      },
      { windowId },
    );
    await (
      service.execute as never as (
        command: unknown,
        context: { readonly windowId: WindowId },
      ) => Promise<unknown>
    )(
      {
        kind: "send-chat-turn",
        threadId: assistant.thread.id,
        expectedVersion: assistant.thread.version,
        prompt: "assistant",
      },
      { windowId },
    );

    expect(fakeDriver.sentTurns[0]?.tools.map((tool) => tool.name)).not.toContain(
      "octant_zen_search_threads",
    );
    expect(fakeDriver.sentTurns[1]?.tools.map((tool) => tool.name)).toContain(
      "octant_zen_search_threads",
    );
    expect(resolveAppManagedTools).toHaveBeenCalledTimes(2);
  });

  it("offers the Chat dialogue tool only for explicit mentions and never at coordination depth", async () => {
    const windowId = "84000000-0000-4000-8000-000000000098" as WindowId;
    const targetThreadId = "85000000-0000-4000-8000-000000000001" as never;
    const resolveAppManagedTools = vi.fn(
      (input: {
        readonly windowId: WindowId;
        readonly thread: ChatThread;
        readonly threadMentionIds?: ReadonlyArray<unknown>;
        readonly coordinationDepth?: number;
      }) =>
        input.coordinationDepth !== undefined || input.threadMentionIds?.length !== 1
          ? undefined
          : {
              definitions: [
                {
                  name: "octant_thread_message",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
              ],
              execute: async () => ({ result: { status: "completed" } }),
            },
    );
    const { service, fakeDriver } = openFixture({ resolveAppManagedTools });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Coordinator",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    await (
      service.execute as never as (
        command: unknown,
        context: { readonly windowId: WindowId; readonly coordinationDepth?: number },
      ) => Promise<unknown>
    )(
      {
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        prompt: "Ask the mentioned thread to investigate this.",
        threadMentionIds: [targetThreadId],
      },
      { windowId },
    );

    expect(fakeDriver.sentTurns[0]?.tools.map((tool) => tool.name)).toContain(
      "octant_thread_message",
    );
    expect(resolveAppManagedTools).toHaveBeenCalledWith(
      expect.objectContaining({ threadMentionIds: [targetThreadId] }),
    );
  });

  it("reconciles a repeated Chat submission instead of creating a duplicate turn", async () => {
    const { service, fakeDriver } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retry-safe Chat",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const command = {
      kind: "send-chat-turn" as const,
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      submissionId: "86000000-0000-4000-8000-000000000001" as never,
      prompt: "Do not create this twice.",
    };

    const first = await service.execute(command);
    const second = await service.execute(command);

    if (first.kind !== "turn-created" || second.kind !== "turn-created") {
      throw new Error("Expected both submissions to resolve to the created turn.");
    }
    expect(second.turn.id).toBe(first.turn.id);
    expect(fakeDriver.sentTurns).toHaveLength(1);
  });

  it("does not create a second turn for a submission whose only attempt failed", async () => {
    // Reconciliation used to only look at turns with a queued/streaming/
    // waiting/completed attempt, so a turn whose lone attempt already
    // failed was invisible to the lookup. A retried `send-chat-turn` with
    // the same submissionId then fell through to turn creation and minted
    // a second turn sharing that submission's identity.
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Queue.offer(queue, {
              kind: "failed",
              sessionId: input.sessionId,
              failure: { category: "provider-failed", message: "fixture failure" },
            } as never),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Retry after failure",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const command = {
      kind: "send-chat-turn" as const,
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      submissionId: "86000000-0000-4000-8000-000000000002" as never,
      prompt: "Do not duplicate this failed submission.",
    };

    const first = await service.execute(command);
    if (first.kind !== "turn-created") throw new Error("Expected turn-created result.");
    expect(service.read(created.thread.id).turns[0]?.attempts[0]?.outcome).toBe("failed");

    const second = await service.execute(command);

    if (second.kind !== "turn-created") throw new Error("Expected turn-created result.");
    expect(second.turn.id).toBe(first.turn.id);
    expect(service.read(created.thread.id).turns).toHaveLength(1);
  });

  describe("multi-model pool routing", () => {
    // The fixture's single synthetic driver/probe is stamped for one
    // provider instance (`ids.provider`), so candidates here vary by model
    // id rather than provider instance id — a second candidate on the SAME
    // provider instance with a distinct model, which the dual-model probe
    // below advertises as available. This keeps the fixture's context/model
    // limit plumbing (which requires a single consistent provider instance
    // id per turn) satisfied while still exercising real requested/fallback
    // routing between two distinct pool candidates.
    const fallbackModelId = "model-b";

    function dualModelProbe(): ProviderProbeResult {
      return probeFixture({
        models: [
          {
            id: "model-a",
            displayName: "Model A",
            contextLimit: 8_000,
            reasoning: "supported",
            inputModalities: ["text", "document"],
            // Only the requested candidate declares an option, so a turn that
            // falls back must not carry this model's settings with it.
            options: [
              {
                id: "effort",
                displayName: "Effort",
                kind: "selection" as const,
                values: ["low", "high"] as [string, ...string[]],
              },
            ],
            source: "discovered",
            verification: "verified",
          },
          {
            id: fallbackModelId,
            displayName: "Model B",
            contextLimit: 8_000,
            reasoning: "supported",
            inputModalities: ["text", "document"],
            options: [],
            source: "discovered",
            verification: "verified",
          },
        ],
      } as unknown as Partial<ProviderProbeResult>);
    }

    function poolCandidate(modelId = "model-a"): MultiModelPoolCandidate {
      return {
        hostId: "local" as HostId,
        providerInstanceId: ids.provider,
        modelId,
      } as MultiModelPoolCandidate;
    }

    function poolFacts(
      target: MultiModelPoolCandidate,
      overrides: Partial<MultiModelCandidateRuntimeFacts> = {},
    ): MultiModelCandidateRuntimeFacts {
      return {
        candidate: target,
        routingVendorId: "openai" as MultiModelRoutingVendorId,
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

    function pool(overrides: Partial<MultiModelPool> = {}): MultiModelPool {
      return {
        candidates: [poolCandidate("model-a"), poolCandidate(fallbackModelId)],
        mixedVendorEnabled: true,
        fallbackAllowed: true,
        higherCostFallbackAllowed: false,
        ...overrides,
      } as MultiModelPool;
    }

    async function threadWithPool(
      gatherMultiModelRuntimeFacts: (input: {
        readonly pool: MultiModelPool;
        readonly mode: import("@octant/contracts/modes").OctantMode;
        readonly activeHostId: HostId;
      }) => Promise<ReadonlyArray<MultiModelCandidateRuntimeFacts>>,
      poolOverride: Partial<MultiModelPool> = {},
      fixtureOverrides: Parameters<typeof openFixture>[0] = {},
    ) {
      const fixture = openFixture({
        probe: dualModelProbe(),
        ...fixtureOverrides,
        gatherMultiModelRuntimeFacts,
      });
      const created = await fixture.service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Pooled thread",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
      const updated = await fixture.service.execute({
        kind: "select-chat-multi-model-pool",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        pool: pool(poolOverride),
      });
      if (updated.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
      return { ...fixture, thread: updated.thread };
    }

    it("persists exactly one selected route decision for the requested candidate before provider execution starts", async () => {
      const { service, thread } = await threadWithPool(async ({ pool: p }) =>
        p.candidates.map((candidate) => poolFacts(candidate)),
      );
      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: thread.id,
        expectedVersion: thread.version,
        prompt: "Hello pool",
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(() => service.read(thread.id).turns[0]?.attempts[0]?.outcome === "completed");

      const view = service.read(thread.id);
      expect(view.turns[0]?.attempts[0]?.providerInstanceId).toBe(ids.provider);
      expect(view.routeDecisions).toHaveLength(1);
      expect(String(view.routeDecisions?.[0]?.turnId)).toBe(String(sent.turn.id));
      expect(view.routeDecisions?.[0]?.decision.kind).toBe("selected");
      if (view.routeDecisions?.[0]?.decision.kind === "selected") {
        expect(view.routeDecisions[0].decision.selectionKind).toBe("requested");
      }
    });

    it("selects only an explicitly permitted fallback when the requested candidate is unavailable, and execution runs on that fallback", async () => {
      const { service, thread, fakeDriver } = await threadWithPool(async ({ pool: p }) =>
        p.candidates.map((candidate, index) =>
          poolFacts(
            candidate,
            index === 0 ? { readiness: "unavailable", costRank: 1 } : { costRank: 1 },
          ),
        ),
      );
      // Settings chosen for the requested model. The fallback model declares
      // no such option, so it must run on provider defaults instead.
      const withEffort = await service.execute({
        kind: "change-chat-provider",
        threadId: thread.id,
        expectedVersion: thread.version,
        providerInstanceId: ids.provider,
        modelId: "model-a",
        modelOptionValues: { effort: "high" },
      });
      if (withEffort.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: thread.id,
        expectedVersion: withEffort.thread.version,
        prompt: "Hello fallback",
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(() => service.read(thread.id).turns[0]?.attempts[0]?.outcome === "completed");

      const view = service.read(thread.id);
      expect(view.turns[0]?.attempts[0]?.modelId).toBe(fallbackModelId);
      expect(view.routeDecisions?.[0]?.decision.kind).toBe("selected");
      if (view.routeDecisions?.[0]?.decision.kind === "selected") {
        expect(view.routeDecisions[0].decision.selectionKind).toBe("fallback");
        expect(view.routeDecisions[0].decision.selectedCandidate.modelId).toBe(fallbackModelId);
      }
      expect(fakeDriver.sentTurns).toHaveLength(1);
      expect(fakeDriver.startInputs[0]).toMatchObject({ modelId: fallbackModelId });
      expect(fakeDriver.startInputs[0]).not.toHaveProperty("modelOptionValues");
    });

    it("rejects the command with a durable, actionable Waiting decision and never starts provider execution when no candidate is eligible", async () => {
      const { service, thread, fakeDriver } = await threadWithPool(async ({ pool: p }) =>
        p.candidates.map((candidate) => poolFacts(candidate, { readiness: "unavailable" })),
      );

      await expect(
        service.execute({
          kind: "send-chat-turn",
          threadId: thread.id,
          expectedVersion: thread.version,
          prompt: "Hello waiting",
        }),
      ).rejects.toMatchObject({ failure: { category: "waiting" } });

      const view = service.read(thread.id);
      expect(view.turns).toHaveLength(0);
      expect(view.routeDecisions).toHaveLength(1);
      expect(view.routeDecisions?.[0]?.decision.kind).toBe("waiting");
      if (view.routeDecisions?.[0]?.decision.kind === "waiting") {
        expect(view.routeDecisions[0].decision.reason).toBe("no-eligible-candidate");
        expect(view.routeDecisions[0].decision.message.length).toBeGreaterThan(0);
      }
      expect(fakeDriver.acquireInputs).toHaveLength(0);
      expect(fakeDriver.sentTurns).toHaveLength(0);
    });

    it("keeps an already-accepted route unchanged across retry; retry never re-evaluates the pool", async () => {
      let resolveCalls = 0;
      const { service, thread } = await threadWithPool(
        async ({ pool: p }) => {
          resolveCalls += 1;
          return p.candidates.map((candidate, index) =>
            poolFacts(
              candidate,
              index === 0 ? { readiness: "unavailable", costRank: 1 } : { costRank: 1 },
            ),
          );
        },
        {},
        { turnOutcome: "interrupted" },
      );
      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: thread.id,
        expectedVersion: thread.version,
        prompt: "Hello retry",
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(() => service.read(thread.id).turns[0]?.attempts[0]?.outcome === "interrupted");
      expect(resolveCalls).toBe(1);

      const afterSend = service.read(thread.id);
      const turn = afterSend.turns[0]!;
      const attempt = turn.attempts[0]!;
      expect(attempt.modelId).toBe(fallbackModelId);

      const retried = await service.execute({
        kind: "retry-chat-turn",
        threadId: thread.id,
        turnId: turn.id,
        attemptId: attempt.id,
        expectedVersion: afterSend.thread.version,
      });
      if (retried.kind !== "attempt-updated") throw new Error("Expected attempt-updated result.");
      await until(() => service.read(thread.id).turns[0]?.attempts[1]?.outcome === "interrupted");

      expect(resolveCalls).toBe(1);
      expect(retried.attempt.modelId).toBe(fallbackModelId);
      expect(service.read(thread.id).routeDecisions).toHaveLength(1);
    });

    it("applies a pool change only to the next turn, leaving an already-created turn's route unaffected", async () => {
      const { service, thread } = await threadWithPool(async ({ pool: p }) =>
        p.candidates.map((candidate) => poolFacts(candidate)),
      );

      const firstSend = await service.execute({
        kind: "send-chat-turn",
        threadId: thread.id,
        expectedVersion: thread.version,
        prompt: "Turn one",
      });
      if (firstSend.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(() => service.read(thread.id).turns[0]?.attempts[0]?.outcome === "completed");
      const afterFirst = service.read(thread.id);
      expect(afterFirst.routeDecisions).toHaveLength(1);

      const changedPool = await service.execute({
        kind: "select-chat-multi-model-pool",
        threadId: thread.id,
        expectedVersion: afterFirst.thread.version,
        pool: pool({
          candidates: [poolCandidate(fallbackModelId), poolCandidate("model-a")],
        }),
      });
      if (changedPool.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

      const secondSend = await service.execute({
        kind: "send-chat-turn",
        threadId: thread.id,
        expectedVersion: changedPool.thread.version,
        prompt: "Turn two",
      });
      if (secondSend.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(() => service.read(thread.id).turns[1]?.attempts[0]?.outcome === "completed");

      const afterSecond = service.read(thread.id);
      expect(afterSecond.routeDecisions).toHaveLength(2);
      // The first turn's persisted route decision and executed attempt are untouched.
      expect(afterSecond.turns[0]?.attempts[0]?.modelId).toBe("model-a");
      // The second turn resolves against the NEW pool's first (requested) candidate.
      expect(afterSecond.turns[1]?.attempts[0]?.modelId).toBe(fallbackModelId);
    });

    it("publishes chat.turn-route-decided as a thread-scoped event visible via subscribe/replay", async () => {
      const { service, thread } = await threadWithPool(async ({ pool: p }) =>
        p.candidates.map((candidate) => poolFacts(candidate)),
      );
      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: thread.id,
        expectedVersion: thread.version,
        prompt: "Hello subscribe",
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(() => service.read(thread.id).turns[0]?.attempts[0]?.outcome === "completed");

      const frames = [];
      for await (const frame of service.subscribe(thread.id, 0)) frames.push(frame);
      const decided = frames.filter((frame) => frame.event.kind === "turn-route-decided");
      expect(decided).toHaveLength(1);
      expect(decided[0]?.event).toMatchObject({
        kind: "turn-route-decided",
        decision: { threadId: thread.id, decision: { kind: "selected" } },
      });
    });

    it("uses the default production runtime-fact gatherer, deriving authority from the candidate provider instance so a disabled instance fails closed to Waiting", async () => {
      const { service } = openFixture({ providerEnabled: false });
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Authority",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
      const updated = await service.execute({
        kind: "select-chat-multi-model-pool",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        pool: pool(),
      });
      if (updated.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

      await expect(
        service.execute({
          kind: "send-chat-turn",
          threadId: updated.thread.id,
          expectedVersion: updated.thread.version,
          prompt: "Hello disabled",
        }),
      ).rejects.toMatchObject({ failure: { category: "waiting" } });

      const view = service.read(updated.thread.id);
      expect(view.routeDecisions?.[0]?.decision.kind).toBe("waiting");
      if (view.routeDecisions?.[0]?.decision.kind === "waiting") {
        expect(
          view.routeDecisions[0].decision.eligibility.every((entry) =>
            entry.reasons.includes("authority-incompatible"),
          ),
        ).toBe(true);
      }
    });

    it("fails closed to an eligible fallback when a pooled model was removed or renamed from the probed catalog", async () => {
      const { service, fakeDriver } = openFixture();
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Removed model",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
      const updated = await service.execute({
        kind: "select-chat-multi-model-pool",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        pool: pool({
          candidates: [poolCandidate("model-removed"), poolCandidate("model-a")],
          higherCostFallbackAllowed: true,
        }),
      });
      if (updated.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: updated.thread.id,
        expectedVersion: updated.thread.version,
        prompt: "Hello removed model",
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await until(
        () => service.read(updated.thread.id).turns[0]?.attempts[0]?.outcome === "completed",
      );

      const view = service.read(updated.thread.id);
      expect(view.turns[0]?.attempts[0]?.modelId).toBe("model-a");
      expect(view.routeDecisions?.[0]?.decision.kind).toBe("selected");
      if (view.routeDecisions?.[0]?.decision.kind === "selected") {
        expect(view.routeDecisions[0].decision.selectionKind).toBe("fallback");
        expect(view.routeDecisions[0].decision.selectedCandidate.modelId).toBe("model-a");
        const removed = view.routeDecisions[0].decision.eligibility.find(
          (entry) => entry.candidate.modelId === "model-removed",
        );
        expect(removed?.eligible).toBe(false);
        expect(removed?.reasons).toContain("model-unavailable");
      }
      expect(fakeDriver.sentTurns).toHaveLength(1);
    });

    it("never commits a selected route receipt when turn preparation fails, so no immutable receipt references an unaccepted turn", async () => {
      const { service, thread } = await threadWithPool(async ({ pool: p }) =>
        p.candidates.map((candidate) => poolFacts(candidate)),
      );

      await expect(
        service.execute({
          kind: "send-chat-turn",
          threadId: thread.id,
          expectedVersion: thread.version,
          prompt: "Hello phantom receipt",
          attachmentIds: [decodeChatAttachmentId("85000000-0000-4000-8000-000000000099")],
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });

      const view = service.read(thread.id);
      expect(view.turns).toHaveLength(0);
      expect(view.routeDecisions).toBeUndefined();
    });

    it("skips the provider probe entirely for a disabled provider instance, so no driver construction, credential access, or network work precedes the ineligible receipt", async () => {
      const probeCalls: string[] = [];
      const { service } = openFixture({
        providerEnabled: false,
        driver: {
          probe: () => {
            probeCalls.push("probe");
            throw new Error("probe must not run for a disabled provider instance");
          },
        } as unknown as ProviderDriver,
      });
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Disabled probe",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
      const updated = await service.execute({
        kind: "select-chat-multi-model-pool",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        pool: pool(),
      });
      if (updated.kind !== "thread-updated") throw new Error("Expected thread-updated result.");

      await expect(
        service.execute({
          kind: "send-chat-turn",
          threadId: updated.thread.id,
          expectedVersion: updated.thread.version,
          prompt: "Hello disabled probe",
        }),
      ).rejects.toMatchObject({ failure: { category: "waiting" } });

      expect(probeCalls).toHaveLength(0);
      const view = service.read(updated.thread.id);
      expect(view.routeDecisions?.[0]?.decision.kind).toBe("waiting");
      if (view.routeDecisions?.[0]?.decision.kind === "waiting") {
        expect(
          view.routeDecisions[0].decision.eligibility.every((entry) =>
            entry.reasons.includes("authority-incompatible"),
          ),
        ).toBe(true);
      }
    });

    it("allows narrowing but rejects widening beyond the Settings-defined agent-eligible defaults", async () => {
      const { service } = openFixture({
        probe: dualModelProbe(),
        agentEligibleDefaults: [
          { providerInstanceId: ids.provider, modelId: "model-a" },
          { providerInstanceId: ids.provider, modelId: fallbackModelId },
          { providerInstanceId: ids.provider, modelId: "model-c" },
        ],
      });
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Narrow-only pool",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

      // Narrowing the Settings-defined default pool succeeds.
      const narrowed = await service.execute({
        kind: "select-chat-multi-model-pool",
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        pool: pool(),
      });
      if (narrowed.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
      expect(narrowed.thread.multiModelPool?.candidates).toHaveLength(2);

      // Widening beyond the defaults is rejected and nothing is persisted.
      await expect(
        service.execute({
          kind: "select-chat-multi-model-pool",
          threadId: created.thread.id,
          expectedVersion: narrowed.thread.version,
          pool: pool({
            candidates: [poolCandidate("model-a"), poolCandidate("model-not-eligible")],
          }),
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
      const view = service.read(created.thread.id);
      expect(view.thread.multiModelPool?.candidates.map((candidate) => candidate.modelId)).toEqual([
        "model-a",
        fallbackModelId,
      ]);

      // Clearing back to the single-model flow is always allowed.
      const restored = await service.execute({
        kind: "select-chat-multi-model-pool",
        threadId: created.thread.id,
        expectedVersion: narrowed.thread.version,
        pool: undefined,
      });
      if (restored.kind !== "thread-updated") throw new Error("Expected thread-updated result.");
      expect(restored.thread.multiModelPool).toBeUndefined();
    });
  });

  describe("revising and branching a conversation", () => {
    it("re-runs an edited message without rewriting the journal or replaying superseded turns", async () => {
      const { service, contextHarness, persistence } = openFixture();
      const planSpy = vi.spyOn(contextHarness, "planTurn");
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Edit",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

      const first = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: service.read(created.thread.id).thread.version,
        prompt: "First question",
      });
      if (first.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: service.read(created.thread.id).thread.version,
        prompt: "Second question",
      });
      const beforeEdit = service.read(created.thread.id);
      const journaledBeforeEdit = countRows(
        persistence.connection,
        "SELECT COUNT(*) AS count FROM event_journal WHERE aggregate_id = ?",
        String(created.thread.id),
      );

      const edited = await service.execute({
        kind: "edit-chat-turn",
        threadId: created.thread.id,
        expectedVersion: beforeEdit.thread.version,
        turnId: first.turn.id,
        prompt: "First question, revised",
      });
      if (edited.kind !== "turn-created") throw new Error("Expected turn-created result.");
      expect(edited.turn.supersedes).toBe(first.turn.id);

      // The journal only grew: the superseded turn and the turn that followed
      // it are still there, and their content is still readable.
      const afterEdit = service.read(created.thread.id);
      expect(afterEdit.turns.map((turn) => turn.id)).toEqual([
        ...beforeEdit.turns.map((turn) => turn.id),
        edited.turn.id,
      ]);
      expect(
        countRows(
          persistence.connection,
          "SELECT COUNT(*) AS count FROM event_journal WHERE aggregate_id = ?",
          String(created.thread.id),
        ),
      ).toBeGreaterThan(journaledBeforeEdit);
      expect(
        persistence.readChatContent(String(beforeEdit.turns[0]!.userMessageRef.contentId))?.body,
      ).toBe("First question");

      // The re-run is planned against the conversation as it stood before the
      // revised message, so neither the superseded prompt, nor the reply to it,
      // nor the exchange that followed it re-enters context.
      const planned = planSpy.mock.calls.at(-1)?.[0];
      expect(planned?.entries.filter((entry) => entry.category === "conversation")).toEqual([]);
      expect(planned?.entries.map((entry) => entry.label)).toContain("First question, revised");
      expect(activeChatTurns(afterEdit.turns).map((turn) => turn.id)).toEqual([edited.turn.id]);
    });

    it("refuses a stale edit and an edit of an already superseded turn", async () => {
      const { service } = openFixture();
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Stale edit",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: service.read(created.thread.id).thread.version,
        prompt: "Original",
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      const current = service.read(created.thread.id).thread.version;

      await expect(
        service.execute({
          kind: "edit-chat-turn",
          threadId: created.thread.id,
          expectedVersion: (current - 1) as AggregateVersion,
          turnId: sent.turn.id,
          prompt: "Refused",
        }),
      ).rejects.toMatchObject({ failure: { category: "stale" } });
      expect(service.read(created.thread.id).turns).toHaveLength(1);

      await service.execute({
        kind: "edit-chat-turn",
        threadId: created.thread.id,
        expectedVersion: current,
        turnId: sent.turn.id,
        prompt: "Revised once",
      });
      await expect(
        service.execute({
          kind: "edit-chat-turn",
          threadId: created.thread.id,
          expectedVersion: service.read(created.thread.id).thread.version,
          turnId: sent.turn.id,
          prompt: "Revised again",
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
    });

    it("branches a thread that carries the conversation and inherits scope from the server", async () => {
      const { service } = openFixture();
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Source",
        projectId: ids.project,
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
      const first = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: service.read(created.thread.id).thread.version,
        prompt: "Carried question",
      });
      if (first.kind !== "turn-created") throw new Error("Expected turn-created result.");
      await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: service.read(created.thread.id).thread.version,
        prompt: "Later question",
      });
      const source = service.read(created.thread.id);

      const branched = await service.execute({
        kind: "branch-chat-thread",
        threadId: created.thread.id,
        expectedVersion: source.thread.version,
        turnId: first.turn.id,
        title: "Second direction",
      });
      if (branched.kind !== "thread-created") throw new Error("Expected thread-created result.");

      const branch = service.read(branched.thread.id);
      expect(branch.thread).toMatchObject({
        title: "Second direction",
        projectId: source.thread.projectId,
        providerInstanceId: source.thread.providerInstanceId,
        modelId: source.thread.modelId,
        branchedFrom: {
          threadId: created.thread.id,
          turnId: first.turn.id,
          sourceVersion: source.thread.version,
          carriedTurnCount: 1,
          omittedAttachmentCount: 0,
        },
      });
      // The branch carries the conversation through the branch point and stops
      // there, with its own content rows rather than the source thread's.
      expect(branch.turns).toHaveLength(1);
      const carriedUser = branch.contents.find(
        (content) =>
          String(content.contentId) === String(branch.turns[0]!.userMessageRef.contentId),
      );
      expect(carriedUser?.body).toBe("Carried question");
      expect(String(branch.turns[0]!.userMessageRef.contentId)).not.toBe(
        String(source.turns[0]!.userMessageRef.contentId),
      );
      expect(
        branch.turns[0]!.attempts.flatMap((attempt) =>
          attempt.responseRefs.map(
            (reference) =>
              branch.contents.find(
                (content) => String(content.contentId) === String(reference.contentId),
              )?.body,
          ),
        ),
      ).toEqual(["Fixture response"]);

      // Branching leaves the source thread exactly as it was.
      expect(service.read(created.thread.id).turns.map((turn) => turn.id)).toEqual(
        source.turns.map((turn) => turn.id),
      );
    });

    it("refuses a stale branch without creating a thread", async () => {
      const { service } = openFixture();
      const created = await service.execute({
        kind: "create-chat-thread",
        hostId: "local",
        title: "Stale branch",
      });
      if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
      const sent = await service.execute({
        kind: "send-chat-turn",
        threadId: created.thread.id,
        expectedVersion: service.read(created.thread.id).thread.version,
        prompt: "Only question",
      });
      if (sent.kind !== "turn-created") throw new Error("Expected turn-created result.");
      const branchThreadId = "84000000-0000-4000-8000-0000000000b1" as ChatThreadId;

      await expect(
        service.execute({
          kind: "branch-chat-thread",
          threadId: created.thread.id,
          expectedVersion: (service.read(created.thread.id).thread.version - 1) as AggregateVersion,
          turnId: sent.turn.id,
          title: "Refused",
          branchThreadId,
        }),
      ).rejects.toMatchObject({ failure: { category: "stale" } });
      expect(() => service.read(branchThreadId)).toThrow(ChatServiceError);
    });
  });
});

function seedLeftoverStreamingAttempt(
  persistence: PersistenceService,
  thread: ChatThread,
  keys: {
    readonly turnId: string;
    readonly attemptId: string;
    readonly sessionId: string;
    readonly manifestId: string;
    readonly contentId: string;
    readonly title: string;
  },
): void {
  const turnId = decodeChatTurnId(keys.turnId);
  const attempt = decodeChatAttempt({
    id: decodeChatAttemptId(keys.attemptId),
    turnId,
    threadId: thread.id,
    providerInstanceId: thread.providerInstanceId,
    providerSessionId: decodeProviderSessionId(keys.sessionId),
    modelId: thread.modelId,
    contextManifestId: decodeContextManifestId(keys.manifestId),
    outcome: "streaming",
    responseRefs: [],
    citationIds: [],
    createdAt: now,
    updatedAt: now,
  });
  const turn = {
    id: turnId,
    threadId: thread.id,
    sequence: 1,
    userMessageRef: {
      contentId: decodeChatContentId(keys.contentId),
      digest: decodeContentSha256("a".repeat(64)),
      byteLength: 0,
    },
    attachmentIds: [],
    attempts: [attempt],
    createdAt: now,
  };
  persistence.connection
    .prepare(`
      INSERT INTO chat_content_store (
        content_id, thread_id, content_role, body_text, digest, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      String(turn.userMessageRef.contentId),
      String(thread.id),
      "user",
      keys.title,
      "a".repeat(64),
      0,
    );
  persistence.journal.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
    expectedVersion: thread.version,
    events: [
      {
        eventId: crypto.randomUUID(),
        eventName: "chat.turn-created@1",
        eventVersion: 1,
        correlationId: crypto.randomUUID(),
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { kind: "turn-created", turn },
      },
    ],
  });
}

function isAttemptUpdateFor(input: unknown, threadId: ChatThread["id"]): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "aggregate" in input &&
    typeof input.aggregate === "object" &&
    input.aggregate !== null &&
    "aggregateId" in input.aggregate &&
    String(input.aggregate.aggregateId) === String(threadId) &&
    "events" in input &&
    Array.isArray(input.events) &&
    input.events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "eventName" in event &&
        event.eventName === "chat.attempt-updated@1",
    )
  );
}

describe("ChatService provider session recovery", () => {
  it("retains a streaming attempt while this process still owns its provider turn", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: (input: { readonly sessionId: string }) =>
            Effect.succeed({ sessionId: input.sessionId }),
          send: (input: { readonly sessionId: string }) =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "text-delta",
                sessionId: input.sessionId,
                text: "Fixture response",
              } as never);
              yield* Effect.promise(() => sendGate);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const { service } = openFixture({ driver });
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Keep active provider session",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");

    const running = service.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: "Keep this turn active",
    });
    await until(
      () => service.read(created.thread.id).turns[0]?.attempts[0]?.outcome === "streaming",
    );
    const active = service.read(created.thread.id);
    const turn = active.turns[0];
    const attempt = turn?.attempts[0];
    if (turn === undefined || attempt === undefined) {
      throw new Error("Expected an active streaming attempt.");
    }

    await expect(service.reapStaleProviderSessions({ staleAfterMs: 0 })).resolves.toEqual({
      reaped: 0,
      resumable: 0,
    });
    await service.execute({
      kind: "interrupt-chat-turn",
      threadId: active.thread.id,
      expectedVersion: active.thread.version,
      turnId: turn.id,
      attemptId: attempt.id,
    });
    releaseSend();
    await expect(running).resolves.toMatchObject({ kind: "turn-created" });
  });

  it("interrupts a stale streaming attempt while retaining its resume cursor", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Recover provider session",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const thread = created.thread;
    const turnId = decodeChatTurnId("85000000-0000-4000-8000-000000000001");
    const attempt = decodeChatAttempt({
      id: decodeChatAttemptId("85000000-0000-4000-8000-000000000002"),
      turnId,
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: decodeProviderSessionId("85000000-0000-4000-8000-000000000003"),
      modelId: thread.modelId,
      contextManifestId: decodeContextManifestId("85000000-0000-4000-8000-000000000004"),
      outcome: "streaming",
      responseRefs: [],
      citationIds: [],
      resumeCursor: { driverKind: "openai-compatible", value: "resume-me" },
      createdAt: now,
      updatedAt: now,
    });
    const turn = {
      id: turnId,
      threadId: thread.id,
      sequence: 1,
      userMessageRef: {
        contentId: decodeChatContentId("85000000-0000-4000-8000-000000000005"),
        digest: decodeContentSha256("a".repeat(64)),
        byteLength: 0,
      },
      attachmentIds: [],
      attempts: [attempt],
      createdAt: now,
    };
    persistence.connection
      .prepare(`
        INSERT INTO chat_content_store (
          content_id, thread_id, content_role, body_text, digest, byte_length
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(turn.userMessageRef.contentId),
        String(thread.id),
        "user",
        "Recover provider session",
        "a".repeat(64),
        0,
      );
    persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
      expectedVersion: thread.version,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName: "chat.turn-created@1",
          eventVersion: 1,
          correlationId: crypto.randomUUID(),
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: { kind: "turn-created", turn },
        },
      ],
    });
    expect(persistence.readChatThreadView(thread.id)?.turns).toHaveLength(1);

    await expect(service.reapStaleProviderSessions({ staleAfterMs: 0 })).resolves.toEqual({
      reaped: 1,
      resumable: 1,
    });
    const recovered = service.read(thread.id).turns[0]?.attempts[0];
    expect(recovered?.outcome).toBe("interrupted");
    expect(recovered?.resumeCursor).toEqual({
      driverKind: "openai-compatible",
      value: "resume-me",
    });
  });

  it("interrupts every leftover streaming attempt on the same thread", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Recover stacked provider sessions",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const thread = created.thread;
    const turnId = decodeChatTurnId("85000000-0000-4000-8000-000000000011");
    const firstAttempt = decodeChatAttempt({
      id: decodeChatAttemptId("85000000-0000-4000-8000-000000000012"),
      turnId,
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: decodeProviderSessionId("85000000-0000-4000-8000-000000000013"),
      modelId: thread.modelId,
      contextManifestId: decodeContextManifestId("85000000-0000-4000-8000-000000000014"),
      outcome: "streaming",
      responseRefs: [],
      citationIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const secondAttempt = decodeChatAttempt({
      id: decodeChatAttemptId("85000000-0000-4000-8000-000000000015"),
      turnId,
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: decodeProviderSessionId("85000000-0000-4000-8000-000000000016"),
      modelId: thread.modelId,
      contextManifestId: decodeContextManifestId("85000000-0000-4000-8000-000000000017"),
      outcome: "streaming",
      responseRefs: [],
      citationIds: [],
      resumeCursor: { driverKind: "openai-compatible", value: "resume-second" },
      createdAt: now,
      updatedAt: now,
    });
    const turn = {
      id: turnId,
      threadId: thread.id,
      sequence: 1,
      userMessageRef: {
        contentId: decodeChatContentId("85000000-0000-4000-8000-000000000018"),
        digest: decodeContentSha256("a".repeat(64)),
        byteLength: 0,
      },
      attachmentIds: [],
      attempts: [firstAttempt, secondAttempt],
      createdAt: now,
    };
    persistence.connection
      .prepare(`
        INSERT INTO chat_content_store (
          content_id, thread_id, content_role, body_text, digest, byte_length
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(turn.userMessageRef.contentId),
        String(thread.id),
        "user",
        "Recover stacked provider sessions",
        "a".repeat(64),
        0,
      );
    persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
      expectedVersion: thread.version,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName: "chat.turn-created@1",
          eventVersion: 1,
          correlationId: crypto.randomUUID(),
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: { kind: "turn-created", turn },
        },
      ],
    });

    await expect(service.reapStaleProviderSessions({ staleAfterMs: 0 })).resolves.toEqual({
      reaped: 2,
      resumable: 1,
    });
    const recovered = service.read(thread.id).turns[0]?.attempts;
    expect(recovered?.map((attempt) => attempt.outcome)).toEqual(["interrupted", "interrupted"]);
  });

  it("retries a journal conflict once while reaping leftover sessions", async () => {
    const { service, persistence } = openFixture();
    const created = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Recover after a version race",
    });
    if (created.kind !== "thread-created") throw new Error("Expected thread-created result.");
    const thread = created.thread;
    const turnId = decodeChatTurnId("85000000-0000-4000-8000-000000000021");
    const attempt = decodeChatAttempt({
      id: decodeChatAttemptId("85000000-0000-4000-8000-000000000022"),
      turnId,
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: decodeProviderSessionId("85000000-0000-4000-8000-000000000023"),
      modelId: thread.modelId,
      contextManifestId: decodeContextManifestId("85000000-0000-4000-8000-000000000024"),
      outcome: "streaming",
      responseRefs: [],
      citationIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const turn = {
      id: turnId,
      threadId: thread.id,
      sequence: 1,
      userMessageRef: {
        contentId: decodeChatContentId("85000000-0000-4000-8000-000000000025"),
        digest: decodeContentSha256("a".repeat(64)),
        byteLength: 0,
      },
      attachmentIds: [],
      attempts: [attempt],
      createdAt: now,
    };
    persistence.connection
      .prepare(`
        INSERT INTO chat_content_store (
          content_id, thread_id, content_role, body_text, digest, byte_length
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(turn.userMessageRef.contentId),
        String(thread.id),
        "user",
        "Recover after a version race",
        "a".repeat(64),
        0,
      );
    persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
      expectedVersion: thread.version,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName: "chat.turn-created@1",
          eventVersion: 1,
          correlationId: crypto.randomUUID(),
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: { kind: "turn-created", turn },
        },
      ],
    });

    const originalAppend = persistence.journal.append.bind(persistence.journal);
    let failedOnce = false;
    persistence.journal.append = (input) => {
      if (
        !failedOnce &&
        typeof input === "object" &&
        input !== null &&
        "events" in input &&
        Array.isArray(input.events) &&
        input.events.some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "eventName" in event &&
            event.eventName === "chat.attempt-updated@1",
        )
      ) {
        failedOnce = true;
        throw new ConcurrencyConflict({
          aggregateType: "chat-thread",
          aggregateId: String(thread.id),
          expectedVersion: 0,
          actualVersion: 1,
        });
      }
      return originalAppend(input);
    };

    await expect(service.reapStaleProviderSessions({ staleAfterMs: 0 })).resolves.toEqual({
      reaped: 1,
      resumable: 0,
    });
    expect(service.read(thread.id).turns[0]?.attempts[0]?.outcome).toBe("interrupted");
  });

  it("isolates a non-conflict journal failure so remaining threads still recover", async () => {
    const { service, persistence } = openFixture();
    const failing = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Unreapable leftover session",
    });
    const recovering = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Recoverable leftover session",
    });
    if (failing.kind !== "thread-created") throw new Error("Expected thread-created result.");
    if (recovering.kind !== "thread-created") throw new Error("Expected thread-created result.");
    seedLeftoverStreamingAttempt(persistence, recovering.thread, {
      turnId: "85000000-0000-4000-8000-000000000041",
      attemptId: "85000000-0000-4000-8000-000000000042",
      sessionId: "85000000-0000-4000-8000-000000000043",
      manifestId: "85000000-0000-4000-8000-000000000044",
      contentId: "85000000-0000-4000-8000-000000000045",
      title: "Recoverable leftover session",
    });
    seedLeftoverStreamingAttempt(persistence, failing.thread, {
      turnId: "85000000-0000-4000-8000-000000000031",
      attemptId: "85000000-0000-4000-8000-000000000032",
      sessionId: "85000000-0000-4000-8000-000000000033",
      manifestId: "85000000-0000-4000-8000-000000000034",
      contentId: "85000000-0000-4000-8000-000000000035",
      title: "Unreapable leftover session",
    });

    const originalAppend = persistence.journal.append.bind(persistence.journal);
    persistence.journal.append = (input) => {
      if (isAttemptUpdateFor(input, failing.thread.id)) {
        throw new JournalWriteFailed({ operation: "append" });
      }
      return originalAppend(input);
    };

    await expect(service.reapStaleProviderSessions({ staleAfterMs: 0 })).resolves.toEqual({
      reaped: 1,
      resumable: 0,
    });
    expect(service.read(failing.thread.id).turns[0]?.attempts[0]?.outcome).toBe("streaming");
    expect(service.read(recovering.thread.id).turns[0]?.attempts[0]?.outcome).toBe("interrupted");
  });

  it("isolates a second journal conflict so remaining threads still recover", async () => {
    const { service, persistence } = openFixture();
    const conflicting = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Conflicted leftover session",
    });
    const recovering = await service.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: "Recoverable leftover session",
    });
    if (conflicting.kind !== "thread-created") throw new Error("Expected thread-created result.");
    if (recovering.kind !== "thread-created") throw new Error("Expected thread-created result.");
    seedLeftoverStreamingAttempt(persistence, recovering.thread, {
      turnId: "85000000-0000-4000-8000-000000000061",
      attemptId: "85000000-0000-4000-8000-000000000062",
      sessionId: "85000000-0000-4000-8000-000000000063",
      manifestId: "85000000-0000-4000-8000-000000000064",
      contentId: "85000000-0000-4000-8000-000000000065",
      title: "Recoverable leftover session",
    });
    seedLeftoverStreamingAttempt(persistence, conflicting.thread, {
      turnId: "85000000-0000-4000-8000-000000000051",
      attemptId: "85000000-0000-4000-8000-000000000052",
      sessionId: "85000000-0000-4000-8000-000000000053",
      manifestId: "85000000-0000-4000-8000-000000000054",
      contentId: "85000000-0000-4000-8000-000000000055",
      title: "Conflicted leftover session",
    });

    const originalAppend = persistence.journal.append.bind(persistence.journal);
    let conflicts = 0;
    persistence.journal.append = (input) => {
      if (isAttemptUpdateFor(input, conflicting.thread.id) && conflicts < 2) {
        conflicts += 1;
        throw new ConcurrencyConflict({
          aggregateType: "chat-thread",
          aggregateId: String(conflicting.thread.id),
          expectedVersion: 0,
          actualVersion: 1,
        });
      }
      return originalAppend(input);
    };

    await expect(service.reapStaleProviderSessions({ staleAfterMs: 0 })).resolves.toEqual({
      reaped: 1,
      resumable: 0,
    });
    expect(conflicts).toBe(2);
    expect(service.read(conflicting.thread.id).turns[0]?.attempts[0]?.outcome).toBe("streaming");
    expect(service.read(recovering.thread.id).turns[0]?.attempts[0]?.outcome).toBe("interrupted");
  });
});
