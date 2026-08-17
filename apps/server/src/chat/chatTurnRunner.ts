import {
  decodeChatFailure,
  UtcTimestamp,
  type ChatAttempt,
  type ChatAttemptOutcome,
  type ChatCitationId,
  type ChatContentReference,
  type ChatFailure,
  type ChatThread,
  type ProviderAttachmentInput,
  type CapacityReservationId,
  type ContextPlanId,
  type ContextSubjectRef,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderContextBlock,
  type ProviderResumeCursor,
  type ProviderRuntimeEvent,
  type ProviderServiceLimits,
} from "@octant/contracts";
import { Schema } from "effect";
import { transitionChatAttempt } from "@octant/domain/chat-policy";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Scope, Stream } from "effect";
import type { ContextHarnessService } from "../context/contextHarnessService";
import type { ProviderCapacityScheduler } from "../context/providerCapacityScheduler";
import { usageFromRuntimeEvent } from "../providers/providerContextFacts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { countsTowardTurnEventBudget, makeIdleTimeout } from "../providers/turnBudget";
import type { ResearchRouteDecision, ResearchRouter } from "./research/researchRouter";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const RESEARCH_TOOL_NAME = "octant_web_research";
const RESEARCH_TOOL_DEFINITION = {
  name: RESEARCH_TOOL_NAME,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
} as const;
// Discrete events only; streaming deltas are exempt (see turnBudget.ts).
const DEFAULT_MAX_EVENTS = 4_096;
// Inactivity window: a turn is cut off after this long without any provider
// event, not after this much total wall time.
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;

function researchToolsForRoute(
  researchRoute: ResearchRouteDecision,
): ReadonlyArray<typeof RESEARCH_TOOL_DEFINITION> {
  return researchRoute.kind === "ready" && researchRoute.backend === "searxng"
    ? [RESEARCH_TOOL_DEFINITION]
    : [];
}

function mapProviderFailure(failure: ProviderFailure): ChatFailure {
  const category =
    failure.category === "interrupted"
      ? "interrupted"
      : failure.category === "rate-limited" || failure.category === "stale-resume"
        ? "waiting"
        : failure.category === "unauthorized" || failure.category === "unauthenticated"
          ? "unauthorized"
          : failure.category === "unsupported" || failure.category === "incompatible"
            ? "unsupported"
            : failure.category === "provider-failed"
              ? "failed"
              : "unavailable";
  return decodeChatFailure({
    category,
    message: failure.message,
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
  });
}

function isChatFailure(error: unknown): error is ChatFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof (error as ChatFailure).message === "string" &&
    [
      "disconnected",
      "failed",
      "interrupted",
      "invalid",
      "stale",
      "unauthorized",
      "unavailable",
      "unsupported",
      "waiting",
    ].includes((error as ChatFailure).category)
  );
}

function isProviderFailure(error: unknown): error is ProviderFailure {
  if (typeof error !== "object" || error === null || !("category" in error)) {
    return false;
  }
  const failure = error as ProviderFailure;
  return (
    typeof failure.message === "string" &&
    (failure.category === "incompatible" ||
      failure.category === "invalid-configuration" ||
      failure.category === "protocol" ||
      failure.category === "provider-failed" ||
      failure.category === "rate-limited" ||
      failure.category === "stale-resume" ||
      failure.category === "unauthenticated" ||
      failure.category === "interrupted" ||
      failure.category === "unauthorized" ||
      failure.category === "unavailable" ||
      failure.category === "unsupported")
  );
}

export interface ChatTurnRunnerOptions {
  readonly capacityScheduler: ProviderCapacityScheduler;
  readonly contextHarness: ContextHarnessService;
  readonly researchRouter: ResearchRouter;
  readonly maxEvents?: number;
  readonly timeoutMs?: number;
}

