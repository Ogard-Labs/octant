import { describe, expect, it, vi } from "vitest";
import { Effect, Queue, Stream } from "effect";
import {
  decodeContextSubjectRef,
  decodeProviderServiceLimits,
  type AgentRun,
  type AgentRunAuthority,
  type ProviderContextBlock,
  type ProviderExecutionPolicy,
  type ProviderTurnInput,
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
      mode: "chat",
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
}) {
  let shutdownFails = options?.shutdownFails ?? false;
  let wedge = options?.wedge;
  const queue = Effect.runSync(Queue.unbounded<never>());
  const acquired: ProviderAcquireInput[] = [];
  const executionPolicies: ProviderExecutionPolicy[] = [];
  const turns: ProviderTurnInput[] = [];
  const answeredApprovals: { readonly approved: boolean }[] = [];
  const answeredTools: { readonly isError?: boolean }[] = [];
  const interrupts: string[] = [];
  const stops: string[] = [];
  const emit = async (event: unknown): Promise<void> => {
    await Effect.runPromise(Queue.offer(queue, event as never));
  };
  const connection = {
    events: Stream.fromQueue(queue),
    start: (input: { readonly executionPolicy: ProviderExecutionPolicy }) => {
      executionPolicies.push(input.executionPolicy);
      return wedge === "start" ? Effect.never : Effect.succeed({ sessionId });
    },
    resume: () => Effect.succeed({ sessionId }),
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
    answerUserInput: () => Effect.void,
    answerTool: (input: { readonly isError?: boolean }) =>
      Effect.sync(() => void answeredTools.push(input)),
  };
  const provider: FakeProvider = {
    driver: {
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
    const deltas: string[] = [];
    const settledOutcomes: AgentRunSessionOutcome[] = [];
    const runtime = createAgentRunSessionRuntime(
      runtimeOptions(provider, {
        onSessionStarted: ({ runId: startedRunId }) => started.push(String(startedRunId)),
        onTextDelta: ({ text }) => deltas.push(text),
        onSessionSettled: ({ outcome }) => settledOutcomes.push(outcome),
      }),
    );
    const outcome = settled(runtime.start(agentRun()));
    await provider.emit({ kind: "text-delta", sessionId, text: "partial" });
    await provider.emit({ kind: "completed", sessionId });
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
    expect(started).toHaveLength(1);
    expect(deltas).toEqual(["partial"]);
    expect(settledOutcomes).toHaveLength(1);
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
