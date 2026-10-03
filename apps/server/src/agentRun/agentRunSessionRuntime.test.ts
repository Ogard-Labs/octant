import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import {
  purgeAgentRunSubjectContent,
  agentRunContentSubject,
} from "../persistence/agentRunContentStore";
import { AgentRunSessionStore } from "./agentRunSessionStore";
import { AgentRunLiveConversationStore } from "./agentRunLiveConversationStore";
import { Effect, Queue, Stream } from "effect";
import {
  decodeContextSubjectRef,
  decodeProviderServiceLimits,
  type AgentRun,
  type AgentRunAuthority,
  type ProviderContextBlock,
  type ProviderExecutionPolicy,
  type ProviderTurnInput,
  type ProviderSessionId,
  type ProviderResumeCursor,
} from "@octant/contracts";
import type { ProviderAcquireInput, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  makeProviderCapacityScheduler,
  makeUnobservedProviderCapacityFacts,
} from "../context/contextRuntime";
import { AgentRunSessionError, type AgentRunSessionOutcome } from "./agentRunSessionPort";
import { AgentRunSessionSupervisor } from "./agentRunSessionSupervisor";
import {
  clampAgentRunSessionAuthority,
  createAgentRunSessionRuntime,
  createRecordedAgentRunContextSnapshotPort,
  type AgentRunSessionRuntimeOptions,
} from "./agentRunSessionRuntime";

