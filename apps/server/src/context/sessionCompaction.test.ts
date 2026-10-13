import { Effect, Queue, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeAggregateVersion,
  decodeContextCompactionId,
  decodeContextEntry,
  decodeContextSubjectRef,
  decodeModelContextLimits,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderServiceLimits,
  type ContextCompactionRefusalReason,
  type ContextSubjectRef,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { deriveCatalogEpoch } from "./capabilityCatalog";
import { ContextHarnessService, type SessionConversationMessage } from "./contextHarnessService";
import { makeProviderCapacityScheduler } from "./contextRuntime";
import {
  ContextCompactionRefused,
  SessionCompactionService,
  type SessionCompactionThread,
} from "./sessionCompaction";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import { SpendCeilingService } from "../spendCeilingService";

const now = "2026-07-18T21:00:00.000Z";
const providerInstanceId = decodeProviderInstanceId("82000000-0000-4000-8000-000000000001");
const modelId = decodeProviderModelId("model-a");
const threadId = "82000000-0000-4000-8000-000000000002";
const subject = decodeContextSubjectRef({ aggregateType: "chat-thread", aggregateId: threadId });
const compactionId = decodeContextCompactionId("82000000-0000-4000-8000-000000000003");
const activeScope = {
  mode: { referenceId: "mode:chat", revision: 1 },
  project: { referenceId: "project:none", revision: 1 },
  host: { referenceId: "host:local", revision: 1 },
  model: { referenceId: "model:model-a", revision: 1 },
} as const;

/**
 * Two finished exchanges the stored plan carried, and the latest prompt, which
 * the plan sent as its current request and so has no conversation entry.
 */
const conversation: ReadonlyArray<SessionConversationMessage> = [
  message("m1", "user", "turn-1", "How do I rotate the signing key?"),
  message("m2", "assistant", "turn-1", "Generate a new key, publish it, then retire the old."),
  message("m3", "user", "turn-2", "And the cache?"),
  message("m4", "assistant", "turn-2", "Invalidate it after the new key is published."),
  message("m5", "user", "turn-3", "Summarize the plan."),
];

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("compacting a session on request", () => {
  it("summarizes the conversation before the recent tail and journals a receipt", async () => {
    const world = createWorld();
    planSession(world);
    const before = world.harness.inspect(subject).next.plan.plannedInputTokens;

    const started = world.service.start(command(), "local-window");
    expect(started).toEqual({
      kind: "compaction-started",
      compactionId,
      executor: { kind: "host", providerInstanceId, modelId },
    });
    expect(world.service.inspect(subject, undefined, "local-window").compaction).toEqual({
      status: "refused",
      reason: "compaction-running",
    });
    await world.service.settled();

    const record = world.harness.latestCompaction(subject);
    if (record?.status !== "completed") throw new Error("The compaction completed");
    expect(record.receipt).toMatchObject({
      compactionId,
      trigger: "requested",
      executor: { kind: "host", providerInstanceId, modelId },
      tokensBefore: { kind: "known", tokens: before },
      summary: { visibility: "stored", summaryTokens: { tokens: 12 }, throughTurnId: "turn-2" },
      usage: { kind: "reported", inputTokens: 40, outputTokens: 12 },
    });
    expect(record.receipt.tokensAfter).toMatchObject({ kind: "known" });
    const after =
      record.receipt.tokensAfter.kind === "known" ? record.receipt.tokensAfter.tokens : 0;
    expect(after).toBeLessThan(before);
    expect(record.receipt.tokensFreed).toMatchObject({ kind: "estimated", tokens: before - after });

    const snapshot = world.harness.inspect(subject);
    expect(snapshot.latestCompaction).toEqual(record);
    expect(
      snapshot.next.manifest.entries
        .filter((entry) => entry.source.kind === "message" && entry.category === "conversation")
        .map((entry) => entry.state),
    ).toEqual(["summarized", "summarized", "summarized", "summarized"]);
    // The summary request is not a turn: the thread's own usage stays its last turn's.
    expect(snapshot.latestUsage).toBeUndefined();
    const summaryId = snapshot.summaries.at(-1)?.id;
    if (summaryId === undefined) throw new Error("The summary was journaled");
    expect(world.harness.summaryContent(summaryId)).toBe("The signing key rotates first.");
    expect(world.provider.materials).toEqual([
      "User: How do I rotate the signing key?",
      "Assistant: Generate a new key, publish it, then retire the old.",
      "User: And the cache?",
      "Assistant: Invalidate it after the new key is published.",
    ]);
    world.close();
  });

  it("answers a repeated compaction id with the compaction it already started", async () => {
    const world = createWorld();
    planSession(world);

    world.service.start(command(), "local-window");
    const head = world.fixture.journal.headSequence();
    expect(world.service.start(command(), "local-window")).toMatchObject({ compactionId });
    expect(world.fixture.journal.headSequence()).toBe(head);
    await world.service.settled();

    const settledHead = world.fixture.journal.headSequence();
    expect(world.service.start(command(), "local-window")).toMatchObject({ compactionId });
    expect(world.fixture.journal.headSequence()).toBe(settledHead);
    expect(world.provider.sends).toBe(1);
    world.close();
  });

  it("keeps a completed compaction's receipt across a restart", async () => {
    const world = createWorld();
    planSession(world);
    world.service.start(command(), "local-window");
    await world.service.settled();
    const record = world.harness.latestCompaction(subject);
    world.fixture.connection.close();

    const restarted = createFixture(world.path);
    expect(restarted.harness.closeInterruptedCompactions()).toBe(0);
    expect(restarted.harness.compaction(subject, compactionId)).toEqual(record);
    expect(restarted.harness.inspect(subject).latestCompaction).toEqual(record);
    restarted.connection.close();
  });

  it("fails a summary that is not smaller than what it replaces and leaves the plan alone", async () => {
    const world = createWorld({ outputTokens: 400 });
    planSession(world);
    const plan = world.harness.inspect(subject).next.plan.id;

    world.service.start(command(), "local-window");
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "summary-not-smaller",
      sessionMayHaveChanged: false,
    });
    expect(world.harness.inspect(subject).next.plan.id).toBe(plan);
    world.close();
  });

  it("fails rather than undo a turn planned while the summary was being written", async () => {
    const world = createWorld({ onSend: () => planSession(world) });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "context-changed",
    });
    expect(
      world.harness
        .inspect(subject)
        .next.manifest.entries.some((entry) => entry.state === "summarized"),
    ).toBe(false);
    world.close();
  });

  it("fails as timed out when the provider never answers", async () => {
    const world = createWorld({ wedge: true });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "timed-out",
    });
    world.close();
  });

  it("fails as summary-failed when the provider request fails", async () => {
    const world = createWorld({ failAcquire: true });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "summary-failed",
    });
    world.close();
  });

  it("fails as subject-unavailable when the thread's mode is disabled mid-compaction", async () => {
    const world = createWorld({
      onSend: () => {
        world.state.modeEnabled = false;
      },
    });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "subject-unavailable",
    });
    world.close();
  });

  it("journals no outcome for a thread deleted mid-compaction, and its purge erases the request", async () => {
    const world = createWorld({
      onSend: () => {
        world.state.thread = undefined;
      },
    });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();
    expect(world.harness.latestCompaction(subject)).toMatchObject({ status: "running" });

    erasePurgedThread({
      connection: world.fixture.connection,
      mode: "chat",
      threadId: threadId as never,
    });
    expect(world.harness.latestCompaction(subject)).toBeUndefined();
    expect(world.harness.compaction(subject, compactionId)).toBeUndefined();
    world.close();
  });

  it("erases a completed compaction and its summary text when the thread is purged", async () => {
    const world = createWorld();
    planSession(world);
    world.service.start(command(), "local-window");
    await world.service.settled();
    const summaryId = world.harness.inspect(subject).summaries.at(-1)?.id;
    if (summaryId === undefined) throw new Error("The summary was journaled");

    erasePurgedThread({
      connection: world.fixture.connection,
      mode: "chat",
      threadId: threadId as never,
    });
    world.fixture.connection.close();

    const restarted = createFixture(world.path);
    expect(restarted.harness.latestCompaction(subject)).toBeUndefined();
    expect(restarted.harness.summaryContent(summaryId)).toBeUndefined();
    restarted.connection.close();
  });

  it("closes a compaction a previous host left running as interrupted on the next start", () => {
    const fixture = createFixture();
    fixture.harness.requestCompaction({
      subject,
      compactionId,
      executor: { kind: "host", providerInstanceId, modelId },
    });
    fixture.connection.close();

    const restarted = createFixture(fixture.path);
    expect(restarted.harness.closeInterruptedCompactions()).toBe(1);
    expect(restarted.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "interrupted",
      sessionMayHaveChanged: false,
    });
    expect(restarted.harness.closeInterruptedCompactions()).toBe(0);
    restarted.connection.close();
  });

  it.each<{
    readonly name: string;
    readonly reason: ContextCompactionRefusalReason;
    readonly arrange: (world: World) => void;
    readonly principal?: "local-window" | "remote-device";
    readonly target?: ContextSubjectRef;
  }>([
    {
      name: "a paired device",
      reason: "remote-client",
      arrange: planSession,
      principal: "remote-device",
    },
    {
      name: "a thread whose mode is disabled",
      reason: "mode-disabled",
      arrange: (world) => {
        planSession(world);
        world.state.modeEnabled = false;
      },
    },
    {
      name: "a thread whose runtime owns its conversation",
      reason: "runtime-cannot-compact",
      arrange: (world) => {
        planSession(world);
        world.state.ownership = "provider";
      },
    },
    {
      name: "a Code thread",
      reason: "runtime-cannot-compact",
      arrange: planSession,
      target: decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
    },
    { name: "a thread that has sent nothing", reason: "no-session", arrange: () => undefined },
    {
      name: "a thread that moved to another model",
      reason: "no-session",
      arrange: (world) => {
        planSession(world);
        if (world.state.thread !== undefined) {
          world.state.thread = { ...world.state.thread, modelId: decodeProviderModelId("model-b") };
        }
      },
    },
    {
      name: "a thread with a turn running",
      reason: "turn-running",
      arrange: (world) => {
        planSession(world);
        world.state.turnRunning = true;
      },
    },
    {
      name: "a thread whose provider is unavailable",
      reason: "provider-unavailable",
      arrange: (world) => {
        planSession(world);
        world.state.providerAvailable = false;
      },
    },
    {
      name: "a thread with only its latest exchange",
      reason: "nothing-to-compact",
      arrange: (world) => {
        planSession(world);
        world.state.conversation = conversation.slice(-1);
      },
    },
    {
      name: "a thread whose spend ceiling cannot cover the summary",
      reason: "spend-ceiling-reached",
      arrange: (world) => {
        planSession(world);
        const set = world.spend.execute("local-window", {
          kind: "set-spend-ceiling",
          scope: { kind: "thread", threadType: "chat-thread", threadId },
          expectedVersion: decodeAggregateVersion(0),
          policy: { tokenBudget: 100 },
          window: { kind: "lifetime" },
        });
        expect(set.kind).toBe("set");
      },
    },
  ])("refuses to compact $name before anything is journaled or sent", (scenario) => {
    const world = createWorld();
    scenario.arrange(world);
    const target = scenario.target ?? subject;
    const principal = scenario.principal ?? "local-window";
    const head = world.fixture.journal.headSequence();

    expect(refusalOf(() => world.service.start(command(target), principal))).toBe(scenario.reason);
    expect(world.fixture.journal.headSequence()).toBe(head);
    expect(world.provider.sends).toBe(0);
    expect(world.harness.latestCompaction(target)).toBeUndefined();
    if (
      scenario.target === undefined &&
      scenario.reason !== "no-session" &&
      scenario.reason !== "spend-ceiling-reached"
    ) {
      // The admission check and the inspector's offer are the same decision;
      // a spend reservation only exceeds the ceiling once its bound is known.
      expect(world.service.inspect(target, undefined, principal).compaction).toEqual({
        status: "refused",
        reason: scenario.reason,
      });
    }
    world.close();
  });

  it("offers compaction to the window when nothing stands in the way", () => {
    const world = createWorld();
    planSession(world);
    expect(world.service.inspect(subject, undefined, "local-window").compaction).toEqual({
      status: "available",
    });
    world.close();
  });

  it("returns the capacity a refused spend reservation held", () => {
    const world = createWorld();
    planSession(world);
    world.spend.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 100 },
      window: { kind: "lifetime" },
    });
    refusalOf(() => world.service.start(command(), "local-window"));
    expect(world.capacity.snapshot(providerInstanceId).allocated).toEqual({
      requests: 0,
      tokens: 0,
      concurrency: 0,
    });
    world.close();
  });
});

