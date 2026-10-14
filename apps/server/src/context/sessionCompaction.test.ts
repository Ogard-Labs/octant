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
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderServiceLimits,
  decodeProviderSessionId,
  type ContextCompactionRefusalReason,
  type ContextSubjectRef,
  type WindowId,
  type ProjectProviderPolicy,
  type ProviderInstance,
} from "@octant/contracts";
import type {
  ProviderAcquireInput,
  ProviderDriver,
  ProviderSessionCompaction,
  ProviderSessionResume,
} from "@octant/provider-sdk/driver";
import { deriveCatalogEpoch } from "./capabilityCatalog";
import { ContextHarnessService, type SessionConversationMessage } from "./contextHarnessService";
import { makeProviderCapacityScheduler } from "./contextRuntime";
import {
  SessionCompactionService,
  type SessionCompactionStart,
  type SessionCompactionThread,
} from "./sessionCompaction";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { verifyDatabase } from "../persistence/recovery";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import { SpendCeilingService } from "../spendCeilingService";

const now = "2026-07-18T21:00:00.000Z";
const providerInstanceId = decodeProviderInstanceId("82000000-0000-4000-8000-000000000001");
const modelId = decodeProviderModelId("model-a");
const threadId = "82000000-0000-4000-8000-000000000002";
const subject = decodeContextSubjectRef({ aggregateType: "chat-thread", aggregateId: threadId });
const compactionId = decodeContextCompactionId("82000000-0000-4000-8000-000000000003");
const workSubject = decodeContextSubjectRef({
  aggregateType: "work-thread",
  aggregateId: threadId,
});
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
    // A summary request is text in, text out: it offers the model no tool,
    // and the session it starts names none.
    expect(world.provider.sentTools).toEqual([]);
    expect(world.provider.started).not.toHaveProperty("tools");
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
    const sequence = world.harness.inspect(subject).sequence;
    world.fixture.connection.close();

    const restarted = createFixture(world.path);
    expect(restarted.harness.closeInterruptedCompactions()).toBe(0);
    expect(restarted.harness.compaction(subject, compactionId)).toEqual(record);
    const restored = restarted.harness.inspect(subject);
    expect(restored.latestCompaction).toEqual(record);
    // The restored sequence includes the compaction's own events, so a window
    // that accepted the live snapshot does not see the restart as a regression.
    expect(restored.sequence).toBe(sequence);
    restarted.connection.close();
  });

  it("tells the thread's live stream how each compaction ended", async () => {
    const world = createWorld();
    planSession(world);
    world.service.start(command(), "local-window");
    await world.service.settled();
    const completed = world.harness.latestCompaction(subject);
    expect(completed?.status).toBe("completed");

    const failing = createWorld({ outputTokens: 400 });
    planSession(failing);
    failing.service.start(command(), "local-window");
    await failing.service.settled();
    const failed = failing.harness.latestCompaction(subject);
    expect(failed?.status).toBe("failed");

    expect(world.announced).toEqual([{ threadId, compaction: completed }]);
    expect(failing.announced).toEqual([{ threadId, compaction: failed }]);
    world.close();
    failing.close();
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

  it("fails rather than undo a turn planned before the summary request was sent", async () => {
    const world = createWorld();
    planSession(world);

    world.service.start(command(), "local-window");
    // The request is journaled and the summary not yet asked for.
    planSession(world);
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "context-changed",
    });
    expect(world.provider.sends).toBe(0);
    expect(
      world.harness
        .inspect(subject)
        .next.manifest.entries.some((entry) => entry.state === "summarized"),
    ).toBe(false);
    world.close();
  });

  it("records what the provider reported when the compaction fails after the summary returned", async () => {
    const world = createWorld({
      onSend: () => {
        world.state.readThrows = true;
      },
    });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "summary-failed",
    });
    expect(reportedCompactionUsage(world.fixture.connection)).toEqual([
      { input_tokens: 40, output_tokens: 12 },
    ]);
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

  it("ends a compaction whose thread is deleted mid-compaction, and its purge erases the request", async () => {
    const world = createWorld({
      onSend: () => {
        world.state.thread = undefined;
      },
    });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();
    // An ordinary delete does not purge, so the request cannot wait for one.
    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "subject-unavailable",
      sessionMayHaveChanged: false,
    });
    expect(
      world.harness
        .inspect(subject)
        .next.manifest.entries.some((entry) => entry.state === "summarized"),
    ).toBe(false);
    expect(reportedCompactionUsage(world.fixture.connection)).toEqual([
      { input_tokens: 40, output_tokens: 12 },
    ]);
    expect(world.harness.closeInterruptedCompactions()).toBe(0);

    erasePurgedThread({
      connection: world.fixture.connection,
      mode: "chat",
      threadId: threadId as never,
    });
    expect(world.harness.latestCompaction(subject)).toBeUndefined();
    expect(world.harness.compaction(subject, compactionId)).toBeUndefined();
    expect(reportedCompactionUsage(world.fixture.connection)).toEqual([
      { input_tokens: 40, output_tokens: 12 },
    ]);
    world.close();
  });

  it("keeps reported usage when the thread is purged before the summary request ends", async () => {
    const world = createWorld({
      onSend: () => {
        erasePurgedThread({
          connection: world.fixture.connection,
          mode: "chat",
          threadId: threadId as never,
        });
      },
    });
    planSession(world);

    world.service.start(command(), "local-window");
    await world.service.settled();

    expect(world.harness.compaction(subject, compactionId)).toBeUndefined();
    expect(reportedCompactionUsage(world.fixture.connection)).toEqual([
      { input_tokens: 40, output_tokens: 12 },
    ]);
    world.close();
  });

  it("fails when the thread moves to another model while the summary is being written", async () => {
    const world = createWorld({
      onSend: () => {
        if (world.state.thread !== undefined) {
          world.state.thread = { ...world.state.thread, modelId: decodeProviderModelId("model-b") };
        }
      },
    });
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

  it("offers no compaction when the provider cannot be constructed", () => {
    const world = createWorld();
    planSession(world);
    world.state.driverThrows = true;

    expect(world.service.inspect(subject, undefined, "local-window").compaction).toEqual({
      status: "refused",
      reason: "provider-unavailable",
    });
    const head = world.fixture.journal.headSequence();
    expect(refusalOf(() => world.service.start(command(), "local-window"))).toBe(
      "provider-unavailable",
    );
    expect(world.fixture.journal.headSequence()).toBe(head);
    expect(world.harness.latestCompaction(subject)).toBeUndefined();
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
    // Deleting the compaction must not leave a version gap or a checkpoint
    // past the journal head: either one makes the store read as corrupt.
    expect(
      verifyDatabase({
        connection: world.fixture.connection,
        journal: world.fixture.journal,
        projections: world.fixture.projections,
      }).issues,
    ).toEqual([]);
    world.fixture.connection.close();

    const restarted = createFixture(world.path);
    expect(restarted.harness.latestCompaction(subject)).toBeUndefined();
    expect(restarted.harness.summaryContent(summaryId)).toBeUndefined();
    planSession({ ...world, harness: restarted.harness });
    expect(restarted.harness.inspect(subject).latestCompaction).toBeUndefined();
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
      name: "a signed-out thread whose runtime owns its conversation",
      reason: "runtime-cannot-compact",
      arrange: (world) => {
        planSession(world);
        world.state.ownership = "provider";
        world.state.providerAvailable = false;
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
    if (scenario.target === undefined && scenario.reason !== "no-session") {
      // The admission check and the inspector's offer are the same decision.
      expect(world.service.inspect(target, undefined, principal).compaction).toEqual({
        status: "refused",
        reason: scenario.reason,
      });
    }
    world.close();
  });

  describe("a Work thread's Project provider policy", () => {
    const otherProvider = decodeProviderInstanceId("82000000-0000-4000-8000-0000000000ff");
    const workThread = (providerPolicy?: ProjectProviderPolicy): SessionCompactionThread => ({
      mode: "work",
      projectId: "82000000-0000-4000-8000-0000000000aa",
      providerInstanceId,
      modelId,
      ...(providerPolicy === undefined ? {} : { providerPolicy }),
    });

    it.each<{ readonly name: string; readonly policy: ProjectProviderPolicy }>([
      {
        name: "an allow-list that leaves it out",
        policy: { mode: "whitelist", providerInstanceIds: [otherProvider] },
      },
      {
        name: "an EU or zero-retention policy it does not meet",
        policy: { mode: "eu-zdr", providerInstanceIds: [] },
      },
    ])(
      "refuses to compact when $name before anything is journaled, reserved, or sent",
      ({ policy }) => {
        const world = createWorld();
        planSession(world, workSubject);
        world.state.thread = workThread(policy);
        const head = world.fixture.journal.headSequence();

        // The window is never offered a compaction the command would refuse.
        expect(world.service.inspect(workSubject, undefined, "local-window").compaction).toEqual({
          status: "refused",
          reason: "provider-unavailable",
        });
        expect(refusalOf(() => world.service.start(command(workSubject), "local-window"))).toBe(
          "provider-unavailable",
        );
        expect(world.fixture.journal.headSequence()).toBe(head);
        expect(world.harness.latestCompaction(workSubject)).toBeUndefined();
        expect(world.reads.spendAdmissions).toBe(0);
        expect(world.capacity.snapshot(providerInstanceId)).toEqual({
          allocated: { requests: 0, tokens: 0, concurrency: 0 },
          queue: [],
        });
        // The provider's driver is never even built, so it cannot be asked.
        expect(world.reads.drivers).toBe(0);
        expect(world.provider.sends).toBe(0);
        world.close();
      },
    );

    it.each<{
      readonly name: string;
      readonly policy: ProjectProviderPolicy | undefined;
      readonly dataTags?: ReadonlyArray<"eu" | "zdr">;
    }>([
      { name: "a Project that set no policy", policy: undefined },
      {
        name: "an allow-list that names it",
        policy: { mode: "whitelist", providerInstanceIds: [providerInstanceId] },
      },
      {
        name: "an EU policy it meets",
        policy: { mode: "eu-zdr", providerInstanceIds: [] },
        dataTags: ["eu"],
      },
    ])("compacts as before under $name", async ({ policy, dataTags }) => {
      const world = createWorld();
      planSession(world, workSubject);
      world.state.thread = workThread(policy);
      world.state.provider = providerInstance(dataTags === undefined ? {} : { dataTags });

      expect(world.service.inspect(workSubject, undefined, "local-window").compaction).toEqual({
        status: "available",
      });
      world.service.start(command(workSubject), "local-window");
      await world.service.settled();

      expect(world.harness.latestCompaction(workSubject)).toMatchObject({ status: "completed" });
      expect(world.provider.sends).toBe(1);
      world.close();
    });
  });

  it.each<{
    readonly name: string;
    readonly arrange: (world: World) => void;
    readonly principal?: "local-window" | "remote-device";
    readonly readsConversation: boolean;
  }>([
    {
      name: "a paired device",
      arrange: () => undefined,
      principal: "remote-device",
      readsConversation: false,
    },
    {
      name: "a thread whose mode is disabled",
      arrange: (world) => {
        world.state.modeEnabled = false;
      },
      readsConversation: false,
    },
    {
      name: "a thread whose runtime owns its conversation",
      arrange: (world) => {
        world.state.ownership = "provider";
      },
      readsConversation: false,
    },
    {
      name: "a thread with a turn running",
      arrange: (world) => {
        world.state.turnRunning = true;
      },
      readsConversation: true,
    },
  ])(
    "inspects $name without building a provider driver or reading the spend ceiling",
    ({ arrange, principal, readsConversation }) => {
      const world = createWorld();
      planSession(world);
      arrange(world);

      const { compaction } = world.service.inspect(subject, undefined, principal ?? "local-window");

      expect(compaction?.status).toBe("refused");
      expect(world.reads.drivers).toBe(0);
      expect(world.reads.spendSnapshots).toBe(0);
      expect(world.reads.conversations > 0).toBe(readsConversation);
      world.close();
    },
  );

  it("offers compaction to the window when nothing stands in the way", () => {
    const world = createWorld();
    planSession(world);
    expect(world.service.inspect(subject, undefined, "local-window").compaction).toEqual({
      status: "available",
    });
    world.close();
  });

  it("refuses a compaction the ceiling cannot pay for before reserving provider capacity", () => {
    const world = createWorld();
    planSession(world);
    world.spend.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 100 },
      window: { kind: "lifetime" },
    });

    expect(refusalOf(() => world.service.start(command(), "local-window"))).toBe(
      "spend-ceiling-reached",
    );
    expect(world.capacity.snapshot(providerInstanceId)).toEqual({
      allocated: { requests: 0, tokens: 0, concurrency: 0 },
      queue: [],
    });
    world.close();
  });
});