export interface ChatTurnRunnerInput {
  readonly thread: ChatThread;
  readonly attempt: ChatAttempt;
  readonly prompt: string;
  readonly context?: ReadonlyArray<ProviderContextBlock>;
  readonly scratchRoot: string;
  readonly driver: ProviderDriver;
  readonly providerInstanceId: ProviderInstanceId;
  readonly serviceLimits: ProviderServiceLimits;
  readonly contextSubject: ContextSubjectRef;
  readonly contextPlanId: ContextPlanId;
  readonly requestShape: string;
  readonly varianceReserve: number;
  readonly reservationId: CapacityReservationId;
  readonly estimatedTokens: number;
  readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
  readonly researchEnabled: boolean;
  readonly researchRoute: ResearchRouteDecision;
  readonly appManagedTools?: AppManagedToolSet;
  readonly mode?: "send" | "resume";
  readonly resumeCursor?: ProviderResumeCursor;
  readonly persistAttempt: (attempt: ChatAttempt) => Effect.Effect<void, ChatFailure>;
  /**
   * Atomically persists a terminal provider failure and its support anchor.
   * The runner supplies the already-transitioned attempt so the caller never
   * has to commit the failure and diagnostics incident in separate writes.
   */
  readonly persistProviderFailure?: (
    attempt: ChatAttempt,
    failure: ProviderFailure,
  ) => Effect.Effect<void, ChatFailure>;
  readonly persistResponse: (text: string) => Effect.Effect<ChatContentReference, ChatFailure>;
  readonly persistCitation?: (
    event: Extract<ProviderRuntimeEvent, { readonly kind: "citation" }>,
    backend: "searxng" | "provider-native",
  ) => Effect.Effect<ChatCitationId, ChatFailure>;
  readonly clock?: () => string;
  readonly ambiguousRecovery?: ChatAttemptOutcome;
  readonly signal?: AbortSignal;
}

export type { AppManagedToolSet } from "../providers/appManagedToolSet";

export class ChatTurnRunner {
  readonly #capacityScheduler: ProviderCapacityScheduler;
  readonly #contextHarness: ContextHarnessService;
  readonly #maxEvents: number;
  readonly #timeoutMs: number;

