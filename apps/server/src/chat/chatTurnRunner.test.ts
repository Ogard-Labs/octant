import { describe, expect, it, vi } from "vitest";
import {
  decodeCapacityReservationId,
  decodeChatAttemptId,
  decodeChatCitationId,
  decodeChatContentId,
  decodeChatThreadId,
  decodeChatTurnId,
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderServiceLimits,
  decodeProviderSessionId,
  type ChatAttempt,
  type ChatThread,
} from "@octant/contracts";
import { Effect, Fiber, Queue, Stream } from "effect";
import type { ProviderAcquireInput, ProviderDriver } from "@octant/provider-sdk/driver";
import { ContextHarnessService } from "../context/contextHarnessService";
import { makeProviderCapacityScheduler } from "../context/contextRuntime";
import { ResearchRouter, type ResearchRouteDecision } from "./research/researchRouter";
import { ChatTurnRunner } from "./chatTurnRunner";

const now = "2026-07-19T22:00:00.000Z";
const providerInstanceId = decodeProviderInstanceId("82000000-0000-4000-8000-000000000003");
const threadId = decodeChatThreadId("82000000-0000-4000-8000-000000000010");
const turnId = decodeChatTurnId("82000000-0000-4000-8000-000000000020");
const attemptId = decodeChatAttemptId("82000000-0000-4000-8000-000000000021");
const sessionId = decodeProviderSessionId("82000000-0000-4000-8000-000000000041");
let reservationCounter = 0;

function nextReservationId() {
  reservationCounter += 1;
  return decodeCapacityReservationId(
    `82000000-0000-4000-8000-${reservationCounter.toString(16).padStart(12, "0")}`,
  );
}
const subject = decodeContextSubjectRef({
  aggregateType: "chat-thread",
  aggregateId: String(threadId),
});