let fixtureSequence = 0;

function createFixture(existingPath?: string) {
  const path =
    existingPath ??
    (() => {
      const directory = mkdtempSync(join(tmpdir(), "octant-session-compaction-"));
      directories.push(directory);
      return join(directory, "octant.sqlite3");
    })();
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let counter = fixtureSequence++ * 1_000 + 10;
  const uuid = () => `82000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
  const harness = new ContextHarnessService({
    persistence: {
      connection,
      journal,
      status: () => ({ state: "current", integrity: "ok" }) as const,
    },
    uuid,
    clock: () => now,
  });
  return { path, connection, journal, harness, uuid };
}

interface WorldState {
  thread: SessionCompactionThread | undefined;
  turnRunning: boolean;
  modeEnabled: boolean;
  providerAvailable: boolean;
  ownership: "host" | "provider";
  conversation: ReadonlyArray<SessionConversationMessage>;
}

type World = ReturnType<typeof createWorld>;

function createWorld(providerOptions: FakeProviderOptions = {}) {
  const fixture = createFixture();
  const provider = fakeProvider(providerOptions);
  const state: WorldState = {
    thread: { mode: "chat", providerInstanceId, modelId },
    turnRunning: false,
    modeEnabled: true,
    providerAvailable: true,
    ownership: "host",
    conversation,
  };
  const capacity = makeProviderCapacityScheduler({
    now: () => Date.parse(now),
    random: () => 0,
    maxRetryJitterMs: 1_000,
    ambiguousReservationTtlMs: 60_000,
  });
  const spend = new SpendCeilingService({
    connection: fixture.connection,
    journal: fixture.journal,
    clock: () => now,
    uuid: fixture.uuid,
    threadExists: () => true,
    projectExists: () => true,
  });
  const service = new SessionCompactionService({
    harness: fixture.harness,
    threads: {
      "chat-thread": {
        read: () => state.thread,
        turnRunning: () => state.turnRunning,
        conversation: () => state.conversation,
        scratchRoot: async () => "/tmp/octant-session-compaction/thread",
      },
    },
    modeEnabled: () => state.modeEnabled,
    availableDriver: () =>
      !state.providerAvailable
        ? undefined
        : state.ownership === "provider"
          ? { ...provider.driver, conversationOwnership: "provider" }
          : provider.driver,
    capacity,
    spendCeiling: spend,
    uuid: fixture.uuid,
    summaryTimeoutMs: 100,
    summaryShutdownTimeoutMs: 50,
  });
  return {
    fixture,
    path: fixture.path,
    harness: fixture.harness,
    provider,
    state,
    capacity,
    spend,
    service,
    close: () => fixture.connection.close(),
  };
}

function planSession(world: World): void {
  world.harness.planTurn({
    subject,
    displayLabel: "Signing keys",
    requestShape: "chat-turn",
    modelLimitObservations: [modelLimits()],
    serviceLimits: serviceLimits(),
    entries: [
      currentRequest(100),
      conversationEntry("m1", 100),
      conversationEntry("m2", 100),
      conversationEntry("m3", 100),
      conversationEntry("m4", 100),
    ],
    reserves: { response: 200, reasoning: 50, framing: 50, variance: 50, safety: 50 },
    watchHeadroomTokens: 100,
    capabilityCatalog: {
      entries: [],
      epoch: deriveCatalogEpoch({
        entries: [],
        activeFacts: { providerInstanceId, activeScope },
        invalidationFacts: [],
      }),
    },
    capabilityRequest: {
      providerInstanceId,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    },
  });
}

function command(target: ContextSubjectRef = subject) {
  return { kind: "compact-session", subject: target, compactionId } as const;
}

function refusalOf(start: () => unknown): ContextCompactionRefusalReason | undefined {
  try {
    start();
  } catch (error) {
    if (error instanceof ContextCompactionRefused) return error.reason;
    throw error;
  }
  return undefined;
}

function message(
  referenceId: string,
  role: "user" | "assistant",
  exchangeKey: string,
  content: string,
): SessionConversationMessage {
  return { source: { kind: "message", referenceId }, role, exchangeKey, content };
}

let entrySequence = 0;

function conversationEntry(referenceId: string, tokens: number) {
  return decodeContextEntry({
    id: `82000000-0000-4000-8000-${String(500 + entrySequence++).padStart(12, "0")}`,
    source: { kind: "message", referenceId },
    category: "conversation",
    label: "Earlier conversation",
    eligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    posture: "compressible",
    retention: "active",
    priority: 10,
    originalSize: tokens,
    includedSize: tokens,
    tokens: { kind: "known", tokens, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: "History hidden" },
  });
}

function currentRequest(tokens: number) {
  return decodeContextEntry({
    id: `82000000-0000-4000-8000-${String(500 + entrySequence++).padStart(12, "0")}`,
    source: { kind: "message", referenceId: "m5" },
    category: "current-request",
    label: "Current request",
    eligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    posture: "required",
    retention: "active",
    priority: 100,
    originalSize: tokens,
    includedSize: tokens,
    tokens: { kind: "known", tokens, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: "Request hidden" },
  });
}

function modelLimits() {
  return decodeModelContextLimits({
    providerInstanceId,
    modelId,
    contextWindow: 1_000,
    maxOutput: 200,
    extendedContext: { kind: "unavailable" },
    reasoning: "included",
    compaction: "manual",
    tokenizer: { kind: "exact", id: "fixture" },
    source: "runtime-reported",
    confidence: "high",
    conflicts: [],
    verifiedAt: now,
  });
}

function serviceLimits() {
  return decodeProviderServiceLimits({
    providerInstanceId,
    scope: "provider-instance",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "available", limit: 2, remaining: 2 },
    retry: { status: "inactive" },
    quota: "unknown",
    source: "runtime-reported",
    confidence: "medium",
    updatedAt: now,
  });
}

interface FakeProviderOptions {
  readonly outputTokens?: number;
  /** Accepts the prompt and never answers. */
  readonly wedge?: boolean;
  readonly failAcquire?: boolean;
  /** Runs when the summary prompt is sent, before the provider answers. */
  readonly onSend?: () => void;
}

/** A summary provider that answers one prompt with a fixed summary and usage report. */
function fakeProvider(options: FakeProviderOptions) {
  const recorded = { sends: 0, materials: [] as ReadonlyArray<string> };
  const queue = Effect.runSync(Queue.unbounded<never>());
  const connection = {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: (input: { readonly sessionId: string }) =>
      Effect.succeed({ sessionId: input.sessionId }),
    send: (input: { readonly sessionId: string; readonly prompt: string }) =>
      Effect.suspend(() => {
        recorded.sends += 1;
        recorded.materials = input.prompt
          .split("\n")
          .filter((line) => /^(User|Assistant): /.test(line));
        options.onSend?.();
        if (options.wedge === true) return Effect.void;
        return Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "text-delta",
            sessionId: input.sessionId,
            text: "The signing key rotates first.",
          } as never);
          yield* Queue.offer(queue, {
            kind: "usage",
            sessionId: input.sessionId,
            inputTokens: 40,
            outputTokens: options.outputTokens ?? 12,
          } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
        });
      }),
    interrupt: () => Effect.void,
    stop: () => Effect.void,
    answerApproval: () => Effect.void,
    answerUserInput: () => Effect.void,
    answerTool: () => Effect.void,
  };
  const driver = {
    kind: "openai-compatible",
    acquire: () =>
      options.failAcquire === true
        ? Effect.fail({ _tag: "ProviderFailure", message: "Connection refused." })
        : Effect.succeed(connection),
  } as unknown as ProviderDriver;
  return {
    driver,
    get sends() {
      return recorded.sends;
    },
    get materials() {
      return recorded.materials;
    },
  };
}