const testDirectories: string[] = [];
afterEach(() => {
  for (const directory of testDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-child-session-"));
  testDirectories.push(directory);
  return join(directory, "child.sqlite");
}

const now = "2026-08-01T14:00:00.000Z";
const retryUntil = "2026-08-01T14:05:00.000Z";
const providerInstanceId = "55555555-5555-4555-8555-555555555555";
const reservationId = "44444444-4444-4444-8444-444444444444";
const sessionId = "99999999-9999-4999-8999-999999999999";
const runId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "66666666-6666-4666-8666-666666666666";

const authority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

function agentRun(overrides?: {
  readonly authority?: AgentRunAuthority;
  readonly workspaceReceipt?: AgentRun["workspaceReceipt"];
  readonly contextSnapshot?: ReadonlyArray<ProviderContextBlock>;
}): AgentRun {
  const effective = overrides?.authority ?? authority;
  return {
    id: runId as never,
    requestId: "22222222-2222-4222-8222-222222222222" as never,
    parentThreadId: "33333333-3333-4333-8333-333333333333" as never,
    depth: 0,
    role: "research",
    task: "Summarise the incident report",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "starting",
    authority: effective,
    routingReceipt: {
      executionResolution: {
        providerInstanceId: providerInstanceId as never,
        modelId: "gpt-4o" as never,
        hostId: "local" as never,
        // Deliberately wider than the run's clamped authority: execution must
        // narrow to the run, never re-widen to what was originally proposed.
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        effectivePermissions: {
          filesystem: false,
          shell: false,
          git: false,
          network: false,
          tools: true,
          subagents: true,
        },
        source: "project-default",
        fallbackChain: ["project-default"],
        downgradeReasons: [],
      },
      selectedExecutionKind: "octant-managed",
      attemptedExecutionKind: "octant-managed",
      selectedProviderInstanceId: providerInstanceId as never,
      selectedModelId: "gpt-4o" as never,
      fallbackCandidates: [],
      capabilityDegradations: [],
      contextSnapshotId: snapshotId as never,
      ...(overrides?.contextSnapshot === undefined
        ? {}
        : { admittedContextBlocks: overrides.contextSnapshot.length }),
      effectiveAuthorityDigest: "digest",
      usageQuality: "unavailable",
      hostId: "local" as never,
      mode: overrides?.workspaceReceipt?.mode ?? "chat",
    },
    workspaceReceipt: overrides?.workspaceReceipt ?? {
      kind: "chat-virtual",
      mode: "chat",
    },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2 as never,
    createdAt: now as never,
    updatedAt: now as never,
  } as AgentRun;
}

/**
 * The production port over a fake content store. The blocks a run was admitted
 * with are stored under its snapshot id, so `stored` standing in for that store
 * is what lets these tests exercise the real resolution and its failures.
 */
function recordedSnapshotPort(
  run: AgentRun,
  stored?: ReadonlyArray<ProviderContextBlock>,
): ReturnType<typeof createRecordedAgentRunContextSnapshotPort> {
  return createRecordedAgentRunContextSnapshotPort({
    getById: (id) => (String(id) === String(run.id) ? run : undefined),
    readAdmittedContext: ({ runId: readRunId, contextSnapshotId }) =>
      String(readRunId) === String(run.id) &&
      String(contextSnapshotId) === String(run.routingReceipt.contextSnapshotId)
        ? stored
        : undefined,
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

function retryingServiceLimits() {
  return decodeProviderServiceLimits({
    providerInstanceId,
    scope: "provider-instance",
    requests: { status: "available", limit: 100, remaining: 0 },
    tokens: { status: "unavailable" },
    concurrency: { status: "available", limit: 2, remaining: 2 },
    retry: { status: "active", until: retryUntil },
    quota: "exhausted",
    source: "runtime-reported",
    confidence: "high",
    updatedAt: now,
  });
}

/** Concurrency of exactly one, so a retained slot is observable as a wait. */
function soleSlotServiceLimits() {
  return decodeProviderServiceLimits({
    providerInstanceId,
    scope: "provider-instance",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "available", limit: 1, remaining: 1 },
    retry: { status: "inactive" },
    quota: "unknown",
    source: "runtime-reported",
    confidence: "medium",
    updatedAt: now,
  });
}

function scheduler(clock?: () => number) {
  return makeProviderCapacityScheduler({
    now: clock ?? (() => Date.parse(now)),
    random: () => 0.5,
    maxRetryJitterMs: 0,
    ambiguousReservationTtlMs: 60_000,
  });
}

/** Counts terminal capacity signals, so "released exactly once" is provable. */
function countingScheduler(clock?: () => number) {
  const counted = scheduler(clock);
  const recordTerminal = vi.spyOn(counted, "recordTerminal");
  return { capacityScheduler: counted, recordTerminal };
}

function otherTurnSubmission(capacityScheduler: ReturnType<typeof scheduler>) {
  return capacityScheduler.submit({
    reservationId: "77777777-7777-4777-8777-777777777777" as never,
    subject: decodeContextSubjectRef({
      aggregateType: "code-thread",
      aggregateId: "88888888-8888-4888-8888-888888888888",
    }),
    providerInstanceId: providerInstanceId as never,
    modelId: "gpt-4o" as never,
    estimatedTokens: 1,
    requests: 1,
    origin: "thread",
  });
}

interface FakeProvider {
  readonly driver: ProviderDriver;
  readonly acquired: ProviderAcquireInput[];
  readonly executionPolicies: ProviderExecutionPolicy[];
  readonly turns: ProviderTurnInput[];
  readonly answeredApprovals: ReadonlyArray<{ readonly approved: boolean }>;
  readonly answeredTools: ReadonlyArray<{ readonly isError?: boolean }>;
  readonly resumes: Array<{
    readonly sessionId: ProviderSessionId;
    readonly resumeCursor: ProviderResumeCursor;
  }>;
  readonly answeredQuestions: Array<{ readonly answer: string }>;
  readonly steered: string[];
  readonly interrupts: string[];
  readonly stops: string[];
  readonly emit: (event: unknown) => Promise<void>;
  /** Lets a provider that could not confirm a shutdown recover for a retry. */
  readonly confirmShutdown: () => void;
}

function fakeProvider(options?: {
  readonly onSend?: (emit: FakeProvider["emit"]) => void;
  /** Rejects both shutdown calls, as a provider whose channel is gone would. */
  readonly shutdownFails?: boolean;
  /** Never settles the named phase, as a wedged subprocess or channel would. */
  readonly wedge?: "start" | "send" | "stop";
  /** Makes teardown asynchronous, as a real control-channel round trip is. */
  readonly shutdownDelayMs?: number;
  readonly resumable?: boolean;
  readonly steerable?: boolean;
  readonly completeOnSteer?: boolean;
  readonly changedResumeIdentity?: boolean;
}) {
  let shutdownFails = options?.shutdownFails ?? false;
  let wedge = options?.wedge;
  const queue = Effect.runSync(Queue.unbounded<never>());
  const acquired: ProviderAcquireInput[] = [];
  const executionPolicies: ProviderExecutionPolicy[] = [];
  const turns: ProviderTurnInput[] = [];
  const answeredApprovals: { readonly approved: boolean }[] = [];
  const answeredTools: { readonly isError?: boolean }[] = [];
  const resumes: FakeProvider["resumes"] = [];
  const answeredQuestions: FakeProvider["answeredQuestions"] = [];
  const steered: string[] = [];
  const cursor = { driverKind: "codex" as const, value: "private-provider-session" };
  const interrupts: string[] = [];
  const stops: string[] = [];
  const emit = async (event: unknown): Promise<void> => {
    await Effect.runPromise(Queue.offer(queue, event as never));
  };
  const connection = {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: (input: { readonly executionPolicy: ProviderExecutionPolicy }) => {
      executionPolicies.push(input.executionPolicy);
      return wedge === "start"
        ? Effect.never
        : Effect.succeed({ sessionId, ...(options?.resumable ? { resumeCursor: cursor } : {}) });
    },
    resume: (input: {
      readonly sessionId: ProviderSessionId;
      readonly resumeCursor: ProviderResumeCursor;
    }) => {
      resumes.push(input);
      return Effect.succeed({
        sessionId: options?.changedResumeIdentity ? providerInstanceId : input.sessionId,
      });
    },
    ...(options?.steerable
      ? {
          steer: (input: { readonly message: string }) =>
            Effect.sync(() => {
              steered.push(input.message);
              if (options.completeOnSteer) {
                Effect.runSync(Queue.offer(queue, { kind: "completed", sessionId } as never));
              }
              return "steered" as const;
            }),
        }
      : {}),
    send: (input: ProviderTurnInput) =>
      Effect.sync(() => {
        turns.push(input);
        options?.onSend?.(emit);
      }).pipe(wedge === "send" ? Effect.zipRight(Effect.never) : (self) => self),
    interrupt: (session: string) =>
      Effect.suspend(() => {
        interrupts.push(session);
        return shutdownFails
          ? Effect.fail({ category: "provider-failed", message: "Interrupt was refused." })
          : Effect.void;
      }),
    stop: (session: string) =>
      Effect.suspend(() => {
        if (wedge === "stop") {
          stops.push(session);
          return Effect.never;
        }
        const settle = shutdownFails
          ? Effect.fail({ category: "provider-failed", message: "Stop was refused." })
          : Effect.void;
        return options?.shutdownDelayMs === undefined
          ? Effect.sync(() => void stops.push(session)).pipe(Effect.zipRight(settle))
          : Effect.sleep(options.shutdownDelayMs).pipe(
              Effect.zipRight(Effect.sync(() => void stops.push(session))),
              Effect.zipRight(settle),
            );
      }),
    answerApproval: (input: { readonly approved: boolean }) =>
      Effect.sync(() => void answeredApprovals.push(input)),
    answerUserInput: (input: { readonly answer: string }) =>
      Effect.sync(() => void answeredQuestions.push(input)),
    answerTool: (input: { readonly isError?: boolean }) =>
      Effect.sync(() => void answeredTools.push(input)),
  };
  const provider: FakeProvider = {
    driver: {
      kind: "codex",
      conversationOwnership: "provider",
      acquire: (input: ProviderAcquireInput) => {
        acquired.push(input);
        return Effect.succeed(connection);
      },
    } as unknown as ProviderDriver,
    acquired,
    executionPolicies,
    turns,
    answeredApprovals,
    answeredTools,
    resumes,
    answeredQuestions,
    steered,
    interrupts,
    stops,
    emit,
    confirmShutdown: () => {
      shutdownFails = false;
      wedge = undefined;
    },
  };
  return provider;
}

const context: ReadonlyArray<ProviderContextBlock> = [
  { kind: "instructions", text: "Only report what the snapshot contains." },
];

function runtimeOptions(
  provider: FakeProvider,
  overrides?: Partial<AgentRunSessionRuntimeOptions>,
): AgentRunSessionRuntimeOptions {
  const uuids = [reservationId, sessionId];
  let index = 0;
  return {
    resolveDriver: () => provider.driver,
    capacityScheduler: scheduler(),
    context: { resolve: () => context },
    uuid: () => uuids[index++] ?? `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    scratchRoot: () => "/tmp/octant-agent-run-scratch/child",
    serviceLimits: () => serviceLimits(),
    timeoutMs: 2_000,
    ...overrides,
  };
}

function settled(handle: {
  readonly onSettled: (listener: (outcome: AgentRunSessionOutcome) => void) => void;
}): Promise<AgentRunSessionOutcome> {
  return new Promise((resolve) => handle.onSettled(resolve));
}

describe("clampAgentRunSessionAuthority", () => {
  it("re-derives authority from the run instead of re-widening to the receipt proposal", () => {
    // The routing receipt records the wider originally-proposed authority; the
    // run carries the clamped one. Execution must land on the run's.
    expect(clampAgentRunSessionAuthority(agentRun())).toEqual(authority);
  });

  it("fails closed when the stored authority is wider than its recorded ceilings", () => {
    const widened = agentRun({
      authority: { ...authority, shell: true, executionPolicy: "full-access" },
    });

    expect(() => clampAgentRunSessionAuthority(widened)).toThrowError(AgentRunSessionError);
    try {
      clampAgentRunSessionAuthority(widened);
    } catch (error) {
      expect((error as AgentRunSessionError).reason).toBe("authority-drift");
    }
  });
});

describe("createRecordedAgentRunContextSnapshotPort", () => {
  it("resolves the admitted selection recorded with the run's own snapshot id", () => {
    const run = agentRun();
    const port = recordedSnapshotPort(run);

    // A run whose admission recorded no parent context runs with none, and
    // never consults the store for blocks it was never admitted with.
    expect(
      port.resolve({
        runId: run.id,
        contextSnapshotId: run.routingReceipt.contextSnapshotId,
      }),
    ).toEqual([]);
  });

  it("resolves exactly the parent selection admitted with the run", () => {
    const admitted: ReadonlyArray<ProviderContextBlock> = [
      { kind: "user-message", text: "Which service paged first?" },
      { kind: "assistant-message", text: "The ingest worker paged at 02:14." },
    ];
    const run = agentRun({ contextSnapshot: admitted });
    const port = recordedSnapshotPort(run, admitted);

    expect(
      port.resolve({
        runId: run.id,
        contextSnapshotId: run.routingReceipt.contextSnapshotId,
      }),
    ).toEqual(admitted);
  });

  it("fails closed when the admitted selection was purged with its parent thread", () => {
    // The run still records that it was admitted with one block; the block
    // itself went with the deleted thread. Running the child on an empty
    // selection would give it less context than the user approved, so the
    // start fails closed instead.
    const run = agentRun({
      contextSnapshot: [{ kind: "user-message", text: "Which service paged first?" }],
    });
    const port = recordedSnapshotPort(run);

    expect(
      port.resolve({
        runId: run.id,
        contextSnapshotId: run.routingReceipt.contextSnapshotId,
      }),
    ).toBeUndefined();
  });

  it("hands a run started by its graph the replies of the runs it waited for", () => {
    const first = {
      ...agentRun(),
      id: "44444444-4444-4444-8444-444444444441" as never,
      task: "Map the ingest paths",
    } as AgentRun;
    const second = {
      ...agentRun(),
      id: "44444444-4444-4444-8444-444444444442" as never,
      role: "review",
    } as AgentRun;
    const joined = { ...agentRun(), dependsOn: [first.id, second.id] } as AgentRun;
    const runs = new Map([first, second, joined].map((entry) => [String(entry.id), entry]));
    const replies = new Map([
      [String(first.id), "Ingest has two paths."],
      [String(second.id), "Both paths look safe."],
    ]);
    const port = createRecordedAgentRunContextSnapshotPort({
      getById: (id) => runs.get(String(id)),
      readAdmittedContext: () => undefined,
      readResultText: (id) => replies.get(String(id)),
    });
    const resolve = () =>
      port.resolve({
        runId: joined.id,
        contextSnapshotId: joined.routingReceipt.contextSnapshotId,
      });

    const context = resolve();
    expect(context?.map((block) => block.kind)).toEqual(["work-item", "work-item"]);
    expect(context?.[0]?.text).toContain("Its task: Map the ingest paths");
    expect(context?.[0]?.text).toContain("Ingest has two paths.");
    expect(context?.[1]?.text).toContain("Result of review run");

    // A reply that is gone fails the start closed: the run would otherwise
    // begin without the input it was told to wait for.
    replies.delete(String(second.id));
    expect(resolve()).toBeUndefined();
  });

  it("fails closed for an unknown run or a snapshot id the run never recorded", () => {
    const admitted: ReadonlyArray<ProviderContextBlock> = [
      { kind: "user-message", text: "Which service paged first?" },
    ];
    const run = agentRun({ contextSnapshot: admitted });
    const port = recordedSnapshotPort(run, admitted);

    expect(
      port.resolve({
        runId: "22222222-2222-4222-8222-222222222222" as never,
        contextSnapshotId: run.routingReceipt.contextSnapshotId,
      }),
    ).toBeUndefined();
    expect(
      port.resolve({
        runId: run.id,
        contextSnapshotId: "77777777-7777-4777-8777-777777777777" as never,
      }),
    ).toBeUndefined();
  });
});

describe("createAgentRunSessionRuntime", () => {
  it("publishes managed response deltas without changing the terminal outcome", async () => {
    const provider = fakeProvider();
    const started: string[] = [];
    const deltas: Array<{ readonly text: string; readonly occurredAt: string }> = [];
    const settledOutcomes: AgentRunSessionOutcome[] = [];
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        onSessionStarted: ({ runId: startedRunId }) => started.push(String(startedRunId)),
        onTextDelta: ({ text, occurredAt }) => deltas.push({ text, occurredAt }),
        onSessionSettled: ({ outcome }) => settledOutcomes.push(outcome),
      }),
    );
    const outcome = settled(runtime.start(agentRun()));
    await provider.emit({ kind: "text-delta", sessionId, text: "partial" });
    await provider.emit({ kind: "completed", sessionId });
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
    expect(started).toHaveLength(1);
    expect(deltas).toEqual([
      {
        text: "partial",
        occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    ]);
    expect(settledOutcomes).toHaveLength(1);
  });

  it("ignores malformed provider events and keeps a throwing observer from failing the run", async () => {
    const provider = fakeProvider();
    const deltas: string[] = [];
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        onTextDelta: ({ text }) => {
          deltas.push(text);
          throw new Error("observer failed");
        },
      }),
    );
    const outcome = settled(runtime.start(agentRun()));
    await provider.emit({ kind: "text-delta", sessionId });
    await provider.emit({
      kind: "child-agent-activity",
      sessionId,
      childAgentId: "child-1",
      status: "running",
      summary: "secret native transcript",
    });
    await provider.emit({ kind: "text-delta", sessionId, text: "visible", occurredAt: now });
    await provider.emit({ kind: "completed", sessionId });
    await expect(outcome).resolves.toMatchObject({ kind: "completed", responseText: "visible" });
    expect(deltas).toEqual(["visible"]);
  });

  it("runs the child as an in-process provider session under the clamped authority", async () => {
    const provider = fakeProvider({
      onSend: (emit) => {
        void emit({
          kind: "text-delta",
          sessionId,
          text: "Report ready.",
        }).then(() =>
          emit({
            kind: "usage",
            sessionId,
            inputTokens: 20,
            outputTokens: 5,
          }).then(() => emit({ kind: "completed", sessionId })),
        );
      },
    });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));

    const handle = runtime.start(agentRun());
    const outcome = await settled(handle);

    expect(outcome).toEqual({
      kind: "completed",
      responseText: "Report ready.",
      usage: { inputTokens: 20, outputTokens: 5 },
    });
    expect(provider.acquired[0]).toMatchObject({
      mode: "chat",
      projectRoot: "/tmp/octant-agent-run-scratch/child",
    });
    expect(provider.executionPolicies).toEqual(["plan"]);
    expect(provider.turns[0]).toMatchObject({
      prompt: "Summarise the incident report",
      context: [
        {
          kind: "instructions",
          text: "Only report what the snapshot contains.",
        },
      ],
      attachments: [],
      tools: [],
    });
    expect(provider.stops).toEqual([sessionId]);
  });

  it("sends the child exactly the parent context its admission recorded", async () => {
    const admitted: ReadonlyArray<ProviderContextBlock> = [
      { kind: "user-message", text: "Which service paged first?" },
      { kind: "assistant-message", text: "The ingest worker paged at 02:14." },
    ];
    const run = agentRun({ contextSnapshot: admitted });
    const provider = fakeProvider({
      onSend: (emit) => {
        void emit({ kind: "text-delta", sessionId, text: "Read." }).then(() =>
          emit({ kind: "completed", sessionId }),
        );
      },
    });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        // The production port, not the fixture: a child must run under the
        // selection its own journaled admission recorded.
        context: recordedSnapshotPort(run, admitted),
      }),
    );

    const handle = runtime.start(run);
    await settled(handle);

    expect(provider.turns[0]?.context).toEqual(admitted);
  });

  it("declines provider approvals instead of consenting on the user's behalf", async () => {
    const provider = fakeProvider({
      onSend: (emit) => {
        void emit({
          kind: "approval-request",
          sessionId,
          requestId: "req-1",
          action: "write-file",
          description: "Write a report",
        }).then(() =>
          emit({ kind: "text-delta", sessionId, text: "Done." }).then(() =>
            emit({ kind: "completed", sessionId }),
          ),
        );
      },
    });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));

    const outcome = await settled(runtime.start(agentRun()));

    expect(outcome.kind).toBe("completed");
    expect(provider.answeredApprovals).toMatchObject([{ approved: false }]);
  });

  it("reports a completion without a visible reply as failed rather than completed", async () => {
    const provider = fakeProvider({
      onSend: (emit) => {
        void emit({ kind: "text-delta", sessionId, text: "   " }).then(() =>
          emit({ kind: "completed", sessionId }),
        );
      },
    });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));

    const outcome = await settled(runtime.start(agentRun()));

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { category: "provider-failed" },
    });
  });

  it("cancels the session and resolves stop only after the provider is stopped", async () => {
    const provider = fakeProvider();
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));

    const handle = runtime.start(agentRun());
    const outcome = settled(handle);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));
    await runtime.stop(agentRun().id);

    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(provider.interrupts).toEqual([sessionId]);
    expect(provider.stops).toEqual([sessionId]);
  });

  it("shuts down and releases a confirmed cancellation exactly once", async () => {
    const capacityScheduler = scheduler();
    const provider = fakeProvider();
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider, { capacityScheduler }));

    const handle = runtime.start(agentRun());
    const outcome = settled(handle);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));
    await runtime.stop(agentRun().id);
    // The session is gone once its stop is confirmed, so a repeated stop must
    // not shut the provider down or end the reservation a second time.
    await runtime.stop(agentRun().id);

    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(provider.interrupts).toEqual([sessionId]);
    expect(provider.stops).toEqual([sessionId]);
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });

  it("rejects the stop when the provider shutdown was never confirmed", async () => {
    const provider = fakeProvider({ shutdownFails: true });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));

    const handle = runtime.start(agentRun());
    const outcomes: AgentRunSessionOutcome[] = [];
    handle.onSettled((observed) => void outcomes.push(observed));
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));

    await expect(runtime.stop(agentRun().id)).rejects.toThrowError(/shutdown was not confirmed/i);

    // The provider execution may still be live, so no terminal outcome may be
    // published: a cancellation nobody observed must stay pending.
    expect(outcomes).toEqual([]);
    expect(provider.stops).toEqual([sessionId]);
  });

  it("reports a turn the provider already ended even when its shutdown fails", async () => {
    const provider = fakeProvider({
      shutdownFails: true,
      onSend: (emit) => {
        void emit({ kind: "text-delta", sessionId, text: "Report ready." }).then(() =>
          emit({ kind: "completed", sessionId }),
        );
      },
    });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));

    const outcome = await settled(runtime.start(agentRun()));

    // The provider reported this turn's end itself, so the result is delivered.
    // Withholding it would strand a finished child on a teardown detail.
    expect(outcome).toMatchObject({ kind: "completed", responseText: "Report ready." });
  });

  it("keeps a session whose shutdown failed supervised and stops it on a retry", async () => {
    const provider = fakeProvider({ shutdownFails: true });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));
    const observed: AgentRunSessionOutcome[] = [];
    const supervisor = new AgentRunSessionSupervisor({
      port: runtime,
      onSessionSettled: (input) => void observed.push(input.outcome),
    });
    const run = agentRun();

    supervisor.start(run);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));
    await expect(supervisor.stop(run.id)).rejects.toThrowError(/shutdown was not confirmed/i);

    // The runtime's rejection is what lets the supervisor keep the session, so
    // nothing terminal is journaled and the cancellation stays retryable.
    expect(supervisor.activeRunIds()).toEqual([run.id]);
    expect(observed).toEqual([]);

    provider.confirmShutdown();
    await supervisor.stop(run.id);

    expect(provider.stops).toEqual([sessionId, sessionId]);
    expect(observed).toEqual([{ kind: "cancelled" }]);
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("completes a teardown the provider answers asynchronously after cancelling", async () => {
    // The bound reopens interruptibility inside a finalizer that cancellation
    // itself triggered, so a teardown with a real round trip is the case that
    // proves the escape abandons only a wedged call — never the shutdown.
    const provider = fakeProvider({ shutdownDelayMs: 20 });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));

    const handle = runtime.start(agentRun());
    const outcome = settled(handle);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));
    await runtime.stop(agentRun().id);

    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(provider.stops).toEqual([sessionId]);
  });

  it("bounds a teardown the provider never settles instead of hanging the stop", async () => {
    const capacityScheduler = scheduler();
    const provider = fakeProvider({ wedge: "stop" });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, { capacityScheduler, shutdownTimeoutMs: 50 }),
    );
    const observed: AgentRunSessionOutcome[] = [];
    const supervisor = new AgentRunSessionSupervisor({
      port: runtime,
      onSessionSettled: (input) => void observed.push(input.outcome),
    });
    const run = agentRun();

    supervisor.start(run);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));

    // A stop that never settles must reject on the teardown bound rather than
    // wait forever: a hang would publish no outcome and free nothing at all.
    await expect(supervisor.stop(run.id)).rejects.toThrowError(/shutdown was not confirmed/i);

    // Unconfirmed is the same state a rejected stop produces, so the session
    // stays owned and its cancellation stays pending and retryable.
    expect(supervisor.activeRunIds()).toEqual([run.id]);
    expect(observed).toEqual([]);
    // The bound lets the release path finish without ending the reservation:
    // the connection behind it could not be stopped, so its slot stays claimed.
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("running");

    provider.confirmShutdown();
    await supervisor.stop(run.id);

    expect(observed).toEqual([{ kind: "cancelled" }]);
    expect(supervisor.activeRunIds()).toEqual([]);
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });

  it("keeps the provider's slot claimed while a shutdown stays unconfirmed", async () => {
    let clockMs = Date.parse(now);
    const capacityScheduler = scheduler(() => clockMs);
    const provider = fakeProvider({ wedge: "stop" });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        capacityScheduler,
        shutdownTimeoutMs: 50,
        serviceLimits: () => soleSlotServiceLimits(),
        capacityEnforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
      }),
    );
    const supervisor = new AgentRunSessionSupervisor({ port: runtime, onSessionSettled: () => {} });
    const run = agentRun();

    supervisor.start(run);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));
    await expect(supervisor.stop(run.id)).rejects.toThrowError(/shutdown was not confirmed/i);

    // The provider never confirmed it ended the session, so the request behind
    // this reservation may still be executing. Reporting it terminal would let
    // the scheduler age it out and dispatch work past the provider's boundary.
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("running");

    clockMs += 120_000;
    expect(capacityScheduler.expireAmbiguous().released).toEqual([]);
    expect(otherTurnSubmission(capacityScheduler).status).toBe("queued");
  });

  it("releases the retained slot once a retried shutdown is finally confirmed", async () => {
    let clockMs = Date.parse(now);
    const { capacityScheduler, recordTerminal } = countingScheduler(() => clockMs);
    const provider = fakeProvider({ wedge: "stop" });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        capacityScheduler,
        shutdownTimeoutMs: 50,
        serviceLimits: () => soleSlotServiceLimits(),
        capacityEnforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
      }),
    );
    const observed: AgentRunSessionOutcome[] = [];
    const supervisor = new AgentRunSessionSupervisor({
      port: runtime,
      onSessionSettled: (input) => void observed.push(input.outcome),
    });
    const run = agentRun();

    supervisor.start(run);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));
    await expect(supervisor.stop(run.id)).rejects.toThrowError(/shutdown was not confirmed/i);
    expect(recordTerminal).not.toHaveBeenCalled();

    provider.confirmShutdown();
    await supervisor.stop(run.id);

    // A confirmed shutdown is the fact that ends the reservation, and it ends it
    // exactly once even though the deferred release ran on the retry path.
    expect(observed).toEqual([{ kind: "cancelled" }]);
    expect(recordTerminal).toHaveBeenCalledTimes(1);
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
    clockMs += 120_000;
    expect(capacityScheduler.expireAmbiguous().released).toHaveLength(1);
    expect(otherTurnSubmission(capacityScheduler).status).toBe("dispatched");
  });

  it("releases a confirmed cancellation exactly once", async () => {
    const { capacityScheduler, recordTerminal } = countingScheduler();
    const provider = fakeProvider();
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider, { capacityScheduler }));

    const handle = runtime.start(agentRun());
    const outcome = settled(handle);
    await vi.waitFor(() => expect(provider.turns.length).toBe(1));
    await runtime.stop(agentRun().id);
    await runtime.stop(agentRun().id);

    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(recordTerminal).toHaveBeenCalledTimes(1);
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });

  it("releases a confirmed deadline shutdown exactly once", async () => {
    const { capacityScheduler, recordTerminal } = countingScheduler();
    const provider = fakeProvider({ wedge: "send" });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, { capacityScheduler, timeoutMs: 50 }),
    );

    const outcome = await settled(runtime.start(agentRun()));

    expect(outcome.kind).toBe("interrupted");
    expect(provider.stops).toEqual([sessionId]);
    expect(recordTerminal).toHaveBeenCalledTimes(1);
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });

  it("ends a session wedged in provider acquisition at the runtime deadline", async () => {
    const capacityScheduler = scheduler();
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(fakeProvider(), {
        capacityScheduler,
        timeoutMs: 50,
        resolveDriver: () => ({ acquire: () => Effect.never }) as unknown as ProviderDriver,
      }),
    );

    const outcome = await settled(runtime.start(agentRun()));

    expect(outcome).toEqual({
      kind: "interrupted",
      reason: "Managed AgentRun turn exceeded its runtime deadline.",
    });
    // A provider that never came up must not hold its reservation until the
    // host restarts.
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });

  it("ends a session wedged in provider startup at the runtime deadline", async () => {
    const capacityScheduler = scheduler();
    const provider = fakeProvider({ wedge: "start" });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, { capacityScheduler, timeoutMs: 50 }),
    );

    const outcome = await settled(runtime.start(agentRun()));

    expect(outcome).toEqual({
      kind: "interrupted",
      reason: "Managed AgentRun turn exceeded its runtime deadline.",
    });
    // The connection was acquired before the deadline fired, so it is stopped
    // rather than leaked.
    expect(provider.stops).toEqual([sessionId]);
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });

  it("ends a session wedged in its first send at the runtime deadline", async () => {
    const capacityScheduler = scheduler();
    const provider = fakeProvider({ wedge: "send" });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, { capacityScheduler, timeoutMs: 50 }),
    );

    const outcome = await settled(runtime.start(agentRun()));

    expect(outcome).toEqual({
      kind: "interrupted",
      reason: "Managed AgentRun turn exceeded its runtime deadline.",
    });
    expect(provider.stops).toEqual([sessionId]);
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });

  it("fails closed when the provider instance is not configured on this host", () => {
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(fakeProvider(), { resolveDriver: () => undefined }),
    );

    expect(() => runtime.start(agentRun())).toThrowError(
      expect.objectContaining({ reason: "provider-unavailable" }),
    );
  });

  it("fails closed when the admitted context snapshot cannot be resolved", () => {
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(fakeProvider(), { context: { resolve: () => undefined } }),
    );

    expect(() => runtime.start(agentRun())).toThrowError(
      expect.objectContaining({ reason: "context-unavailable" }),
    );
  });

  it("fails closed when a Chat child has no scratch root on this host", () => {
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(fakeProvider(), { scratchRoot: () => undefined }),
    );

    expect(() => runtime.start(agentRun())).toThrowError(
      expect.objectContaining({ reason: "workspace-unavailable" }),
    );
  });

  it("fails closed when a Code child's worktree is not verified", () => {
    const runtime = createAgentRunSessionRuntime(runtimeOptions(fakeProvider()));

    expect(() =>
      runtime.start(
        agentRun({
          workspaceReceipt: {
            kind: "code-worktree",
            mode: "code",
            projectId: "88888888-8888-4888-8888-888888888888" as never,
            checkoutRoot: "/repo",
            worktreeRoot: "/repo/.worktrees/child",
            verified: false,
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ reason: "workspace-unavailable" }));
  });

  it("releases reserved spend when provider capacity prevents a child from starting", () => {
    const settle = vi.fn();
    const admit = vi.fn().mockReturnValue({
      status: "admitted",
      reservedTokens: 100,
      reservations: [],
    });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(fakeProvider(), {
        serviceLimits: () => undefined,
        spendCeiling: { admit, settle },
      }),
    );

    expect(() => runtime.start(agentRun())).toThrowError(
      expect.objectContaining({ reason: "capacity-unavailable" }),
    );
    expect(admit).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith({
      reservationId: admit.mock.calls[0]?.[0].reservationId,
    });
  });

  it("fails closed when provider capacity facts are unavailable", () => {
    const options = runtimeOptions(fakeProvider());
    const runtime = createAgentRunSessionRuntime({
      ...options,
      serviceLimits: () => undefined,
    });

    expect(() => runtime.start(agentRun())).toThrowError(
      expect.objectContaining({ reason: "capacity-unavailable" }),
    );
  });

  it("leaves an observed provider retry window authoritative when a managed child starts", () => {
    const capacityScheduler = scheduler();
    capacityScheduler.updateProviderFacts({
      limits: retryingServiceLimits(),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(fakeProvider(), {
        capacityScheduler,
        serviceLimits: makeUnobservedProviderCapacityFacts({
          scheduler: capacityScheduler,
          now: () => new Date().toISOString() as never,
        }),
      }),
    );

    // The child is ordinary work: a wait this host already observed applies to
    // it exactly as it applies to a Chat turn.
    expect(() => runtime.start(agentRun())).toThrowError(
      expect.objectContaining({ reason: "capacity-unavailable" }),
    );
    // And starting a child must not degrade the shared scheduler for the
    // unrelated turns that observed those limits.
    expect(capacityScheduler.providerFacts(providerInstanceId as never)?.limits).toMatchObject({
      retry: { status: "active", until: retryUntil },
      quota: "exhausted",
      confidence: "high",
    });
  });

  it("ends the capacity reservation when the provider cannot be acquired", async () => {
    const capacityScheduler = scheduler();
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(fakeProvider(), {
        capacityScheduler,
        resolveDriver: () =>
          ({
            acquire: () =>
              Effect.fail({
                category: "unauthenticated",
                message: "No credential.",
              } as never),
          }) as unknown as ProviderDriver,
      }),
    );

    const outcome = await settled(runtime.start(agentRun()));

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { category: "unauthenticated" },
    });
    // Terminal without provider-reported usage: concurrency is freed and the
    // reserved tokens stay honestly ambiguous rather than leaking as running.
    expect(capacityScheduler.getReservation(reservationId as never)?.state).toBe("ambiguous");
  });
});

describe("managed child interaction continuity", () => {
  it("waits for the person's approval and answers a duplicated request only once", async () => {
    const provider = fakeProvider();
    let decide: (approved: boolean) => void = () => undefined;
    const approve = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, { interactions: { approve } }),
    );
    const result = settled(runtime.start(agentRun()));
    await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
    const request = {
      kind: "approval-request",
      sessionId,
      requestId: "permission-1",
      action: "shell",
      description: "Run the tests",
      occurredAt: now,
    };
    await provider.emit(request);
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    expect(provider.answeredApprovals).toEqual([]);
    decide(true);
    await vi.waitFor(() =>
      expect(provider.answeredApprovals).toEqual([expect.objectContaining({ approved: true })]),
    );
    await provider.emit(request);
    await provider.emit({ kind: "text-delta", sessionId, text: "Tests complete", occurredAt: now });
    await provider.emit({ kind: "completed", sessionId });
    expect((await result).kind).toBe("completed");
    expect(approve).toHaveBeenCalledOnce();
    expect(provider.answeredApprovals).toHaveLength(1);
  });

  it("expires a pending question on cancellation and never delivers a late answer", async () => {
    const provider = fakeProvider();
    let answer: (text: string) => void = () => undefined;
    let questionSignal: AbortSignal | undefined;
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        interactions: {
          askUser: ({ signal }) => {
            questionSignal = signal;
            return new Promise<string>((resolve) => {
              answer = resolve;
            });
          },
        },
      }),
    );
    const run = agentRun();
    const result = settled(runtime.start(run));
    await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
    await provider.emit({
      kind: "user-input-request",
      sessionId,
      requestId: "question-1",
      prompt: "Which branch?",
      options: [],
    });
    await vi.waitFor(() => expect(questionSignal).toBeDefined());
    await runtime.stop(run.id);
    expect(questionSignal?.aborted).toBe(true);
    answer("main");
    expect((await result).kind).toBe("cancelled");
    expect(provider.answeredQuestions).toEqual([]);
  });

  it("steers only a live capable session and refuses after cancellation", async () => {
    const provider = fakeProvider({ steerable: true });
    const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));
    const run = agentRun();
    runtime.start(run);
    await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
    await expect(
      runtime.steer?.({ runId: run.id, message: "Focus on the failing test" }),
    ).resolves.toBe("steered");
    expect(provider.steered).toEqual(["Focus on the failing test"]);
    await runtime.stop(run.id);
    await expect(runtime.steer?.({ runId: run.id, message: "Too late" })).resolves.toBe(
      "unsupported",
    );
  });
});

describe("durable child provider identity", () => {
  it("cancels pending workspace verification without acquiring a provider or overwriting saved state", async () => {
    const provider = fakeProvider();
    const counted = countingScheduler();
    const write = vi.fn(() => true);
    const onSessionStarted = vi.fn();
    let verificationSignal: AbortSignal | undefined;
    let finishVerification: (value: {
      readonly status: "verified";
      readonly identity: string;
    }) => void = () => undefined;
    const verification = new Promise<{ readonly status: "verified"; readonly identity: string }>(
      (resolve) => {
        finishVerification = resolve;
      },
    );
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        capacityScheduler: counted.capacityScheduler,
        sessionStore: { read: () => undefined, write },
        onSessionStarted,
        verifyCodeWorkspace: ({ signal }) => {
          verificationSignal = signal;
          return verification;
        },
      }),
    );
    const run = agentRun({
      workspaceReceipt: {
        kind: "code-worktree",
        mode: "code",
        projectId: "88888888-8888-4888-8888-888888888888" as never,
        checkoutRoot: "/repo",
        worktreeRoot: "/child",
        verified: true,
      },
    });
    const result = settled(runtime.start(run));
    await vi.waitFor(() => expect(verificationSignal).toBeDefined());
    await runtime.stop(run.id);
    expect(verificationSignal?.aborted).toBe(true);
    finishVerification({ status: "verified", identity: "late-directory" });
    expect((await result).kind).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
    expect(onSessionStarted).not.toHaveBeenCalled();
    expect(provider.acquired).toEqual([]);
    expect(counted.recordTerminal).toHaveBeenCalledOnce();
  });

  it("refuses a Code start before provider acquisition without a live workspace verifier", async () => {
    const provider = fakeProvider();
    const counted = countingScheduler();
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, { capacityScheduler: counted.capacityScheduler }),
    );
    const result = await settled(
      runtime.start(
        agentRun({
          workspaceReceipt: {
            kind: "code-worktree",
            mode: "code",
            projectId: "88888888-8888-4888-8888-888888888888" as never,
            checkoutRoot: "/repo",
            worktreeRoot: "/child",
            verified: true,
          },
        }),
      ),
    );
    expect(result).toMatchObject({
      kind: "interrupted",
      reason: expect.stringContaining("workspace-unavailable"),
    });
    expect(provider.acquired).toEqual([]);
    expect(counted.recordTerminal).toHaveBeenCalledOnce();
  });

  it("refuses a replaced Code workspace on resume without rewriting its saved session or publishing a new turn", async () => {
    const connection = openSqlite(databasePath());
    applyMigrations(connection, MIGRATIONS, () => now);
    const run = agentRun({
      workspaceReceipt: {
        kind: "code-worktree",
        mode: "code",
        projectId: "88888888-8888-4888-8888-888888888888" as never,
        checkoutRoot: "/repo",
        worktreeRoot: "/child",
        verified: true,
      },
    });
    const store = new AgentRunSessionStore({ connection, getById: () => run });
    const provider = fakeProvider({ resumable: true });
    const first = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        sessionStore: store.sessions,
        supportsResume: () => true,
        verifyCodeWorkspace: async () => ({ status: "verified", identity: "original-directory" }),
      }),
    );
    const done = settled(first.start(run));
    await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
    await provider.emit({
      kind: "text-delta",
      sessionId,
      text: "Child committed",
      occurredAt: now,
    });
    await provider.emit({ kind: "completed", sessionId });
    expect((await done).kind).toBe("completed");
    const saved = store.sessions.read(run);
    expect(saved?.workspaceIdentity).toBe("original-directory");
    const nextProvider = fakeProvider({ resumable: true });
    const onSessionStarted = vi.fn();
    const second = createAgentRunSessionRuntime(
      runtimeOptions(nextProvider, {
        sessionStore: store.sessions,
        supportsResume: () => true,
        verifyCodeWorkspace: async () => ({
          status: "verified",
          identity: "replacement-directory",
        }),
        onSessionStarted,
      }),
    );
    const handle = second.resume?.(run);
    if (handle === undefined) throw new Error("expected resume handle");
    expect(await settled(handle)).toMatchObject({
      kind: "interrupted",
      reason: expect.stringContaining("workspace-unavailable"),
    });
    expect(nextProvider.acquired).toEqual([]);
    expect(store.sessions.read(run)).toEqual(saved);
    expect(onSessionStarted).not.toHaveBeenCalled();
    if (saved === undefined) throw new Error("Expected saved Code session");
    const { workspaceIdentity: _, ...legacyRecord } = saved;
    store.sessions.write(run, legacyRecord);
    expect(second.checkResume?.(run)).toMatchObject({ status: "refused" });
    expect(nextProvider.acquired).toEqual([]);
    connection.close();
  });

  it.each(["chat", "code"] as const)(
    "continues the same %s child session after runtime restart without replaying its original task",
    async (mode) => {
      const path = databasePath();
      let connection = openSqlite(path);
      applyMigrations(connection, MIGRATIONS, () => now);
      const run = agentRun(
        mode === "code"
          ? {
              workspaceReceipt: {
                kind: "code-worktree",
                mode: "code",
                projectId: "88888888-8888-4888-8888-888888888888" as never,
                checkoutRoot: "/repo",
                worktreeRoot: "/child",
                verified: true,
              },
            }
          : undefined,
      );
      const durable = new AgentRunSessionStore({ connection, getById: () => run });
      const provider = fakeProvider({ resumable: true });
      const options = runtimeOptions(provider, {
        sessionStore: durable.sessions,
        supportsResume: () => true,
        verifyCodeWorkspace: async () => ({ status: "verified", identity: "original-directory" }),
      });
      const first = createAgentRunSessionRuntime(options);
      const result = settled(first.start(run));
      await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
      await provider.emit({ kind: "text-delta", sessionId, text: "First report", occurredAt: now });
      await provider.emit({ kind: "completed", sessionId });
      expect((await result).kind).toBe("completed");
      const recorded = durable.sessions.read(run);
      expect(recorded?.resumeCursor?.value).toBe("private-provider-session");
      connection.close();
      connection = openSqlite(path);
      const restored = new AgentRunSessionStore({ connection, getById: () => run });
      const second = createAgentRunSessionRuntime(
        runtimeOptions(provider, {
          sessionStore: restored.sessions,
          supportsResume: () => true,
          verifyCodeWorkspace: async () => ({ status: "verified", identity: "original-directory" }),
        }),
      );
      expect(second.checkResume?.({ ...run, lifecycleStatus: "completed" })).toEqual({
        status: "ready",
      });
      expect(second.checkResume?.({ ...run, lifecycleStatus: "cancelled" })).toMatchObject({
        status: "refused",
      });
      expect(provider.acquired).toHaveLength(1);
      const continued = second.resume?.(
        { ...run, generation: 2 },
        { message: "Add the regression evidence" },
      );
      expect(continued).toBeDefined();
      await vi.waitFor(() => expect(provider.turns).toHaveLength(2));
      expect(provider.resumes).toEqual([
        expect.objectContaining({ sessionId, resumeCursor: recorded?.resumeCursor }),
      ]);
      expect(provider.turns[1]?.prompt).toBe("Add the regression evidence");
      expect(provider.turns[1]?.context).toEqual([]);
      await second.stop(run.id);
      purgeAgentRunSubjectContent(connection, agentRunContentSubject(run));
      expect(restored.sessions.read(run)).toBeUndefined();
      connection.close();
    },
  );

  it("refuses resume without a recoverable cursor, without invoking a replacement start", async () => {
    const provider = fakeProvider();
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, { supportsResume: () => true }),
    );
    expect(runtime.checkResume?.(agentRun())).toMatchObject({ status: "refused" });
    expect(() => runtime.resume?.(agentRun())).toThrow("Retry");
    expect(provider.acquired).toEqual([]);
  });
});

describe("child continuation authority and recovery", () => {
  it("rejects a changed session acknowledgement before sending a follow-up", async () => {
    const run = agentRun();
    const connection = openSqlite(databasePath());
    applyMigrations(connection, MIGRATIONS, () => now);
    const store = new AgentRunSessionStore({ connection, getById: () => run });
    const firstProvider = fakeProvider({ resumable: true });
    const first = createAgentRunSessionRuntime(
      runtimeOptions(firstProvider, { sessionStore: store.sessions, supportsResume: () => true }),
    );
    first.start(run);
    await vi.waitFor(() => expect(firstProvider.turns).toHaveLength(1));
    await first.stop(run.id);
    const provider = fakeProvider({ changedResumeIdentity: true });
    const next = createAgentRunSessionRuntime(
      runtimeOptions(provider, { sessionStore: store.sessions, supportsResume: () => true }),
    );
    const handle = next.resume?.(run);
    if (handle === undefined) throw new Error("The continuation port is unavailable");
    await expect(settled(handle)).resolves.toMatchObject({
      kind: "failed",
      failure: { category: "stale-resume" },
    });
    expect(provider.turns).toEqual([]);
    connection.close();
  });

  it("refuses a cursor for another workspace and does not reserve provider capacity", async () => {
    const run = agentRun();
    const connection = openSqlite(databasePath());
    applyMigrations(connection, MIGRATIONS, () => now);
    const store = new AgentRunSessionStore({ connection, getById: () => run });
    const provider = fakeProvider({ resumable: true });
    const first = createAgentRunSessionRuntime(
      runtimeOptions(provider, { sessionStore: store.sessions, supportsResume: () => true }),
    );
    first.start(run);
    await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
    await first.stop(run.id);
    const nextProvider = fakeProvider();
    const capacityScheduler = scheduler();
    const reserve = vi.spyOn(capacityScheduler, "submit");
    const next = createAgentRunSessionRuntime(
      runtimeOptions(nextProvider, {
        capacityScheduler,
        sessionStore: store.sessions,
        supportsResume: () => true,
        scratchRoot: () => "/another-root",
      }),
    );
    expect(() => next.resume?.(run)).toThrow("Retry");
    expect(nextProvider.acquired).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    connection.close();
  });

  it("restores bounded partial history as stale, continues its sequence, and keeps cursors private", async () => {
    const run = agentRun();
    const path = databasePath();
    let connection = openSqlite(path);
    applyMigrations(connection, MIGRATIONS, () => now);
    let store = new AgentRunSessionStore({ connection, getById: () => run });
    const live = new AgentRunLiveConversationStore({ persistence: store.conversations });
    live.begin(run.id);
    live.appendStatus(run.id, "Person: First task", now as never);
    live.appendText(run.id, "Partial report", now as never);
    store.sessions.write(run, {
      binding: "a".repeat(64),
      sessionId: sessionId as never,
      resumeCursor: { driverKind: "codex", value: "private-native-cursor" },
    });
    connection.close();
    connection = openSqlite(path);
    store = new AgentRunSessionStore({ connection, getById: () => run });
    const restored = new AgentRunLiveConversationStore({ persistence: store.conversations });
    expect(restored.read({ runId: run.id })).toMatchObject({
      status: "stale",
      entries: [
        { sequence: 1, kind: "status" },
        { sequence: 2, text: "Partial report" },
      ],
    });
    expect(JSON.stringify(restored.read({ runId: run.id }))).not.toContain("private-native-cursor");
    restored.begin(run.id, { resume: true });
    restored.appendText(run.id, "Continued report", now as never);
    expect(restored.read({ runId: run.id, afterSequence: 2 })?.entries).toMatchObject([
      { sequence: 3, text: "Continued report" },
    ]);
    purgeAgentRunSubjectContent(connection, agentRunContentSubject(run));
    connection
      .prepare(
        "INSERT INTO thread_purge_tombstone(mode, thread_id, purged_at, last_sequence) VALUES (?, ?, ?, 1)",
      )
      .run("chat", String(run.parentThreadId), now);
    restored.appendText(run.id, "Late output must not restore the deleted history", now as never);
    expect(
      store.sessions.write(run, { binding: "a".repeat(64), sessionId: sessionId as never }),
    ).toBe(false);
    expect(connection.prepare("SELECT * FROM agent_run_content_store").all()).toEqual([]);
    connection.close();
  });

  it("expires an unanswered permission when the provider finishes on its own", async () => {
    const provider = fakeProvider();
    let approvalSignal: AbortSignal | undefined;
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        interactions: {
          approve: ({ signal }) => {
            approvalSignal = signal;
            return new Promise<boolean>(() => undefined);
          },
        },
      }),
    );
    const result = settled(runtime.start(agentRun()));
    await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
    await provider.emit({
      kind: "approval-request",
      sessionId,
      requestId: "permission-1",
      action: "shell",
      description: "Run tests",
    });
    await vi.waitFor(() => expect(approvalSignal).toBeDefined());
    await provider.emit({
      kind: "text-delta",
      sessionId,
      text: "I did not need that command",
      occurredAt: now,
    });
    await provider.emit({ kind: "completed", sessionId });
    expect((await result).kind).toBe("completed");
    expect(approvalSignal?.aborted).toBe(true);
    expect(provider.answeredApprovals).toEqual([]);
  });

  it("releases admission reservations if private session storage cannot be written", () => {
    const provider = fakeProvider();
    const counted = countingScheduler();
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        capacityScheduler: counted.capacityScheduler,
        sessionStore: {
          read: () => undefined,
          write: () => {
            throw new Error("Storage unavailable");
          },
        },
      }),
    );
    expect(() => runtime.start(agentRun())).toThrow();
    expect(counted.recordTerminal).toHaveBeenCalledOnce();
    expect(provider.acquired).toEqual([]);
  });
});

it("answers a child's repeated question only once and records the person's answer", async () => {
  const provider = fakeProvider();
  const askUser = vi.fn(async () => "main");
  const onUserMessage = vi.fn();
  const runtime = createAgentRunSessionRuntime(
    runtimeOptions(provider, { interactions: { askUser }, onUserMessage }),
  );
  const result = settled(runtime.start(agentRun()));
  await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
  const question = {
    kind: "user-input-request",
    sessionId,
    requestId: "question-1",
    prompt: "Which branch?",
    options: [],
  };
  await provider.emit(question);
  await vi.waitFor(() => expect(provider.answeredQuestions).toHaveLength(1));
  await provider.emit(question);
  await provider.emit({ kind: "text-delta", sessionId, text: "Using main", occurredAt: now });
  await provider.emit({ kind: "completed", sessionId });
  expect((await result).kind).toBe("completed");
  expect(askUser).toHaveBeenCalledOnce();
  expect(provider.answeredQuestions).toHaveLength(1);
  expect(onUserMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "answer", text: "Question: Which branch?\nAnswer: main" }),
  );
});

it("refuses an unanswered question instead of manufacturing an empty provider answer", async () => {
  const provider = fakeProvider();
  const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));
  const result = settled(runtime.start(agentRun()));
  await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
  await provider.emit({
    kind: "user-input-request",
    sessionId,
    requestId: "question-1",
    prompt: "Which branch?",
    options: [],
  });
  await expect(result).resolves.toMatchObject({
    kind: "failed",
    failure: { category: "unsupported" },
  });
  expect(provider.answeredQuestions).toEqual([]);
  expect(provider.interrupts).toEqual([sessionId]);
  expect(provider.stops).toEqual([sessionId]);
});

it("refuses malformed saved cursors without launching another provider session", async () => {
  const run = agentRun();
  const connection = openSqlite(databasePath());
  applyMigrations(connection, MIGRATIONS, () => now);
  const store = new AgentRunSessionStore({ connection, getById: () => run });
  const provider = fakeProvider({ resumable: true });
  const first = createAgentRunSessionRuntime(
    runtimeOptions(provider, { sessionStore: store.sessions, supportsResume: () => true }),
  );
  first.start(run);
  await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
  await first.stop(run.id);
  connection
    .prepare(
      "UPDATE agent_run_content_store SET body_text = ? WHERE content_kind = 'managed-session'",
    )
    .run(
      JSON.stringify({
        binding: "a".repeat(64),
        sessionId,
        resumeCursor: { driverKind: "codex", value: { invalid: true } },
      }),
    );
  expect(store.sessions.read(run)).toBeUndefined();
  expect(() => first.resume?.(run)).toThrow("Retry");
  expect(provider.acquired).toHaveLength(1);
  connection.close();
});

it("reports acknowledged steering as delivered when the provider immediately completes", async () => {
  const provider = fakeProvider({ steerable: true, completeOnSteer: true });
  const onUserMessage = vi.fn();
  const runtime = createAgentRunSessionRuntime(runtimeOptions(provider, { onUserMessage }));
  const run = agentRun();
  const result = settled(runtime.start(run));
  await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
  await provider.emit({ kind: "text-delta", sessionId, text: "Answer", occurredAt: now });
  expect(await runtime.steer?.({ runId: run.id, message: "Finish with the evidence" })).toBe(
    "steered",
  );
  expect((await result).kind).toBe("completed");
  expect(provider.steered).toEqual(["Finish with the evidence"]);
  expect(onUserMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "steering", text: "Finish with the evidence" }),
  );
  expect(await runtime.steer?.({ runId: run.id, message: "Too late" })).toBe("unsupported");
});

it("keeps an accepted steering acknowledgement when the session ends before the caller resumes", async () => {
  const provider = fakeProvider({ steerable: true });
  const runtime = createAgentRunSessionRuntime(runtimeOptions(provider));
  const run = agentRun();
  runtime.start(run);
  await vi.waitFor(() => expect(provider.turns).toHaveLength(1));
  const acknowledged = runtime.steer?.({ runId: run.id, message: "Record this instruction" });
  expect(provider.steered).toEqual(["Record this instruction"]);
  // stop aborts pending input synchronously, before the acknowledged Promise's continuation runs.
  await runtime.stop(run.id);
  expect(await acknowledged).toBe("steered");
});