const thread = (): ChatThread =>
  ({
    id: threadId,
    title: "Turn runner",
    lifecycle: "active",
    providerInstanceId,
    modelId: "model-a",
    researchEnabled: true,
    researchRouting: "automatic",
    personalityInstructions: "Be calm.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  }) as ChatThread;

const attempt = (outcome: ChatAttempt["outcome"] = "queued"): ChatAttempt =>
  ({
    id: attemptId,
    turnId,
    threadId,
    providerInstanceId,
    providerSessionId: sessionId,
    modelId: decodeProviderModelId("model-a"),
    contextManifestId: "82000000-0000-4000-8000-000000000040",
    outcome,
    responseRefs: [],
    citationIds: [],
    createdAt: now,
    updatedAt: now,
  }) as unknown as ChatAttempt;

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

function makeHarness() {
  return {
    reconcileUsage: vi.fn(() => ({
      variance: { varianceTokens: 0 },
      snapshot: {} as never,
    })),
  } as unknown as ContextHarnessService;
}

function makeScheduler(reservation = nextReservationId()) {
  const scheduler = makeProviderCapacityScheduler({
    now: () => Date.parse(now),
    random: () => 0.5,
    maxRetryJitterMs: 0,
    ambiguousReservationTtlMs: 60_000,
  });
  scheduler.updateProviderFacts({
    limits: serviceLimits(),
    enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
  });
  return { scheduler, reservation };
}

function researchRoute(
  decision:
    | { readonly kind: "disabled" }
    | { readonly kind: "unavailable" }
    | { readonly backend: "provider-native" }
    | { readonly backend?: "searxng" } = {},
): ResearchRouteDecision {
  if ("kind" in decision && decision.kind === "disabled") return { kind: "disabled" };
  if ("kind" in decision && decision.kind === "unavailable") {
    return {
      kind: "unavailable",
      reason: "searxng-not-configured",
    };
  }
  if ("backend" in decision && decision.backend === "provider-native") {
    return {
      kind: "ready",
      backend: "provider-native",
      attribution: "Provider-native search",
    };
  }
  return {
    kind: "ready",
    backend: "searxng",
    attribution: "SearXNG",
    execute: async () => ({ query: "x", backend: "searxng", results: [] }),
  };
}

describe("ChatTurnRunner", () => {
  it("subscribes before send and passes chat scratch confinement to acquire", async () => {
    const acquireInputs: ProviderAcquireInput[] = [];
    let subscribedBeforeSend = false;
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.unwrap(
        Effect.sync(() => {
          subscribedBeforeSend = true;
          return Stream.fromQueue(queue);
        }),
      ),
      start: () => Effect.succeed({ sessionId }),
      send: (input: { readonly context?: ReadonlyArray<{ readonly kind: string }> }) =>
        Effect.gen(function* () {
          expect(subscribedBeforeSend).toBe(true);
          expect(input.context).toEqual([{ kind: "instructions", text: "Stay concise." }]);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Hello" } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const driver = {
      acquire: (input: ProviderAcquireInput) => {
        acquireInputs.push(input);
        return Effect.succeed(connection);
      },
    } as unknown as ProviderDriver;
    const scratchRoot = "/tmp/octant-scratch/thread";
    const updates: ChatAttempt[] = [];
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          context: [{ kind: "instructions", text: "Stay concise." }],
          scratchRoot,
          driver,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "a".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(acquireInputs[0]).toMatchObject({ mode: "chat", projectRoot: scratchRoot });
    expect(updates.at(-1)?.outcome).toBe("completed");
  });

  it("fails closed when a provider completes without non-whitespace assistant content", async () => {
    const updates: ChatAttempt[] = [];
    const persistResponse = vi.fn(() =>
      Effect.succeed({
        contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
        digest: "a".repeat(64),
        byteLength: 1,
      }),
    );
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: " \n " } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
      }),
    });

    await expect(
      Effect.runPromise(
        Effect.scoped(
          runner.run({
            thread: thread(),
            attempt: attempt(),
            prompt: "hello",
            scratchRoot: "/tmp/octant-scratch/thread",
            driver: { acquire: () => Effect.succeed(connection) } as never,
            providerInstanceId,
            serviceLimits: serviceLimits(),
            contextSubject: subject,
            contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
            requestShape: "chat-turn",
            varianceReserve: 20,
            reservationId: reservation,
            estimatedTokens: 100,
            researchEnabled: false,
            researchRoute: researchRoute({ kind: "disabled" }),
            attachments: [],
            persistAttempt: (next) => {
              updates.push(next);
              return Effect.void;
            },
            persistResponse,
          }),
        ),
      ),
    ).rejects.toThrow("without a visible reply");
    expect(updates.at(-1)?.outcome).toBe("failed");
    expect(updates.at(-1)?.responseRefs).toHaveLength(1);
    expect(persistResponse).toHaveBeenCalledWith(" \n ");
  });

  it("answers a correlated tool request before completing", async () => {
    const answerTool = vi.fn(() => Effect.void);
    const controller = new AbortController();
    const executeResearch = vi.fn(async () => ({
      query: "Octant",
      backend: "searxng" as const,
      results: [
        {
          title: "Octant",
          url: "https://example.com/octant",
          snippet: "Local-first workspace.",
        },
      ],
    }));
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "tool-request",
            sessionId,
            requestId: "tool-1",
            toolName: "octant_web_research",
            inputJson: JSON.stringify({ query: "Octant" }),
          } as never);
          yield* Queue.offer(queue, {
            kind: "tool-request",
            sessionId,
            requestId: "tool-2",
            toolName: "octant_web_research",
            inputJson: JSON.stringify({ query: "Octant architecture" }),
          } as never);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Done" } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: {
          search: async () => ({
            query: "Octant",
            backend: "searxng",
            results: [
              {
                title: "Octant",
                url: "https://example.com/octant",
                snippet: "Local-first workspace.",
              },
            ],
          }),
        },
        providerNativeExecute: async () => ({
          query: "Octant",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "research this",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: true,
          researchRoute: {
            kind: "ready",
            backend: "searxng",
            attribution: "SearXNG",
            execute: executeResearch,
          },
          attachments: [],
          signal: controller.signal,
          persistAttempt: () => Effect.void,
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "b".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(answerTool).toHaveBeenCalledTimes(2);
    expect(executeResearch).toHaveBeenCalledTimes(2);
    expect(executeResearch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(executeResearch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(answerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        requestId: "tool-1",
        isError: false,
      }),
    );
    expect(answerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        requestId: "tool-2",
        isError: false,
      }),
    );
  });

  it("maps ambiguous provider death to interrupted, never completed", async () => {
    const updates: ChatAttempt[] = [];
    const connection = {
      events: Stream.fromIterable([{ kind: "text-delta", sessionId, delta: "partial" }] as never),
      start: () => Effect.succeed({ sessionId }),
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
      timeoutMs: 25,
    });

    const fiber = Effect.runFork(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "c".repeat(64),
              byteLength: 5,
            }),
          ambiguousRecovery: "interrupted",
        }),
      ),
    );

    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(exit._tag).toBe("Failure");
    expect(updates.map((entry) => entry.outcome)).toContain("interrupted");
    expect(updates.some((entry) => entry.outcome === "completed")).toBe(false);
  });

  it("releases scoped watchers when provider send fails", async () => {
    const controller = new AbortController();
    const updates: ChatAttempt[] = [];
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const connection = {
      events: Stream.never,
      start: () => Effect.succeed({ sessionId }),
      send: () => Effect.fail({ category: "provider-failed", message: "send failed" } as never),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    await expect(
      Effect.runPromise(
        Effect.scoped(
          runner.run({
            thread: thread(),
            attempt: attempt(),
            prompt: "hello",
            scratchRoot: "/tmp/octant-scratch/thread",
            driver: { acquire: () => Effect.succeed(connection) } as never,
            providerInstanceId,
            serviceLimits: serviceLimits(),
            contextSubject: subject,
            contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
            requestShape: "chat-turn",
            varianceReserve: 20,
            reservationId: reservation,
            estimatedTokens: 100,
            researchEnabled: false,
            researchRoute: researchRoute({ kind: "disabled" }),
            attachments: [],
            persistAttempt: (next) => {
              updates.push(next);
              return Effect.void;
            },
            persistResponse: () =>
              Effect.succeed({
                contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
                digest: "c".repeat(64),
                byteLength: 5,
              }),
            signal: controller.signal,
          }),
        ),
      ),
    ).rejects.toThrow("send failed");
    expect(updates.at(-1)?.outcome).toBe("failed");
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("preserves typed provider start failures as durable outcomes", async () => {
    const updates: ChatAttempt[] = [];
    const connection = {
      events: Stream.never,
      start: () => Effect.fail({ category: "rate-limited", message: "retry later" } as never),
      send: vi.fn(() => Effect.void),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
      }),
    });

    await expect(
      Effect.runPromise(
        Effect.scoped(
          runner.run({
            thread: thread(),
            attempt: attempt(),
            prompt: "hello",
            scratchRoot: "/tmp/octant-scratch/thread",
            driver: { acquire: () => Effect.succeed(connection) } as never,
            providerInstanceId,
            serviceLimits: serviceLimits(),
            contextSubject: subject,
            contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
            requestShape: "chat-turn",
            varianceReserve: 20,
            reservationId: reservation,
            estimatedTokens: 100,
            researchEnabled: false,
            researchRoute: researchRoute({ kind: "disabled" }),
            attachments: [],
            persistAttempt: (next) => {
              updates.push(next);
              return Effect.void;
            },
            persistResponse: () =>
              Effect.succeed({
                contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
                digest: "c".repeat(64),
                byteLength: 5,
              }),
          }),
        ),
      ),
    ).rejects.toThrow("retry later");
    expect(updates.at(-1)?.outcome).toBe("waiting");
    expect(connection.send).not.toHaveBeenCalled();
  });

  it("does not start provider send after cancellation is observed", async () => {
    const controller = new AbortController();
    const updates: ChatAttempt[] = [];
    const interrupt = vi.fn(() => Effect.void);
    const send = vi.fn(() => Effect.void);
    const connection = {
      events: Stream.never,
      start: () =>
        Effect.sync(() => {
          controller.abort();
          return { sessionId };
        }),
      send,
      interrupt,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
      }),
    });

    await expect(
      Effect.runPromise(
        Effect.scoped(
          runner.run({
            thread: thread(),
            attempt: attempt(),
            prompt: "hello",
            scratchRoot: "/tmp/octant-scratch/thread",
            driver: { acquire: () => Effect.succeed(connection) } as never,
            providerInstanceId,
            serviceLimits: serviceLimits(),
            contextSubject: subject,
            contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
            requestShape: "chat-turn",
            varianceReserve: 20,
            reservationId: reservation,
            estimatedTokens: 100,
            researchEnabled: false,
            researchRoute: researchRoute({ kind: "disabled" }),
            attachments: [],
            signal: controller.signal,
            persistAttempt: (next) => {
              updates.push(next);
              return Effect.void;
            },
            persistResponse: () =>
              Effect.succeed({
                contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
                digest: "c".repeat(64),
                byteLength: 5,
              }),
          }),
        ),
      ),
    ).rejects.toThrow("cancelled");
    expect(interrupt).toHaveBeenCalledWith(sessionId);
    expect(send).not.toHaveBeenCalled();
    expect(updates.at(-1)?.outcome).toBe("cancelled");
  });

  it("fails when the discrete event budget is exceeded, ignoring streaming deltas", async () => {
    const updates: ChatAttempt[] = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const toolStart = (id: string) =>
      ({ kind: "tool-start", sessionId, toolCallId: id, toolName: "t", input: {} }) as never;
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          // Deltas never count toward the budget.
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "one" } as never);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "two" } as never);
          yield* Queue.offer(queue, toolStart("call-1"));
          yield* Queue.offer(queue, toolStart("call-2"));
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
      maxEvents: 1,
      timeoutMs: 25,
    });

    const exit = await Effect.runPromise(
      Fiber.await(
        Effect.runFork(
          Effect.scoped(
            runner.run({
              thread: thread(),
              attempt: attempt(),
              prompt: "hello",
              scratchRoot: "/tmp/octant-scratch/thread",
              driver: { acquire: () => Effect.succeed(connection) } as never,
              providerInstanceId,
              serviceLimits: serviceLimits(),
              contextSubject: subject,
              contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
              requestShape: "chat-turn",
              varianceReserve: 20,
              reservationId: reservation,
              estimatedTokens: 100,
              researchEnabled: false,
              researchRoute: researchRoute({ kind: "disabled" }),
              attachments: [],
              persistAttempt: (next) => {
                updates.push(next);
                return Effect.void;
              },
              persistResponse: () =>
                Effect.succeed({
                  contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
                  digest: "f".repeat(64),
                  byteLength: 5,
                }),
            }),
          ),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(updates.at(-1)?.outcome).toBe("interrupted");
    expect(updates.some((entry) => entry.outcome === "completed")).toBe(false);
  });

  it("honors abort for the owned session and ends cancelled without completing", async () => {
    const interrupt = vi.fn(() => Effect.void);
    const stop = vi.fn(() => Effect.void);
    const otherSessionId = decodeProviderSessionId("82000000-0000-4000-8000-000000000099");
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "partial" } as never);
          yield* Queue.offer(queue, {
            kind: "text-delta",
            sessionId: otherSessionId,
            text: "x",
          } as never);
        }),
      interrupt,
      stop,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const recordTerminal = vi.spyOn(scheduler, "recordTerminal");
    const updates: ChatAttempt[] = [];
    const controller = new AbortController();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
      timeoutMs: 5_000,
    });

    const fiber = Effect.runFork(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          signal: controller.signal,
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "d".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(exit._tag).toBe("Failure");
    expect(interrupt).toHaveBeenCalledWith(sessionId);
    expect(interrupt).not.toHaveBeenCalledWith(otherSessionId);
    expect(updates.at(-1)?.outcome).toBe("cancelled");
    expect(updates.some((entry) => entry.outcome === "completed")).toBe(false);
    expect(recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: reservation, outcome: "cancelled" }),
    );
    expect(stop).toHaveBeenCalledWith(sessionId);
  });

  it("maps provider waiting to waiting, never completed", async () => {
    const updates: ChatAttempt[] = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "waiting",
            sessionId,
            message: "retry later",
          } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
      timeoutMs: 1_000,
    });

    const fiber = Effect.runFork(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "e".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(exit._tag).toBe("Failure");
    expect(updates.map((entry) => entry.outcome)).toContain("waiting");
    expect(updates.some((entry) => entry.outcome === "completed")).toBe(false);
  });

  it.each([
    ["rate-limited", "waiting", "waiting"],
    ["interrupted", "interrupted", "interrupted"],
    ["unauthorized", "unauthorized", "failed"],
    ["unsupported", "unsupported", "failed"],
  ] as const)(
    "maps typed provider %s failures before persisting the terminal outcome",
    async (providerCategory, publicCategory, durableOutcome) => {
      const updates: ChatAttempt[] = [];
      const queue = Effect.runSync(Queue.unbounded<never>());
      const connection = {
        events: Stream.fromQueue(queue),
        start: () => Effect.succeed({ sessionId }),
        send: () =>
          Queue.offer(queue, {
            kind: "failed",
            sessionId,
            failure: { category: providerCategory, message: `${providerCategory} fixture` },
          } as never),
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      };
      const { scheduler, reservation } = makeScheduler();
      const runner = new ChatTurnRunner({
        capacityScheduler: scheduler,
        contextHarness: makeHarness(),
        researchRouter: new ResearchRouter({
          searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        }),
      });

      const result = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            runner.run({
              thread: thread(),
              attempt: attempt(),
              prompt: "hello",
              scratchRoot: "/tmp/octant-scratch/thread",
              driver: { acquire: () => Effect.succeed(connection) } as never,
              providerInstanceId,
              serviceLimits: serviceLimits(),
              contextSubject: subject,
              contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
              requestShape: "chat-turn",
              varianceReserve: 20,
              reservationId: reservation,
              estimatedTokens: 100,
              researchEnabled: false,
              researchRoute: researchRoute({ kind: "disabled" }),
              attachments: [],
              persistAttempt: (next) => {
                updates.push(next);
                return Effect.void;
              },
              persistResponse: () =>
                Effect.succeed({
                  contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
                  digest: "f".repeat(64),
                  byteLength: 5,
                }),
            }),
          ),
        ),
      );

      expect(result).toMatchObject({ _tag: "Left", left: { category: publicCategory } });
      expect(updates.at(-1)?.outcome).toBe(durableOutcome);
    },
  );

  it("makes locally capacity-blocked turns retryable instead of stranding them waiting", async () => {
    const updates: ChatAttempt[] = [];
    const acquire = vi.fn();
    const scheduler = makeProviderCapacityScheduler({
      now: () => Date.parse(now),
      random: () => 0.5,
      maxRetryJitterMs: 0,
      ambiguousReservationTtlMs: 60_000,
    });
    const reservation = nextReservationId();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });
    const noRemainingCapacity = decodeProviderServiceLimits({
      providerInstanceId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "available", limit: 2, remaining: 0 },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "medium",
      updatedAt: now,
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire } as unknown as ProviderDriver,
          providerInstanceId,
          serviceLimits: noRemainingCapacity,
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "f".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(updates.at(-1)?.outcome).toBe("interrupted");
    expect(updates.some((entry) => entry.outcome === "waiting")).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("reconciles usage after completion", async () => {
    const harness = makeHarness();
    const updates: ChatAttempt[] = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "usage",
            sessionId,
            inputTokens: 12,
            outputTokens: 8,
            reasoningTokens: 3,
            cacheReadInputTokens: 4,
            cacheWriteInputTokens: 5,
            providerExecutionDurationMs: 42,
          } as never);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Done" } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: harness,
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "f".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(harness.reconcileUsage).toHaveBeenCalledOnce();
    expect(harness.reconcileUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningTokens: 3,
        cacheReadInputTokens: 4,
        cacheWriteInputTokens: 5,
        providerExecutionDurationMs: 42,
      }),
    );
    expect(updates.at(-1)?.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it("checkpoints bounded response chunks and citation identity before completion", async () => {
    const updates: ChatAttempt[] = [];
    const persistedChunks: string[] = [];
    const citationId = decodeChatCitationId("82000000-0000-4000-8000-000000000071");
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Hello " } as never);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "world" } as never);
          yield* Queue.offer(queue, {
            kind: "citation",
            sessionId,
            citationId: "provider-citation-1",
            sourceTitle: "Octant",
            sourceUrl: "https://octant.dev",
          } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: true,
          researchRoute: researchRoute({ backend: "searxng" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: (text) => {
            persistedChunks.push(text);
            return Effect.succeed({
              contentId: decodeChatContentId(
                `82000000-0000-4000-8000-${persistedChunks.length.toString().padStart(12, "0")}`,
              ),
              digest: "a".repeat(64),
              byteLength: text.length,
            });
          },
          persistCitation: () => Effect.succeed(citationId),
        }),
      ),
    );

    expect(persistedChunks).toEqual(["Hello ", "world"]);
    expect(updates.some((entry) => entry.responseRefs.length === 1)).toBe(true);
    expect(updates.at(-1)?.responseRefs).toHaveLength(2);
    expect(updates.at(-1)?.citationIds).toEqual([citationId]);
    expect(updates.at(-1)?.outcome).toBe("completed");
  });

  it("passes finalized attachment bytes to send", async () => {
    const sent: Array<{ readonly attachments: ReadonlyArray<{ readonly bytes: Uint8Array }> }> = [];
    const bytes = new TextEncoder().encode("attachment-bytes");
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: (input: { readonly attachments: ReadonlyArray<{ readonly bytes: Uint8Array }> }) =>
        Effect.gen(function* () {
          sent.push(input);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Done" } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hello",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          attachments: [
            {
              attachmentId: "82000000-0000-4000-8000-000000000080",
              displayName: "note.txt",
              mediaType: "text/plain",
              bytes,
            },
          ],
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          persistAttempt: () => Effect.void,
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "a".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(sent[0]?.attachments[0]?.bytes).toEqual(bytes);
  });

  it("omits the app-managed research tool for provider-native routes", async () => {
    const sent: Array<{ readonly tools: ReadonlyArray<{ readonly name: string }> }> = [];
    const answeredTools: Array<{ readonly isError: boolean; readonly resultJson: string }> = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: (input: { readonly tools: ReadonlyArray<{ readonly name: string }> }) =>
        Effect.gen(function* () {
          sent.push(input);
          yield* Queue.offer(queue, {
            kind: "tool-request",
            sessionId,
            requestId: "unexpected-native-tool",
            toolName: "octant_web_research",
            inputJson: JSON.stringify({ query: "should not execute" }),
          } as never);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Done" } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: (input: { readonly isError: boolean; readonly resultJson: string }) =>
        Effect.sync(() => {
          answeredTools.push(input);
        }),
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "research",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          attachments: [],
          researchEnabled: true,
          researchRoute: researchRoute({ backend: "provider-native" }),
          persistAttempt: () => Effect.void,
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "b".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(sent[0]?.tools).toEqual([]);
    expect(answeredTools).toEqual([
      expect.objectContaining({
        isError: true,
        resultJson: JSON.stringify({ error: "research-unavailable" }),
      }),
    ]);
  });

  it("executes bounded app-managed tools once and returns structured answers", async () => {
    const queue = Effect.runSync(Queue.unbounded<never>());
    const answerTool = vi.fn(() => Effect.void);
    const execute = vi.fn(async () => ({ result: { status: "ok", attached: true } }));
    const sent: Array<{ readonly tools: ReadonlyArray<{ readonly name: string }> }> = [];
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: (input: { readonly tools: ReadonlyArray<{ readonly name: string }> }) =>
        Effect.gen(function* () {
          sent.push(input);
          const request = {
            kind: "tool-request",
            sessionId,
            requestId: "zen-request-1",
            toolName: "octant_zen_attach_thread",
            inputJson: JSON.stringify({ catalogRef: "chat:exact", expectedVersion: 2 }),
          } as never;
          yield* Queue.offer(queue, request);
          yield* Queue.offer(queue, request);
          yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Done" } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "attach it",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          appManagedTools: {
            definitions: [
              {
                name: "octant_zen_attach_thread",
                inputSchema: { type: "object", properties: {}, required: [] },
              },
            ],
            execute,
          },
          persistAttempt: () => Effect.void,
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "a".repeat(64),
              byteLength: 1,
            }),
        } as never),
      ),
    );

    expect(sent[0]?.tools.map((tool) => tool.name)).toEqual(["octant_zen_attach_thread"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(answerTool).toHaveBeenCalledTimes(1);
    expect(answerTool).toHaveBeenCalledWith({
      sessionId,
      requestId: "zen-request-1",
      resultJson: JSON.stringify({ status: "ok", attached: true }),
      isError: false,
    });
  });

  it("calls resume and becomes Waiting without calling send, matching real driver contract where resume only reattaches", async () => {
    const resumeCursor = {
      driverKind: "openai-compatible" as const,
      value: "opaque-session-ref",
    };
    let resumeCalled = false;
    let sendCalled = false;
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId, resumeCursor }),
      resume: (input: {
        readonly sessionId: string;
        readonly resumeCursor: { readonly driverKind: string; readonly value: string };
      }) =>
        Effect.sync(() => {
          resumeCalled = true;
          expect(input.sessionId).toBe(sessionId);
          expect(input.resumeCursor).toEqual(resumeCursor);
          // Real drivers (Codex/Claude) only reattach provider history and
          // return a handle; they emit no terminal events from resume alone.
          return { sessionId: input.sessionId, resumeCursor: input.resumeCursor };
        }),
      send: () =>
        Effect.sync(() => {
          sendCalled = true;
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const driver = {
      acquire: () => Effect.succeed(connection),
    } as unknown as ProviderDriver;
    const updates: ChatAttempt[] = [];
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt("queued"),
          prompt: "continue",
          context: [{ kind: "instructions", text: "Be concise." }],
          scratchRoot: "/tmp/octant-scratch/thread",
          driver,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          mode: "resume",
          resumeCursor,
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "a".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(resumeCalled).toBe(true);
    // Session reattachment must NOT call send — that would create a new
    // provider turn and duplicate the original prompt, context, attachments,
    // and tools.
    expect(sendCalled).toBe(false);
    expect(exit._tag).toBe("Failure");
    expect(updates.at(-1)?.outcome).toBe("waiting");
  });

  it("maps stale-resume provider failure to waiting, never failed", async () => {
    const resumeCursor = {
      driverKind: "openai-compatible" as const,
      value: "opaque-session-ref",
    };
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId, resumeCursor }),
      resume: () =>
        Effect.fail({
          kind: "provider-failure" as const,
          category: "stale-resume" as const,
          message: "Session is no longer available for resume.",
        } as never),
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const driver = {
      acquire: () => Effect.succeed(connection),
    } as unknown as ProviderDriver;
    const updates: ChatAttempt[] = [];
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
        providerNativeExecute: async () => ({
          query: "x",
          backend: "provider-native",
          results: [],
        }),
      }),
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt("queued"),
          prompt: "continue",
          context: [],
          scratchRoot: "/tmp/octant-scratch/thread",
          driver,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          mode: "resume",
          resumeCursor,
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "a".repeat(64),
              byteLength: 5,
            }),
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(updates.at(-1)?.outcome).toBe("waiting");
  });

  it("does not persist Interrupted after a visible reply when Codex asks to approve a web time lookup", async () => {
    const updates: ChatAttempt[] = [];
    const answers: Array<{ readonly requestId: string; readonly approved: boolean }> = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "text-delta",
            sessionId,
            text: "Jeg sjekker lokal tid i Norge nå.",
          } as never);
          yield* Queue.offer(queue, {
            kind: "approval-request",
            sessionId,
            requestId: "approval-web-1",
            action: "command",
            description: "Approval is required for this action.",
          } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: (input: { readonly requestId: string; readonly approved: boolean }) =>
        Effect.gen(function* () {
          answers.push({ requestId: input.requestId, approved: input.approved });
          yield* Queue.offer(queue, {
            kind: "text-delta",
            sessionId,
            text: " Klokken er 19:37.",
          } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
      }),
      timeoutMs: 200,
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hva er klokken?",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "c".repeat(64),
              byteLength: 18,
            }),
        }),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(answers).toEqual([{ requestId: "approval-web-1", approved: false }]);
    expect(updates.at(-1)?.outcome).toBe("completed");
    expect(updates.at(-1)?.outcome).not.toBe("interrupted");
  });

  it("keeps a visible Chat reply completed when Codex still interrupts after a declined web lookup", async () => {
    const updates: ChatAttempt[] = [];
    const answers: Array<{ readonly requestId: string; readonly approved: boolean }> = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "text-delta",
            sessionId,
            text: "Jeg sjekker lokal tid i Norge nå.",
          } as never);
          yield* Queue.offer(queue, {
            kind: "approval-request",
            sessionId,
            requestId: "approval-web-1",
            action: "command",
            description: "Approval is required for this action.",
          } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: (input: { readonly requestId: string; readonly approved: boolean }) =>
        Effect.gen(function* () {
          answers.push({ requestId: input.requestId, approved: input.approved });
          yield* Queue.offer(queue, {
            kind: "interrupted",
            sessionId,
            message: "Provider execution was interrupted.",
          } as never);
        }),
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
      }),
      timeoutMs: 200,
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hva er klokken?",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "d".repeat(64),
              byteLength: 32,
            }),
        }),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(answers).toEqual([{ requestId: "approval-web-1", approved: false }]);
    expect(updates.at(-1)?.outcome).toBe("completed");
    expect(updates.some((entry) => entry.outcome === "interrupted")).toBe(false);
  });

  it("still persists Interrupted when a visible Chat reply is interrupted without a Codex approval", async () => {
    const updates: ChatAttempt[] = [];
    const queue = Effect.runSync(Queue.unbounded<never>());
    const connection = {
      events: Stream.fromQueue(queue),
      start: () => Effect.succeed({ sessionId }),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "text-delta",
            sessionId,
            text: "Jeg sjekker lokal tid i Norge nå.",
          } as never);
          yield* Queue.offer(queue, {
            kind: "interrupted",
            sessionId,
            message: "Provider execution was interrupted.",
          } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const { scheduler, reservation } = makeScheduler();
    const runner = new ChatTurnRunner({
      capacityScheduler: scheduler,
      contextHarness: makeHarness(),
      researchRouter: new ResearchRouter({
        searxngClient: { search: async () => ({ query: "x", backend: "searxng", results: [] }) },
      }),
      timeoutMs: 200,
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run({
          thread: thread(),
          attempt: attempt(),
          prompt: "hva er klokken?",
          scratchRoot: "/tmp/octant-scratch/thread",
          driver: { acquire: () => Effect.succeed(connection) } as never,
          providerInstanceId,
          serviceLimits: serviceLimits(),
          contextSubject: subject,
          contextPlanId: "82000000-0000-4000-8000-000000000050" as never,
          requestShape: "chat-turn",
          varianceReserve: 20,
          reservationId: reservation,
          estimatedTokens: 100,
          researchEnabled: false,
          researchRoute: researchRoute({ kind: "disabled" }),
          attachments: [],
          persistAttempt: (next) => {
            updates.push(next);
            return Effect.void;
          },
          persistResponse: () =>
            Effect.succeed({
              contentId: decodeChatContentId("82000000-0000-4000-8000-000000000070"),
              digest: "e".repeat(64),
              byteLength: 32,
            }),
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(updates.at(-1)?.outcome).toBe("interrupted");
    expect(updates.some((entry) => entry.outcome === "completed")).toBe(false);
  });
});