describe("compacting a session a runtime keeps", () => {
  it("asks the runtime to compact the resumed session and journals the receipt it reports", async () => {
    const world = createRuntimeWorld({
      answer: { kind: "compacted", tokensBefore: 900, tokensAfter: 300 },
      usage: { inputTokens: 50, outputTokens: 20 },
    });
    planSession(world);

    expect(world.service.inspect(subject, undefined, "local-window").compaction).toEqual({
      status: "available",
    });
    expect(world.service.start(command(), "local-window", windowId)).toEqual({
      kind: "compaction-started",
      compactionId,
      executor: { kind: "runtime", driverKind: "codex", providerInstanceId, modelId },
    });
    await world.service.settled();

    const record = world.harness.latestCompaction(subject);
    if (record?.status !== "completed") throw new Error("The compaction completed");
    expect(record.receipt).toMatchObject({
      compactionId,
      trigger: "requested",
      executor: { kind: "runtime", driverKind: "codex", providerInstanceId, modelId },
      tokensBefore: { kind: "known", tokens: 900, accuracy: "provider-reported" },
      tokensAfter: { kind: "known", tokens: 300, accuracy: "provider-reported" },
      tokensFreed: { kind: "measured", tokens: 600, accuracy: "provider-reported" },
      summary: { visibility: "runtime-only" },
      usage: { kind: "reported", inputTokens: 50, outputTokens: 20 },
    });
    // The session the thread's next turn resumes, opened by the window that
    // asked, with no tool, and stopped once the runtime answered.
    expect(world.opened).toEqual([windowId]);
    expect(world.runtime.acquired).toEqual([runtimeSession.acquire]);
    expect(world.runtime.resumed).toEqual([runtimeSession.resume]);
    expect(world.runtime.compactions).toEqual([String(compactionId)]);
    expect(world.runtime.stops).toBeGreaterThan(0);
    // Its spend is in the ledger, and it is not the thread's latest turn.
    expect(reportedCompactionUsage(world.fixture.connection)).toEqual([
      { input_tokens: 50, output_tokens: 20 },
    ]);
    expect(world.harness.inspect(subject).latestUsage).toBeUndefined();
    expect(world.announced).toEqual([{ threadId, compaction: record }]);
    world.close();
  });

  it("waits for the next usage report when the runtime reports no figures", async () => {
    const world = createRuntimeWorld({ answer: { kind: "compacted" } });
    planSession(world);
    const planned = world.harness.inspect(subject).next.plan.plannedInputTokens;

    world.service.start(command(), "local-window", windowId);
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "completed",
      receipt: {
        // No report said how full the window was, so the plan's own estimate stands.
        tokensBefore: { kind: "known", tokens: planned, accuracy: "conservative-heuristic" },
        tokensAfter: { kind: "pending" },
        tokensFreed: { kind: "unknown", reason: "awaiting-next-report" },
        usage: { kind: "unreported" },
      },
    });
    world.close();
  });

  it.each<{
    readonly name: string;
    readonly runtime: FakeRuntimeOptions;
    readonly reason: string;
    readonly sessionMayHaveChanged: boolean;
    readonly asked: boolean;
  }>([
    {
      name: "a failure the runtime attests changed nothing",
      runtime: {
        answer: {
          kind: "failed",
          message: "Codex could not compact.",
          sessionMayHaveChanged: false,
        },
      },
      reason: "runtime-failed",
      sessionMayHaveChanged: false,
      asked: true,
    },
    {
      name: "a failure the runtime cannot vouch for",
      runtime: {
        answer: { kind: "failed", message: "Claude did not finish.", sessionMayHaveChanged: true },
      },
      reason: "runtime-failed",
      sessionMayHaveChanged: true,
      asked: true,
    },
    {
      name: "a refusal the adapter decided before asking",
      runtime: { answer: { kind: "refused", reason: "nothing-to-compact" } },
      reason: "runtime-failed",
      sessionMayHaveChanged: false,
      asked: true,
    },
    {
      name: "a connection that loses the request",
      runtime: { compactFails: true },
      reason: "runtime-failed",
      sessionMayHaveChanged: true,
      asked: true,
    },
    {
      name: "a runtime that never answers",
      runtime: { hang: true },
      reason: "timed-out",
      sessionMayHaveChanged: true,
      asked: true,
    },
    {
      name: "a session that cannot be resumed",
      runtime: { resumeFails: true },
      reason: "subject-unavailable",
      sessionMayHaveChanged: false,
      asked: false,
    },
  ])(
    "records $name as failed, saying whether the session may have changed",
    async ({ runtime, reason, sessionMayHaveChanged, asked }) => {
      const world = createRuntimeWorld(runtime);
      planSession(world);

      world.service.start(command(), "local-window", windowId);
      await world.service.settled();

      expect(world.harness.latestCompaction(subject)).toMatchObject({
        status: "failed",
        reason,
        sessionMayHaveChanged,
        executor: { kind: "runtime" },
      });
      expect(world.runtime.compactions.length > 0).toBe(asked);
      // Whatever happened, the session is not left open: a runtime that stops
      // answering is ended by stopping its session, as its interrupt needs a turn.
      if (world.runtime.resumed.length > 0) expect(world.runtime.stops).toBeGreaterThan(0);
      // A failed request holds the thread's turns no longer.
      expect(world.harness.compactionRunning(subject)).toBe(false);
      world.close();
    },
  );

  it("interrupts a compaction that outlives its bound before it stops the session", async () => {
    // A runtime that runs its compaction as a turn keeps running it after the
    // session is stopped here; a later turn would queue behind it.
    const world = createRuntimeWorld({ hang: true, interruptible: true });
    planSession(world);

    world.service.start(command(), "local-window", windowId);
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "timed-out",
      sessionMayHaveChanged: true,
    });
    expect(world.runtime.endings[0]).toBe("interrupt");
    expect(world.runtime.endings).toContain("stop");
    world.close();
  });

  it("stops a timed-out compaction whose runtime refuses an interrupt with no turn", async () => {
    const world = createRuntimeWorld({ hang: true });
    planSession(world);

    world.service.start(command(), "local-window", windowId);
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({ reason: "timed-out" });
    expect(world.runtime.endings.slice(0, 2)).toEqual(["interrupt", "stop"]);
    world.close();
  });

  it("keeps a compaction the runtime finished after the thread's mode was turned off", async () => {
    const world = createRuntimeWorld({
      answer: { kind: "compacted", tokensBefore: 900, tokensAfter: 300 },
      onCompact: () => {
        world.state.modeEnabled = false;
      },
    });
    planSession(world);

    world.service.start(command(), "local-window", windowId);
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)?.status).toBe("completed");
    world.close();
  });

  it("records an outcome nobody can vouch for, after the mode was turned off, as the thread's absence", async () => {
    const world = createRuntimeWorld({
      answer: { kind: "failed", message: "Claude did not finish.", sessionMayHaveChanged: true },
      onCompact: () => {
        world.state.modeEnabled = false;
      },
    });
    planSession(world);

    world.service.start(command(), "local-window", windowId);
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "subject-unavailable",
      sessionMayHaveChanged: true,
    });
    world.close();
  });

  it("ends a runtime compaction whose thread was deleted, and keeps what it spent", async () => {
    const world = createRuntimeWorld({
      answer: { kind: "compacted", tokensBefore: 900, tokensAfter: 300 },
      usage: { inputTokens: 50, outputTokens: 20 },
      onCompact: () => {
        world.state.thread = undefined;
      },
    });
    planSession(world);

    world.service.start(command(), "local-window", windowId);
    await world.service.settled();

    expect(world.harness.latestCompaction(subject)).toMatchObject({
      status: "failed",
      reason: "subject-unavailable",
      sessionMayHaveChanged: true,
    });
    expect(reportedCompactionUsage(world.fixture.connection)).toEqual([
      { input_tokens: 50, output_tokens: 20 },
    ]);
    world.close();
  });

  it("answers a repeated compaction id with the compaction it already asked for", async () => {
    const world = createRuntimeWorld({ answer: { kind: "compacted" } });
    planSession(world);

    world.service.start(command(), "local-window", windowId);
    const head = world.fixture.journal.headSequence();
    expect(world.service.start(command(), "local-window", windowId)).toMatchObject({
      compactionId,
      executor: { kind: "runtime" },
    });
    expect(world.fixture.journal.headSequence()).toBe(head);
    await world.service.settled();
    const settledHead = world.fixture.journal.headSequence();
    expect(world.service.start(command(), "local-window", windowId)).toMatchObject({
      compactionId,
    });
    expect(world.fixture.journal.headSequence()).toBe(settledHead);
    expect(world.runtime.compactions).toHaveLength(1);
    world.close();
  });

  it("refuses another compaction, and holds the thread's turns, while the runtime compacts", async () => {
    const world = createRuntimeWorld({ hang: true });
    planSession(world);

    world.service.start(command(), "local-window", windowId);
    // The request is journaled before the runtime is asked, so the thread's
    // own turn admission sees it at once.
    expect(world.harness.compactionRunning(subject)).toBe(true);
    expect(world.service.inspect(subject, undefined, "local-window").compaction).toEqual({
      status: "refused",
      reason: "compaction-running",
    });
    const another = decodeContextCompactionId("82000000-0000-4000-8000-0000000000c1");
    const head = world.fixture.journal.headSequence();
    expect(
      refusalOf(() =>
        world.service.start(
          { kind: "compact-session", subject, compactionId: another },
          "local-window",
          windowId,
        ),
      ),
    ).toBe("compaction-running");
    expect(world.fixture.journal.headSequence()).toBe(head);
    await world.service.settled();
    world.close();
  });

  it("keeps a runtime receipt across a restart, and closes one left running as possibly changed", async () => {
    const world = createRuntimeWorld({ answer: { kind: "compacted", tokensBefore: 900 } });
    planSession(world);
    world.service.start(command(), "local-window", windowId);
    await world.service.settled();
    const record = world.harness.latestCompaction(subject);
    world.fixture.connection.close();
    const restarted = createFixture(world.path);
    expect(restarted.harness.compaction(subject, compactionId)).toEqual(record);
    restarted.connection.close();

    const hung = createRuntimeWorld({ hang: true });
    planSession(hung);
    hung.service.start(command(), "local-window", windowId);
    hung.fixture.connection.close();
    const recovered = createFixture(hung.path);
    expect(recovered.harness.closeInterruptedCompactions()).toBe(1);
    expect(recovered.harness.compaction(subject, compactionId)).toMatchObject({
      status: "failed",
      reason: "interrupted",
      sessionMayHaveChanged: true,
    });
    recovered.connection.close();
    // The process that went away cannot record anything more.
    await hung.service.settled();
  });

  it.each<{
    readonly name: string;
    readonly reason: ContextCompactionRefusalReason;
    readonly arrange: (world: RuntimeWorld) => void;
    readonly principal?: "local-window" | "remote-device";
  }>([
    {
      name: "a paired device",
      reason: "remote-client",
      arrange: () => undefined,
      principal: "remote-device",
    },
    {
      name: "a thread whose mode is disabled",
      reason: "mode-disabled",
      arrange: (world) => {
        world.state.modeEnabled = false;
      },
    },
    {
      name: "a runtime that cannot compact",
      reason: "runtime-cannot-compact",
      arrange: (world) => {
        world.state.support = "unsupported";
      },
    },
    {
      name: "a runtime too old to compact",
      reason: "runtime-version-unsupported",
      arrange: (world) => {
        world.state.support = "unavailable";
      },
    },
    {
      name: "a runtime the host has not reached yet",
      reason: "provider-unavailable",
      arrange: (world) => {
        world.state.support = undefined;
      },
    },
    {
      name: "a thread with no session to resume",
      reason: "no-session",
      arrange: (world) => {
        world.state.hasSession = false;
      },
    },
    {
      name: "a thread with a turn running",
      reason: "turn-running",
      arrange: (world) => {
        world.state.turnRunning = true;
      },
    },
    {
      name: "a signed-out runtime",
      reason: "provider-unavailable",
      arrange: (world) => {
        world.state.providerAvailable = false;
      },
    },
    {
      name: "a thread whose spend ceiling cannot cover the request",
      reason: "spend-ceiling-reached",
      arrange: (world) => {
        world.spend.execute("local-window", {
          kind: "set-spend-ceiling",
          scope: { kind: "thread", threadType: "chat-thread", threadId },
          expectedVersion: decodeAggregateVersion(0),
          policy: { tokenBudget: 100 },
          window: { kind: "lifetime" },
        });
      },
    },
  ])("refuses to compact $name before anything is journaled or asked", (scenario) => {
    const world = createRuntimeWorld({ answer: { kind: "compacted" } });
    planSession(world);
    scenario.arrange(world);
    const principal = scenario.principal ?? "local-window";
    const head = world.fixture.journal.headSequence();

    expect(refusalOf(() => world.service.start(command(), principal, windowId))).toBe(
      scenario.reason,
    );
    expect(world.fixture.journal.headSequence()).toBe(head);
    expect(world.runtime.acquired).toEqual([]);
    expect(world.harness.latestCompaction(subject)).toBeUndefined();
    expect(world.service.inspect(subject, undefined, principal).compaction).toEqual({
      status: "refused",
      reason: scenario.reason,
    });
    world.close();
  });

  describe("a Code thread", () => {
    const codeSubject = decodeContextSubjectRef({
      aggregateType: "code-thread",
      aggregateId: threadId,
    });

    it("compacts a session the host never planned, measured by its latest usage report", async () => {
      const world = createRuntimeWorld(
        {
          answer: { kind: "compacted", tokensAfter: 300 },
          usage: { inputTokens: 50, outputTokens: 20 },
        },
        "code-thread",
      );
      world.state.thread = { mode: "code", projectId, providerInstanceId, modelId };

      expect(world.service.start(command(codeSubject), "local-window", windowId)).toMatchObject({
        kind: "compaction-started",
        executor: { kind: "runtime", driverKind: "codex" },
      });
      await world.service.settled();

      expect(world.harness.latestCompaction(codeSubject)).toMatchObject({
        status: "completed",
        receipt: {
          tokensBefore: { kind: "known", tokens: 1_200, accuracy: "provider-reported" },
          tokensAfter: { kind: "known", tokens: 300 },
          tokensFreed: { kind: "measured", tokens: 900 },
          usage: { kind: "reported", inputTokens: 50, outputTokens: 20 },
        },
      });
      expect(world.opened).toEqual([windowId]);
      // A Code turn takes no provider slot and keeps no ledger row; the
      // compaction keeps to the same accounting and carries its figures on
      // the receipt.
      expect(world.capacity.snapshot(providerInstanceId)).toEqual({
        allocated: { requests: 0, tokens: 0, concurrency: 0 },
        queue: [],
      });
      expect(reportedCompactionUsage(world.fixture.connection)).toEqual([]);
      world.close();
    });

    it("takes the window a compaction since the latest usage report left as its starting point", async () => {
      const world = createRuntimeWorld(
        { answer: { kind: "compacted", tokensAfter: 300 } },
        "code-thread",
      );
      world.state.thread = { mode: "code", projectId, providerInstanceId, modelId };
      world.service.start(command(codeSubject), "local-window", windowId);
      await world.service.settled();

      const again = decodeContextCompactionId("82000000-0000-4000-8000-0000000000c2");
      world.service.start(
        { kind: "compact-session", subject: codeSubject, compactionId: again },
        "local-window",
        windowId,
      );
      await world.service.settled();

      // The usage report predates the first compaction; the window that
      // compaction reported is what the second one starts from.
      expect(world.harness.compaction(codeSubject, again)).toMatchObject({
        status: "completed",
        receipt: {
          tokensBefore: { kind: "known", tokens: 300, accuracy: "provider-reported" },
          tokensFreed: { kind: "measured", tokens: 0 },
        },
      });
      world.close();
    });

    it("calls an older usage report only an upper bound once a compaction left no figure", async () => {
      const world = createRuntimeWorld({ answer: { kind: "compacted" } }, "code-thread");
      world.state.thread = { mode: "code", projectId, providerInstanceId, modelId };
      world.service.start(command(codeSubject), "local-window", windowId);
      await world.service.settled();

      const again = decodeContextCompactionId("82000000-0000-4000-8000-0000000000c2");
      world.service.start(
        { kind: "compact-session", subject: codeSubject, compactionId: again },
        "local-window",
        windowId,
      );
      await world.service.settled();

      expect(world.harness.latestCompaction(codeSubject)).toMatchObject({
        receipt: {
          compactionId: again,
          tokensBefore: { kind: "known", tokens: 1_200, accuracy: "conservative-heuristic" },
        },
      });
      world.close();
    });

    it("refuses a session that never reported an exchange", () => {
      const world = createRuntimeWorld({ answer: { kind: "compacted" } }, "code-thread");
      world.state.thread = { mode: "code", projectId, providerInstanceId, modelId };
      world.state.occupancy = undefined;

      expect(
        refusalOf(() => world.service.start(command(codeSubject), "local-window", windowId)),
      ).toBe("no-session");
      expect(world.runtime.acquired).toEqual([]);
      world.close();
    });

    it("refuses where Code has no compaction support", () => {
      const world = createWorld();
      expect(refusalOf(() => world.service.start(command(codeSubject), "local-window"))).toBe(
        "runtime-cannot-compact",
      );
      world.close();
    });
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
  return { path, connection, journal, projections: runtime.projections, harness, uuid };
}

interface WorldState {
  thread: SessionCompactionThread | undefined;
  turnRunning: boolean;
  modeEnabled: boolean;
  providerAvailable: boolean;
  driverThrows: boolean;
  ownership: "host" | "provider";
  conversation: ReadonlyArray<SessionConversationMessage>;
  /** The provider's stored facts, as the Project's provider policy reads them. */
  provider: ProviderInstance;
  /** Makes the thread read throw, as the host's storage can. */
  readThrows: boolean;
}

type World = ReturnType<typeof createWorld>;

function providerInstance(overrides: { readonly dataTags?: ReadonlyArray<"eu" | "zdr"> } = {}) {
  return decodeProviderInstance({
    id: providerInstanceId,
    displayName: "Test endpoint",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://example.invalid/v1/",
      authentication: "bearer",
      protocol: "responses",
      manualModelIds: ["model-a"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    ...(overrides.dataTags === undefined ? {} : { dataTags: overrides.dataTags }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function createWorld(providerOptions: FakeProviderOptions = {}) {
  const fixture = createFixture();
  const provider = fakeProvider(providerOptions);
  const state: WorldState = {
    thread: { mode: "chat", providerInstanceId, modelId },
    turnRunning: false,
    modeEnabled: true,
    providerAvailable: true,
    driverThrows: false,
    ownership: "host",
    conversation,
    provider: providerInstance(),
    readThrows: false,
  };
  const reads = { drivers: 0, conversations: 0, spendAdmissions: 0, spendSnapshots: 0 };
  const announced: Array<{ readonly threadId: string; readonly compaction: unknown }> = [];
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
  const threadsFor = () => ({
    read: () => {
      if (state.readThrows) throw new Error("The thread store is unavailable.");
      return state.thread;
    },
    turnRunning: () => state.turnRunning,
    conversation: () => {
      reads.conversations += 1;
      return state.conversation;
    },
    scratchRoot: async () => "/tmp/octant-session-compaction/thread",
    settled: (threadId: string, compaction: unknown) => {
      announced.push({ threadId, compaction });
    },
  });
  const service = new SessionCompactionService({
    harness: fixture.harness,
    threads: { "chat-thread": threadsFor(), "work-thread": threadsFor() },
    modeEnabled: () => state.modeEnabled,
    conversationOwner: () => (state.ownership === "provider" ? "runtime" : "host"),
    providerFacts: () => ({ provider: state.provider }),
    availableDriver: () => {
      reads.drivers += 1;
      if (state.driverThrows) throw new Error("Provider driver is not effective.");
      if (!state.providerAvailable) return undefined;
      return state.ownership === "provider"
        ? { ...provider.driver, conversationOwnership: "provider" }
        : provider.driver;
    },
    capacity,
    spendCeiling: {
      admit: (input) => {
        reads.spendAdmissions += 1;
        return spend.admit(input);
      },
      settle: (input) => spend.settle(input),
      snapshot: (input) => {
        reads.spendSnapshots += 1;
        return spend.snapshot(input);
      },
    },
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
    reads,
    announced,
    capacity,
    spend,
    service,
    close: () => fixture.connection.close(),
  };
}

function planSession(
  world: { readonly harness: ContextHarnessService },
  target: ContextSubjectRef = subject,
): void {
  world.harness.planTurn({
    subject: target,
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

function reportedCompactionUsage(
  connection: ReturnType<typeof createFixture>["connection"],
): ReadonlyArray<{ readonly input_tokens: number; readonly output_tokens: number }> {
  return connection
    .prepare(
      `SELECT input_tokens, output_tokens FROM usage_record_projection
       WHERE request_shape = 'context-compaction' ORDER BY last_sequence ASC`,
    )
    .all() as ReadonlyArray<{ readonly input_tokens: number; readonly output_tokens: number }>;
}

function refusalOf(
  start: () => SessionCompactionStart,
): ContextCompactionRefusalReason | undefined {
  const result = start();
  return result.kind === "compaction-refused" ? result.reason : undefined;
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
  const recorded = {
    sends: 0,
    materials: [] as ReadonlyArray<string>,
    started: undefined as object | undefined,
    sentTools: undefined as ReadonlyArray<unknown> | undefined,
  };
  const queue = Effect.runSync(Queue.unbounded<never>());
  const connection = {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: (input: { readonly sessionId: string }) => {
      recorded.started = input;
      return Effect.succeed({ sessionId: input.sessionId });
    },
    send: (input: {
      readonly sessionId: string;
      readonly prompt: string;
      readonly tools: ReadonlyArray<unknown>;
    }) =>
      Effect.suspend(() => {
        recorded.sends += 1;
        recorded.sentTools = input.tools;
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
    get started() {
      return recorded.started;
    },
    get sentTools() {
      return recorded.sentTools;
    },
  };
}

const windowId = "82000000-0000-4000-8000-0000000000e1" as WindowId;
const projectId = "82000000-0000-4000-8000-0000000000aa";
const runtimeSession = {
  acquire: {
    instanceId: providerInstanceId,
    projectRoot: "/tmp/octant-session-compaction",
    mode: "chat",
  },
  resume: {
    sessionId: decodeProviderSessionId("82000000-0000-4000-8000-0000000000e2"),
    resumeCursor: { driverKind: "codex", value: "thread-1" },
    executionPolicy: "approval-gated",
    modelId,
    tools: [],
  },
} as const satisfies {
  readonly acquire: ProviderAcquireInput;
  readonly resume: ProviderSessionResume;
};

interface RuntimeWorldState {
  thread: SessionCompactionThread | undefined;
  turnRunning: boolean;
  modeEnabled: boolean;
  providerAvailable: boolean;
  support: "supported" | "unsupported" | "unavailable" | undefined;
  hasSession: boolean;
  occupancy: { readonly tokens: number; readonly observedAt: string } | undefined;
}

type RuntimeWorld = ReturnType<typeof createRuntimeWorld>;

function codexInstance() {
  return decodeProviderInstance({
    id: providerInstanceId,
    displayName: "Codex",
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/missing/codex" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

/** A thread whose runtime keeps its session, on a fake runtime connection. */
function createRuntimeWorld(
  runtimeOptions: FakeRuntimeOptions = {},
  kind: "chat-thread" | "code-thread" = "chat-thread",
) {
  const fixture = createFixture();
  const runtime = fakeRuntime(runtimeOptions);
  const state: RuntimeWorldState = {
    thread: { mode: "chat", providerInstanceId, modelId },
    turnRunning: false,
    modeEnabled: true,
    providerAvailable: true,
    support: "supported",
    hasSession: true,
    // Reported before anything in these tests compacts the session.
    occupancy: { tokens: 1_200, observedAt: "2026-07-18T20:00:00.000Z" },
  };
  const opened: Array<WindowId | undefined> = [];
  const announced: Array<{ readonly threadId: string; readonly compaction: unknown }> = [];
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
      [kind]: {
        read: () => state.thread,
        turnRunning: () => state.turnRunning,
        settled: (threadId: string, compaction: unknown) => {
          announced.push({ threadId, compaction });
        },
        runtimeSessions: {
          exists: () => state.hasSession,
          ...(kind === "code-thread" ? { occupancy: () => state.occupancy } : {}),
          open: async (_threadId: string, window: WindowId | undefined) => {
            opened.push(window);
            return runtimeSession;
          },
        },
      },
    },
    modeEnabled: () => state.modeEnabled,
    conversationOwner: () => "runtime",
    runtimeCompaction: () => state.support,
    providerFacts: () => ({ provider: codexInstance() }),
    availableDriver: () => (state.providerAvailable ? runtime.driver : undefined),
    capacity,
    spendCeiling: spend,
    uuid: fixture.uuid,
    runtimeTimeoutMs: 50,
    runtimeShutdownTimeoutMs: 50,
    runtimeSettleGraceMs: 50,
  });
  return {
    fixture,
    path: fixture.path,
    harness: fixture.harness,
    runtime,
    state,
    opened,
    announced,
    capacity,
    spend,
    service,
    close: () => fixture.connection.close(),
  };
}

interface FakeRuntimeOptions {
  /** How the runtime answers; a plain compaction when absent. */
  readonly answer?: ProviderSessionCompaction;
  /** Takes the request and never answers. */
  readonly hang?: boolean;
  /**
   * Ends a running compaction when interrupted, as Codex does with the turn it
   * runs one as. Otherwise an interrupt with no turn in flight is refused.
   */
  readonly interruptible?: boolean;
  readonly resumeFails?: boolean;
  /** The connection fails the request instead of answering it. */
  readonly compactFails?: boolean;
  /** Reported on the session before the run that carried the compaction closes. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Runs when the runtime is asked, before it answers. */
  readonly onCompact?: () => void;
}

/** A runtime connection whose session compacts the way its options say. */
function fakeRuntime(options: FakeRuntimeOptions) {
  const recorded = {
    acquired: [] as Array<unknown>,
    resumed: [] as Array<unknown>,
    compactions: [] as Array<string>,
    stops: 0,
    /** Interrupts and stops, in the order they reached the session. */
    endings: [] as Array<"interrupt" | "stop">,
  };
  const queue = Effect.runSync(Queue.unbounded<never>());
  const connection = {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: () =>
      Effect.fail({ category: "protocol", message: "A compaction never starts a session." }),
    resume: (input: ProviderSessionResume) =>
      Effect.suspend(() => {
        recorded.resumed.push(input);
        return options.resumeFails === true
          ? Effect.fail({ category: "unavailable", message: "The session is gone." })
          : Effect.succeed({ sessionId: input.sessionId, resumeCursor: input.resumeCursor });
      }),
    send: () => Effect.void,
    compact: (input: { readonly sessionId: string; readonly compactionId: string }) =>
      Effect.suspend(() => {
        recorded.compactions.push(input.compactionId);
        options.onCompact?.();
        if (options.compactFails === true) {
          return Effect.fail({ category: "protocol", message: "The runtime went away." });
        }
        if (options.hang === true) return Effect.never;
        return Effect.gen(function* () {
          if (options.usage !== undefined) {
            yield* Queue.offer(queue, {
              kind: "usage",
              sessionId: input.sessionId,
              ...options.usage,
            } as never);
          }
          yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
          return options.answer ?? ({ kind: "compacted" } as const);
        });
      }),
    interrupt: (sessionId: string) =>
      Effect.suspend(() => {
        recorded.endings.push("interrupt");
        if (options.interruptible !== true || recorded.compactions.length === 0) {
          return Effect.fail({ category: "protocol", message: "No turn is running." });
        }
        return Queue.offer(queue, { kind: "interrupted", sessionId } as never);
      }),
    stop: () =>
      Effect.sync(() => {
        recorded.stops += 1;
        recorded.endings.push("stop");
      }),
    answerApproval: () => Effect.void,
    answerUserInput: () => Effect.void,
    answerTool: () => Effect.void,
  };
  const driver = {
    conversationOwnership: "provider",
    acquire: (input: ProviderAcquireInput) =>
      Effect.sync(() => {
        recorded.acquired.push(input);
        return connection;
      }),
  } as unknown as ProviderDriver;
  return {
    driver,
    acquired: recorded.acquired,
    resumed: recorded.resumed,
    compactions: recorded.compactions,
    endings: recorded.endings,
    get stops() {
      return recorded.stops;
    },
  };
}