  constructor(options: ChatTurnRunnerOptions) {
    this.#capacityScheduler = options.capacityScheduler;
    this.#contextHarness = options.contextHarness;
    this.#maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  run(input: ChatTurnRunnerInput): Effect.Effect<void, ChatFailure, Scope.Scope> {
    const clock = input.clock ?? (() => new Date().toISOString());
    const ambiguousRecovery = input.ambiguousRecovery ?? "interrupted";
    const capacityScheduler = this.#capacityScheduler;
    const contextHarness = this.#contextHarness;
    const maxEvents = this.#maxEvents;
    const timeoutMs = this.#timeoutMs;

    return Effect.gen(function* () {
      let currentAttempt = input.attempt;
      let actualInputTokens = 0;
      let actualOutputTokens = 0;
      let reasoningTokens: number | undefined;
      let cacheReadInputTokens: number | undefined;
      let cacheWriteInputTokens: number | undefined;
      let providerExecutionDurationMs: number | undefined;
      let sawUsage = false;
      let sawVisibleResponse = false;
      let terminalOutcome: ChatAttemptOutcome | undefined;
      const answeredToolRequestIds = new Set<string>();
      const answeredApprovalRequestIds = new Set<string>();
      let selectedResearchBackend: "searxng" | "provider-native" =
        input.researchRoute.kind === "ready" ? input.researchRoute.backend : "searxng";
      let handledEvents = 0;
      const updatedAt = () => decodeTimestamp(clock());

      const persistOutcome = (outcome: ChatAttemptOutcome) =>
        Effect.gen(function* () {
          if (currentAttempt.outcome === outcome) return;
          currentAttempt = transitionChatAttempt(currentAttempt, {
            outcome,
            updatedAt: updatedAt(),
          });
          yield* input.persistAttempt(currentAttempt);
        });

      capacityScheduler.updateProviderFacts({
        limits: input.serviceLimits,
        enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
      });
      const submission = capacityScheduler.submit({
        reservationId: input.reservationId,
        subject: input.contextSubject,
        providerInstanceId: input.providerInstanceId,
        modelId: input.attempt.modelId,
        estimatedTokens: input.estimatedTokens,
        requests: 1,
        origin: "thread",
      });
      if (submission.status === "queued") {
        yield* persistOutcome("interrupted");
        terminalOutcome = "interrupted";
        capacityScheduler.recordTerminal({
          reservationId: input.reservationId,
          outcome: "timeout",
        });
        return yield* Effect.fail(
          decodeChatFailure({
            category: "interrupted",
            message: "Provider capacity is unavailable; retry this turn.",
          }),
        );
      }
      capacityScheduler.markRunning(input.reservationId);

      const persistProviderFailure = (error: unknown) => {
        if (!isProviderFailure(error)) {
          return Effect.fail(error as ChatFailure);
        }
        const failure = mapProviderFailure(error);
        const outcome =
          failure.category === "waiting"
            ? "waiting"
            : failure.category === "interrupted"
              ? "interrupted"
              : "failed";
        return Effect.gen(function* () {
          if (currentAttempt.outcome !== outcome) {
            currentAttempt = transitionChatAttempt(currentAttempt, {
              outcome,
              updatedAt: updatedAt(),
            });
            if (outcome === "failed" && input.persistProviderFailure !== undefined) {
              yield* input.persistProviderFailure(currentAttempt, error);
            } else {
              yield* input.persistAttempt(currentAttempt);
            }
          }
          terminalOutcome = outcome;
          return yield* Effect.fail(failure);
        });
      };

      const connection = yield* input.driver
        .acquire({
          instanceId: input.providerInstanceId,
          projectRoot: input.scratchRoot,
          mode: "chat",
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() =>
              capacityScheduler.recordTerminal({
                reservationId: input.reservationId,
                outcome: "process-death",
              }),
            ),
          ),
          Effect.catchAll(persistProviderFailure),
        );
      const cleanup = { released: false };

      const cancelOwnedSession = () =>
        Effect.gen(function* () {
          if (terminalOutcome !== undefined) return;
          yield* connection
            .interrupt(input.attempt.providerSessionId)
            .pipe(Effect.catchAll(() => Effect.void));
          yield* persistOutcome("cancelled");
          terminalOutcome = "cancelled";
        });

      const persistAmbiguousRecovery = () =>
        Effect.gen(function* () {
          if (terminalOutcome !== undefined) return;
          if (input.signal?.aborted) {
            yield* cancelOwnedSession();
            return;
          }
          yield* persistOutcome(ambiguousRecovery);
          terminalOutcome = ambiguousRecovery;
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (cleanup.released) return;
          cleanup.released = true;
          yield* connection
            .stop(input.attempt.providerSessionId)
            .pipe(Effect.catchAll(() => Effect.void));
          if (terminalOutcome === "completed" && actualInputTokens + actualOutputTokens > 0) {
            capacityScheduler.recordTerminal({
              reservationId: input.reservationId,
              outcome: "completed",
              actualTokens: actualInputTokens + actualOutputTokens,
            });
            try {
              contextHarness.reconcileUsage({
                subject: input.contextSubject,
                planId: input.contextPlanId,
                requestShape: input.requestShape,
                actualInputTokens,
                actualOutputTokens,
                ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
                ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
                ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
                ...(providerExecutionDurationMs === undefined
                  ? {}
                  : { providerExecutionDurationMs }),
                currentVarianceReserve: input.varianceReserve,
                maxAdjustmentTokens: input.varianceReserve,
              });
            } catch {
              // Usage reconciliation is best-effort after a completed turn.
            }
          } else if (terminalOutcome !== undefined) {
            capacityScheduler.recordTerminal({
              reservationId: input.reservationId,
              outcome:
                terminalOutcome === "cancelled"
                  ? "cancelled"
                  : terminalOutcome === "waiting"
                    ? "timeout"
                    : "interrupted",
            });
          } else {
            capacityScheduler.recordTerminal({
              reservationId: input.reservationId,
              outcome: "interrupted",
            });
          }
        }).pipe(Effect.catchAll(() => Effect.void)),
      );

      // Option values belong to the thread's selected model; a pool candidate
      // running a different model gets provider defaults.
      const modelOptionValues =
        input.attempt.modelId === input.thread.modelId &&
        input.thread.modelOptionValues !== undefined &&
        Object.keys(input.thread.modelOptionValues).length > 0
          ? { modelOptionValues: input.thread.modelOptionValues }
          : {};
      const startHandle = yield* (
        input.mode === "resume" && input.resumeCursor !== undefined
          ? connection.resume({
              sessionId: input.attempt.providerSessionId,
              resumeCursor: input.resumeCursor,
              executionPolicy: "approval-gated",
              ...modelOptionValues,
            })
          : connection.start({
              sessionId: input.attempt.providerSessionId,
              modelId: input.attempt.modelId,
              executionPolicy: "approval-gated",
              ...modelOptionValues,
            })
      ).pipe(Effect.catchAll(persistProviderFailure));

      if (startHandle.resumeCursor !== undefined) {
        currentAttempt = { ...currentAttempt, resumeCursor: startHandle.resumeCursor };
        yield* input.persistAttempt(currentAttempt);
      }

      if (input.mode === "resume") {
        // Session reattachment is complete. Real drivers (Codex/Claude) only
        // reattach provider history and return a handle; they emit no terminal
        // events from resume alone. We do NOT call connection.send() because
        // that would create a new provider turn, duplicating the original
        // prompt, context, attachments, and tools into a session that already
        // contains the interrupted turn. The attempt becomes Waiting — the
        // session is reattached and verified, but no generation is continued.
        yield* persistOutcome("waiting");
        terminalOutcome = "waiting";
        return yield* Effect.fail(
          decodeChatFailure({
            category: "waiting",
            message: "Provider session reattached.",
          }),
        );
      }

      const abortWatcher =
        input.signal === undefined
          ? undefined
          : yield* Effect.forkScoped(
              Effect.gen(function* () {
                if (input.signal!.aborted) {
                  yield* cancelOwnedSession();
                  return;
                }
                yield* Effect.async<void>((resume) => {
                  const onAbort = () => resume(Effect.succeed(undefined));
                  input.signal!.addEventListener("abort", onAbort, { once: true });
                  return Effect.sync(() => input.signal!.removeEventListener("abort", onAbort));
                });
                yield* cancelOwnedSession();
              }),
            );

      const idle = yield* makeIdleTimeout(timeoutMs);
      const timeoutWatcher = yield* Effect.forkScoped(
        idle.expired.pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              if (terminalOutcome !== undefined) return;
              yield* connection
                .interrupt(input.attempt.providerSessionId)
                .pipe(Effect.catchAll(() => Effect.void));
              yield* persistOutcome("interrupted");
              terminalOutcome = "interrupted";
              return yield* Effect.fail(
                decodeChatFailure({
                  category: "interrupted",
                  message: "Chat turn timed out after provider inactivity.",
                }),
              );
            }),
          ),
        ),
      );

      const collected = yield* Effect.forkScoped(
        connection.events.pipe(
          Stream.filter((event) => event.sessionId === input.attempt.providerSessionId),
          Stream.takeUntil(
            (event) =>
              event.kind === "waiting" ||
              event.kind === "completed" ||
              event.kind === "interrupted" ||
              event.kind === "failed",
          ),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              yield* idle.touch;
              if (countsTowardTurnEventBudget(event)) handledEvents += 1;
              if (handledEvents > maxEvents) {
                yield* persistOutcome("interrupted");
                terminalOutcome = "interrupted";
                return yield* Effect.fail(
                  decodeChatFailure({
                    category: "interrupted",
                    message: "Chat turn exceeded the bounded event budget.",
                  }),
                );
              }
              if (input.signal?.aborted) {
                yield* cancelOwnedSession();
                return yield* Effect.fail(
                  decodeChatFailure({
                    category: "interrupted",
                    message: "Chat turn was cancelled.",
                  }),
                );
              }
              if (event.kind === "text-delta") {
                if (event.text.trim().length > 0) sawVisibleResponse = true;
                if (currentAttempt.outcome === "queued") {
                  currentAttempt = transitionChatAttempt(currentAttempt, {
                    outcome: "streaming",
                    updatedAt: updatedAt(),
                  });
                }
                const responseRef = yield* input.persistResponse(event.text);
                currentAttempt = {
                  ...currentAttempt,
                  responseRefs: [...currentAttempt.responseRefs, responseRef],
                  updatedAt: updatedAt(),
                };
                yield* input.persistAttempt(currentAttempt);
                return;
              }
              if (event.kind === "usage") {
                sawUsage = true;
                actualInputTokens = event.inputTokens;
                actualOutputTokens = event.outputTokens;
                const observation = usageFromRuntimeEvent(event);
                if (observation !== undefined) {
                  actualInputTokens = observation.inputTokens;
                  actualOutputTokens = observation.outputTokens;
                  reasoningTokens = observation.reasoningTokens ?? reasoningTokens;
                  cacheReadInputTokens = observation.cacheReadInputTokens ?? cacheReadInputTokens;
                  cacheWriteInputTokens =
                    observation.cacheWriteInputTokens ?? cacheWriteInputTokens;
                  providerExecutionDurationMs =
                    observation.providerExecutionDurationMs ?? providerExecutionDurationMs;
                }
                return;
              }
              if (event.kind === "approval-request") {
                if (answeredApprovalRequestIds.has(event.requestId)) return;
                answeredApprovalRequestIds.add(event.requestId);
                // Chat has no filesystem, shell, or network authority. Decline
                // Codex-native approvals so the turn can finish instead of
                // aborting the pending tool as a user interrupt.
                yield* connection.answerApproval({
                  sessionId: input.attempt.providerSessionId,
                  requestId: event.requestId,
                  approved: false,
                });
                return;
              }
              if (event.kind === "tool-request") {
                if (answeredToolRequestIds.has(event.requestId)) return;
                answeredToolRequestIds.add(event.requestId);
                if (event.toolName === RESEARCH_TOOL_NAME) {
                  if (!input.researchEnabled) {
                    yield* connection.answerTool({
                      sessionId: input.attempt.providerSessionId,
                      requestId: event.requestId,
                      resultJson: JSON.stringify({ error: "research-disabled" }),
                      isError: true,
                    });
                    return;
                  }
                  let parsedQuery = "";
                  try {
                    const parsed = JSON.parse(event.inputJson) as { readonly query?: string };
                    parsedQuery = typeof parsed.query === "string" ? parsed.query : input.prompt;
                  } catch {
                    parsedQuery = input.prompt;
                  }
                  const route = input.researchRoute;
                  if (route.kind !== "ready" || route.backend !== "searxng") {
                    yield* connection.answerTool({
                      sessionId: input.attempt.providerSessionId,
                      requestId: event.requestId,
                      resultJson: JSON.stringify({ error: "research-unavailable" }),
                      isError: true,
                    });
                    return;
                  }
                  selectedResearchBackend = route.backend;
                  const results = yield* Effect.tryPromise({
                    try: () =>
                      route.execute({
                        query: parsedQuery,
                        limit: 5,
                        ...(input.signal === undefined ? {} : { signal: input.signal }),
                      }),
                    catch: () =>
                      decodeChatFailure({ category: "failed", message: "Research failed." }),
                  });
                  yield* connection.answerTool({
                    sessionId: input.attempt.providerSessionId,
                    requestId: event.requestId,
                    resultJson: JSON.stringify(results),
                    isError: false,
                  });
                  return;
                }

                const toolSet = input.appManagedTools;
                const allowed = toolSet?.definitions.some(
                  (definition) => definition.name === event.toolName,
                );
                if (toolSet === undefined || allowed !== true) {
                  yield* connection.answerTool({
                    sessionId: input.attempt.providerSessionId,
                    requestId: event.requestId,
                    resultJson: JSON.stringify({ error: "tool-unavailable" }),
                    isError: true,
                  });
                  return;
                }
                const execution = yield* Effect.tryPromise({
                  try: () =>
                    toolSet.execute({
                      name: event.toolName,
                      inputJson: event.inputJson,
                      ...(input.signal === undefined ? {} : { signal: input.signal }),
                    }),
                  catch: () =>
                    decodeChatFailure({
                      category: "failed",
                      message: "App-managed tool execution failed.",
                    }),
                });
                yield* connection.answerTool({
                  sessionId: input.attempt.providerSessionId,
                  requestId: event.requestId,
                  resultJson: JSON.stringify(execution.result),
                  isError: execution.isError === true,
                });
                return;
              }
              if (event.kind === "citation" && input.persistCitation !== undefined) {
                const citationId = yield* input.persistCitation(event, selectedResearchBackend);
                currentAttempt = {
                  ...currentAttempt,
                  citationIds: [...currentAttempt.citationIds, citationId],
                  updatedAt: updatedAt(),
                };
                yield* input.persistAttempt(currentAttempt);
                return;
              }
              if (event.kind === "waiting") {
                yield* persistOutcome("waiting");
                terminalOutcome = "waiting";
                return;
              }
              if (event.kind === "completed") {
                if (currentAttempt.outcome === "queued") {
                  yield* persistOutcome("streaming");
                }
                if (currentAttempt.responseRefs.length === 0 || !sawVisibleResponse) {
                  yield* persistOutcome("failed");
                  terminalOutcome = "failed";
                  return yield* Effect.fail(
                    decodeChatFailure({
                      category: "failed",
                      message: "The provider completed without a visible reply.",
                    }),
                  );
                }
                currentAttempt = {
                  ...transitionChatAttempt(currentAttempt, {
                    outcome: "completed",
                    updatedAt: updatedAt(),
                  }),
                  ...(sawUsage
                    ? {
                        usage: { inputTokens: actualInputTokens, outputTokens: actualOutputTokens },
                      }
                    : {}),
                };
                yield* input.persistAttempt(currentAttempt);
                terminalOutcome = "completed";
                return;
              }
              if (event.kind === "interrupted") {
                if (
                  !input.signal?.aborted &&
                  terminalOutcome !== "cancelled" &&
                  answeredApprovalRequestIds.size > 0 &&
                  sawVisibleResponse &&
                  currentAttempt.responseRefs.length > 0
                ) {
                  // Codex reports declined native tools as a user interrupt.
                  // Keep the already-visible Chat reply instead of a Retry card.
                  if (currentAttempt.outcome === "queued") {
                    yield* persistOutcome("streaming");
                  }
                  currentAttempt = {
                    ...transitionChatAttempt(currentAttempt, {
                      outcome: "completed",
                      updatedAt: updatedAt(),
                    }),
                    ...(sawUsage
                      ? {
                          usage: {
                            inputTokens: actualInputTokens,
                            outputTokens: actualOutputTokens,
                          },
                        }
                      : {}),
                  };
                  yield* input.persistAttempt(currentAttempt);
                  terminalOutcome = "completed";
                  return;
                }
                yield* persistOutcome("interrupted");
                terminalOutcome = "interrupted";
                return yield* Effect.fail(
                  decodeChatFailure({ category: "interrupted", message: event.message }),
                );
              }
              if (event.kind === "failed") {
                return yield* persistProviderFailure(event.failure);
              }
            }),
          ),
        ),
      );

      yield* Effect.yieldNow();
      yield* Effect.sleep(1);

      if (input.signal?.aborted || terminalOutcome !== undefined) {
        yield* cancelOwnedSession();
        return yield* Effect.fail(
          decodeChatFailure({ category: "interrupted", message: "Chat turn was cancelled." }),
        );
      }

      yield* connection
        .send({
          sessionId: input.attempt.providerSessionId,
          prompt: input.prompt,
          context: [...(input.context ?? [])],
          attachments: [...input.attachments],
          tools: [
            ...(input.researchEnabled ? researchToolsForRoute(input.researchRoute) : []),
            ...(input.appManagedTools?.definitions ?? []),
          ],
        })
        .pipe(Effect.catchAll(persistProviderFailure));

      const waitForEvents =
        abortWatcher === undefined
          ? Effect.raceFirst(Fiber.join(collected), Fiber.join(timeoutWatcher))
          : Effect.raceFirst(
              Fiber.join(collected),
              Effect.raceFirst(Fiber.join(abortWatcher), Fiber.join(timeoutWatcher)),
            );

      const exit = yield* Effect.exit(waitForEvents);
      yield* Fiber.interrupt(collected);
      yield* Fiber.interrupt(timeoutWatcher);
      if (abortWatcher !== undefined) {
        yield* Fiber.interrupt(abortWatcher);
      }
      if (exit._tag === "Failure") {
        if (terminalOutcome === undefined) {
          yield* persistAmbiguousRecovery();
        }
        if (terminalOutcome === "cancelled") {
          return yield* Effect.fail(
            decodeChatFailure({
              category: "interrupted",
              message: "Chat turn was cancelled.",
            }),
          );
        }
        return yield* Effect.failCause(exit.cause);
      }

      if (terminalOutcome === undefined) {
        yield* persistAmbiguousRecovery();
        return yield* Effect.fail(
          decodeChatFailure({
            category: ambiguousRecovery === "waiting" ? "waiting" : "interrupted",
            message: "Provider turn ended without a terminal outcome.",
          }),
        );
      }
      if (terminalOutcome === "cancelled") {
        return yield* Effect.fail(
          decodeChatFailure({
            category: "interrupted",
            message: "Chat turn was cancelled.",
          }),
        );
      }
      if (terminalOutcome === "waiting") {
        return yield* Effect.fail(
          decodeChatFailure({
            category: "waiting",
            message: "Provider is waiting.",
          }),
        );
      }
    }).pipe(
      Effect.mapError((error): ChatFailure => {
        if (isChatFailure(error)) return error;
        if (isProviderFailure(error)) return mapProviderFailure(error);
        return decodeChatFailure({
          category: "unavailable",
          message: "Chat turn failed.",
        });
      }),
    );
  }
}
