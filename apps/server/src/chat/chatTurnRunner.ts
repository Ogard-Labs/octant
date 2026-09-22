import { boundedToolResultJson } from "../providers/toolResultJson";
import {
  decodeChatAttemptQuestion,
  decodeChatFailure,
  decodeDiagnosticFailureCode,
  UtcTimestamp,
  type ChatAttempt,
  type ChatAttemptFailure,
  type ChatAttemptOutcome,
  type ChatAttemptQuestion,
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
  upsertThreadTaskProgress,
} from "@octant/contracts";
import { answerChatTurnQuestion, transitionChatAttempt } from "@octant/domain/chat-policy";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Cause, Deferred, Effect, Fiber, Option, Schema, Scope, Stream } from "effect";
import type { ContextHarnessService } from "../context/contextHarnessService";
import type { ProviderCapacityScheduler } from "../context/providerCapacityScheduler";
import { decodeSpendCeilingReservationId, type SpendCeilingService } from "../spendCeilingService";
import { usageFromRuntimeEvent } from "../providers/providerContextFacts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { subscribeThenSend } from "../providers/providerEventDelivery";
import { countsTowardTurnEventBudget, makeIdleTimeout } from "../providers/turnBudget";
import type { ResearchRouteDecision, ResearchRouter } from "./research/researchRouter";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

// Discrete events only; streaming deltas are exempt (see turnBudget.ts).
const DEFAULT_MAX_EVENTS = 4_096;
// Inactivity window: a turn is cut off after this long without any provider
// event, not after this much total wall time.
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;
// A question record holds at most this many options, matching the attempt
// contract; longer option lists are cut, not refused.
const MAX_ATTEMPT_QUESTION_OPTIONS = 8;

/**
 * Caps one line of a provider question at the attempt record's bound. The
 * provider already guarantees the text is non-empty; only the length can
 * overflow, and a truncated question still beats an unanswerable one.
 */
function boundedQuestionText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 2_000) return trimmed;
  return trimmed.slice(0, 2_000).trim();
}

const RESEARCH_TOOL_NAME = "octant_web_research";
/** The harness tool a direct-API provider calls to ask the person a question. */
const HARNESS_ASK_USER_TOOL_NAME = "ask-user";
const RESEARCH_TOOL_DEFINITION = {
  name: RESEARCH_TOOL_NAME,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
} as const;

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
  readonly spendCeiling?: {
    readonly admit: SpendCeilingService["admit"];
    readonly settle: SpendCeilingService["settle"];
  };
}

/**
 * One question a live attempt asked and is parked on, keyed by attempt id.
 * The answer command reaches the turn through this channel; the runner is the
 * single writer of the attempt, so it journals the answered question itself.
 * `abandon` is what keeps an answerer from waiting forever when the turn ends
 * without an answer.
 */
interface OpenChatQuestion {
  readonly requestId: string;
  readonly deliver: (answer: string) => void;
  readonly answered: Promise<ChatAttempt>;
  readonly abandon: (reason: string) => void;
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
  /** Observes a completed reply with its full text and the tool calls it made. */
  readonly onTurnCompleted?: (input: {
    readonly text: string;
    readonly toolCalls: number;
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  }) => Promise<void>;
}

export type { AppManagedToolSet } from "../providers/appManagedToolSet";

export class ChatTurnRunner {
  readonly #capacityScheduler: ProviderCapacityScheduler;
  readonly #contextHarness: ContextHarnessService;
  readonly #maxEvents: number;
  readonly #timeoutMs: number;
  readonly #spendCeiling: ChatTurnRunnerOptions["spendCeiling"];
  readonly #openQuestions = new Map<string, OpenChatQuestion>();

  constructor(options: ChatTurnRunnerOptions) {
    this.#capacityScheduler = options.capacityScheduler;
    this.#spendCeiling = options.spendCeiling;
    this.#contextHarness = options.contextHarness;
    this.#maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Hands a person's answer to a question a live turn asked, and resolves with
   * the attempt as the turn journalled it. `undefined` when this host is not
   * running that attempt — the provider session is gone, the question can no
   * longer be answered, and the turn must be interrupted instead.
   */
  async deliverQuestionAnswer(input: {
    readonly attemptId: string;
    readonly requestId: string;
    readonly answer: string;
  }): Promise<ChatAttempt | undefined> {
    const question = this.#openQuestions.get(input.attemptId);
    if (question === undefined || question.requestId !== input.requestId) return undefined;
    question.deliver(input.answer);
    return await question.answered;
  }

  run(input: ChatTurnRunnerInput): Effect.Effect<void, ChatFailure, Scope.Scope> {
    const clock = input.clock ?? (() => new Date().toISOString());
    const ambiguousRecovery = input.ambiguousRecovery ?? "interrupted";
    const capacityScheduler = this.#capacityScheduler;
    const contextHarness = this.#contextHarness;
    const maxEvents = this.#maxEvents;
    const timeoutMs = this.#timeoutMs;
    const spendCeiling = this.#spendCeiling;
    const openQuestions = this.#openQuestions;

    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await input.appManagedTools?.close?.();
        }).pipe(Effect.catchAllCause(() => Effect.logWarning("App-managed tool cleanup failed."))),
      );
      let currentAttempt = input.attempt;
      let actualInputTokens = 0;
      let actualOutputTokens = 0;
      let contextTokens: number | undefined;
      let contextWindow: number | undefined;
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
      let responseText = "";
      let parkedQuestionRequestId: string | undefined;
      const updatedAt = () => decodeTimestamp(clock());
      const observeCompleted = () =>
        input.onTurnCompleted === undefined
          ? Effect.void
          : Effect.promise(() =>
              input.onTurnCompleted!({
                text: responseText,
                toolCalls: answeredToolRequestIds.size,
                ...(sawUsage
                  ? { usage: { inputTokens: actualInputTokens, outputTokens: actualOutputTokens } }
                  : {}),
              }).catch(() => undefined),
            );

      const persistOutcome = (outcome: ChatAttemptOutcome, failure?: ChatAttemptFailure) =>
        Effect.gen(function* () {
          if (currentAttempt.outcome === outcome) return;
          currentAttempt = transitionChatAttempt(currentAttempt, {
            outcome,
            updatedAt: updatedAt(),
            ...(failure === undefined ? {} : { failure }),
          });
          yield* input.persistAttempt(currentAttempt);
        });

      /**
       * Ends the turn on a cause the runner itself observed — a tool call
       * that failed or never returned, a reply that never arrived. The cause
       * rides on the attempt as a bounded code so the transcript can say what
       * happened; the thrown ChatFailure keeps carrying the internal detail
       * for logs.
       */
      const failTurn = (failure: ChatAttemptFailure, error: ChatFailure) =>
        Effect.gen(function* () {
          yield* persistOutcome("failed", failure);
          terminalOutcome = "failed";
          return yield* Effect.fail(error);
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
        yield* persistOutcome("interrupted", {
          code: decodeDiagnosticFailureCode("capacity-unavailable"),
        });
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
      const spendReservationId = decodeSpendCeilingReservationId(String(input.reservationId));
      const spendAdmission = spendCeiling?.admit({
        reservationId: spendReservationId,
        threadId: String(input.thread.id),
        threadType: "chat-thread",
        ...(input.thread.projectId === undefined
          ? {}
          : { projectId: String(input.thread.projectId) }),
        turnUpperBoundTokens: input.estimatedTokens,
      });
      if (spendAdmission?.status === "refused") {
        yield* persistOutcome("interrupted", {
          code: decodeDiagnosticFailureCode(spendAdmission.refusal.kind),
        });
        terminalOutcome = "interrupted";
        capacityScheduler.recordTerminal({
          reservationId: input.reservationId,
          outcome: "cancelled",
        });
        return yield* Effect.fail(
          decodeChatFailure({
            category: "unavailable",
            message: spendAdmission.refusal.message,
          }),
        );
      }

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
              // Waiting is resumable rather than failed, so the attempt only
              // records a cause once the outcome states one.
              ...(outcome === "waiting"
                ? {}
                : {
                    failure: {
                      code: decodeDiagnosticFailureCode(error.category),
                      ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
                    },
                  }),
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
          // Acquisition can fail before the session finalizer owns the reservation.
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? Effect.sync(() => spendCeiling?.settle({ reservationId: spendReservationId }))
              : Effect.void,
          ),
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
          yield* persistOutcome(
            ambiguousRecovery,
            ambiguousRecovery === "waiting"
              ? undefined
              : { code: decodeDiagnosticFailureCode("incomplete") },
          );
          terminalOutcome = ambiguousRecovery;
        });

      /**
       * Parks the attempt on one question and resolves with the person's
       * answer. Shared by the two ways a provider turn asks a person a
       * question: a question event on the provider stream, and the harness's
       * own ask-user tool call. The attempt journals the question so the
       * transcript can show it again after a reload; the caller decides where
       * the answer goes (the provider session, or the tool result).
       */
      const parkOnQuestion = (question: ChatAttemptQuestion): Effect.Effect<string, ChatFailure> =>
        Effect.gen(function* () {
          currentAttempt = {
            ...transitionChatAttempt(currentAttempt, {
              outcome: "waiting",
              updatedAt: updatedAt(),
            }),
            pendingQuestion: question,
          };
          yield* input.persistAttempt(currentAttempt);
          const answerDeferred = yield* Deferred.make<string>();
          let resolveAnswered!: (attempt: ChatAttempt) => void;
          let abandonAnswered!: (reason: string) => void;
          const answered = new Promise<ChatAttempt>((resolve, reject) => {
            resolveAnswered = resolve;
            abandonAnswered = reject;
          });
          openQuestions.set(String(input.attempt.id), {
            requestId: question.requestId,
            deliver: (answer) => {
              void Effect.runPromise(Deferred.succeed(answerDeferred, answer)).catch(
                () => undefined,
              );
            },
            answered,
            abandon: abandonAnswered,
          });
          openAnswerSettle = resolveAnswered;
          openAnswerAbandon = abandonAnswered;
          parkedQuestionRequestId = question.requestId;
          // The turn parks on the person here, so the idle timeout is
          // suspended for the wait: a question is the provider doing its job,
          // not silence. Only abort ends it otherwise.
          const answer = yield* idle.during(Deferred.await(answerDeferred));
          // One answer only: the channel closes the moment it is read, so a
          // late or duplicated answer is refused upstream. The settle hooks
          // stay with the answer's caller until the attempt is journalled.
          openQuestions.delete(String(input.attempt.id));
          parkedQuestionRequestId = undefined;
          return answer;
        });

      /** The attempt an open question resolves on, once its answer is journalled. */
      let openAnswerSettle: ((attempt: ChatAttempt) => void) | undefined;
      let openAnswerAbandon: ((reason: string) => void) | undefined;

      const settleAnsweredAttempt = (answer: string, requestId: string) =>
        Effect.gen(function* () {
          currentAttempt = answerChatTurnQuestion(currentAttempt, {
            turnId: input.attempt.turnId,
            attemptId: input.attempt.id,
            requestId,
            answer,
            answeredAt: updatedAt(),
          });
          const persisted = yield* Effect.either(input.persistAttempt(currentAttempt));
          if (persisted._tag === "Left") {
            // The journal did not take the answered state, so the answerer
            // must not be told it was accepted; the pending failure carries
            // what the turn now settles as.
            openAnswerAbandon?.("Chat turn ended before the answer was journalled.");
            openAnswerSettle = undefined;
            openAnswerAbandon = undefined;
            return yield* Effect.fail(persisted.left);
          }
          openAnswerSettle?.(currentAttempt);
          openAnswerSettle = undefined;
          openAnswerAbandon = undefined;
          return;
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (cleanup.released) return;
          cleanup.released = true;
          // A turn that ends without its question being answered — abort,
          // crash, interrupt — must not leave the answer channel reachable,
          // and an answerer already parked on the promise must be let go.
          const unanswered = openQuestions.get(String(input.attempt.id));
          openQuestions.delete(String(input.attempt.id));
          unanswered?.abandon("Chat turn ended before the answer was delivered.");
          yield* connection
            .stop(input.attempt.providerSessionId)
            .pipe(Effect.catchAll(() => Effect.void));
          if (terminalOutcome === "completed") {
            if (sawUsage) {
              spendCeiling?.settle({
                reservationId: decodeSpendCeilingReservationId(String(input.reservationId)),
                observedTokens: actualInputTokens + actualOutputTokens,
              });
              capacityScheduler.recordTerminal({
                reservationId: input.reservationId,
                outcome: "completed",
                actualTokens: actualInputTokens + actualOutputTokens,
              });
            } else {
              spendCeiling?.settle({
                reservationId: decodeSpendCeilingReservationId(String(input.reservationId)),
              });
              capacityScheduler.recordTerminal({
                reservationId: input.reservationId,
                outcome: "completed",
              });
            }
            try {
              contextHarness.reconcileUsage({
                subject: input.contextSubject,
                planId: input.contextPlanId,
                requestShape: input.requestShape,
                actualInputTokens,
                actualOutputTokens,
                ...(contextTokens === undefined ? {} : { contextTokens }),
                ...(contextWindow === undefined ? {} : { contextWindow }),
                ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
                ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
                ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
                ...(providerExecutionDurationMs === undefined
                  ? {}
                  : { providerExecutionDurationMs }),
                ...(sawUsage ? {} : { providerReported: false }),
                currentVarianceReserve: input.varianceReserve,
                maxAdjustmentTokens: input.varianceReserve,
              });
            } catch {
              // Usage reconciliation is best-effort after a completed turn.
            }
          } else if (terminalOutcome !== undefined) {
            spendCeiling?.settle({
              reservationId: decodeSpendCeilingReservationId(String(input.reservationId)),
            });
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
            spendCeiling?.settle({
              reservationId: decodeSpendCeilingReservationId(String(input.reservationId)),
            });
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
        input.resumeCursor !== undefined
          ? connection.resume({
              sessionId: input.attempt.providerSessionId,
              resumeCursor: input.resumeCursor,
              executionPolicy: "approval-gated",
              tools: [
                ...(input.researchEnabled ? researchToolsForRoute(input.researchRoute) : []),
                ...(input.appManagedTools?.definitions ?? []),
              ],
              ...modelOptionValues,
            })
          : connection.start({
              sessionId: input.attempt.providerSessionId,
              modelId: input.attempt.modelId,
              executionPolicy: "approval-gated",
              tools: [
                ...(input.researchEnabled ? researchToolsForRoute(input.researchRoute) : []),
                ...(input.appManagedTools?.definitions ?? []),
              ],
              ...modelOptionValues,
            })
      ).pipe(Effect.catchAll(persistProviderFailure));

      const resumeCursor = startHandle.resumeCursor ?? input.resumeCursor;
      if (
        input.driver.conversationOwnership === "provider" &&
        (String(startHandle.sessionId) !== String(input.attempt.providerSessionId) ||
          resumeCursor === undefined)
      ) {
        return yield* persistProviderFailure({
          category: "stale-resume",
          message: "Provider did not return the exact resumable Chat session.",
        });
      }

      if (resumeCursor !== undefined) {
        currentAttempt = { ...currentAttempt, resumeCursor };
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
              yield* persistOutcome("interrupted", {
                code: decodeDiagnosticFailureCode("timed-out"),
              });
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

      const collected = yield* subscribeThenSend({
        connection,
        consume: (runtimeEvents) =>
          runtimeEvents.pipe(
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
                  yield* persistOutcome("interrupted", {
                    code: decodeDiagnosticFailureCode("event-budget-exceeded"),
                  });
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
                  if (responseText.length < 262_144) responseText += event.text;
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
                  contextTokens = event.contextTokens ?? contextTokens;
                  contextWindow = event.contextWindow ?? contextWindow;
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
                  const requestSignal = connection.toolRequestSignal?.({
                    sessionId: input.attempt.providerSessionId,
                    requestId: event.requestId,
                  });
                  const executionSignal =
                    requestSignal === undefined
                      ? input.signal
                      : input.signal === undefined
                        ? requestSignal
                        : AbortSignal.any([input.signal, requestSignal]);
                  if (executionSignal?.aborted) return;
                  if (event.toolName === HARNESS_ASK_USER_TOOL_NAME) {
                    // The harness's ask-user tool is the way a turn running on
                    // a direct-API provider asks the person a question. It
                    // parks the turn on the question like a provider-native
                    // ask, and the answer rides back as the tool result, so
                    // the model continues with it. No question can park
                    // through a tool call the host did not offer.
                    const allowed =
                      input.appManagedTools?.definitions.some(
                        (definition) => definition.name === event.toolName,
                      ) === true;
                    if (!allowed) {
                      yield* connection.answerTool({
                        sessionId: input.attempt.providerSessionId,
                        requestId: event.requestId,
                        resultJson: JSON.stringify({ error: "tool-unavailable" }),
                        isError: true,
                      });
                      return;
                    }
                    if (parkedQuestionRequestId !== undefined) {
                      yield* connection
                        .interrupt(input.attempt.providerSessionId)
                        .pipe(Effect.catchAll(() => Effect.void));
                      return;
                    }
                    let parsedInput: {
                      readonly prompt?: unknown;
                      readonly options?: unknown;
                    };
                    try {
                      const decoded: unknown = JSON.parse(event.inputJson);
                      parsedInput =
                        decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
                          ? (decoded as {
                              readonly prompt?: unknown;
                              readonly options?: unknown;
                            })
                          : {};
                    } catch {
                      parsedInput = {};
                    }
                    const prompt =
                      typeof parsedInput.prompt === "string"
                        ? boundedQuestionText(parsedInput.prompt)
                        : "";
                    const rawOptions = Array.isArray(parsedInput.options)
                      ? parsedInput.options
                      : [];
                    const options = rawOptions
                      .filter((option): option is string => typeof option === "string")
                      .slice(0, MAX_ATTEMPT_QUESTION_OPTIONS)
                      .map(boundedQuestionText)
                      .filter((label) => label.length > 0)
                      .map((label) => ({ label }));
                    if (prompt.length === 0) {
                      yield* connection.answerTool({
                        sessionId: input.attempt.providerSessionId,
                        requestId: event.requestId,
                        resultJson: JSON.stringify({ error: "question-invalid" }),
                        isError: true,
                      });
                      return;
                    }
                    const answer = yield* parkOnQuestion(
                      decodeChatAttemptQuestion({
                        requestId: event.requestId,
                        prompt,
                        options,
                      }),
                    );
                    yield* connection.answerTool({
                      sessionId: input.attempt.providerSessionId,
                      requestId: event.requestId,
                      resultJson: JSON.stringify({ answer }),
                      isError: false,
                    });
                    yield* settleAnsweredAttempt(answer, event.requestId);
                    return;
                  }
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
                    const researchAbort = new AbortController();
                    const researchSignal =
                      executionSignal === undefined
                        ? researchAbort.signal
                        : AbortSignal.any([executionSignal, researchAbort.signal]);
                    // App-owned work suspends the idle timeout, so the call
                    // gets its own copy of the turn's deadline: a research
                    // request that never returns must end the turn, not
                    // leave it running forever.
                    const results = yield* idle.during(
                      Effect.raceFirst(
                        Effect.tryPromise({
                          try: () =>
                            route.execute({
                              query: parsedQuery,
                              limit: 5,
                              signal: researchSignal,
                            }),
                          catch: () =>
                            decodeChatFailure({
                              category: "failed",
                              message: "Research failed.",
                            }),
                        }).pipe(
                          Effect.catchAll((error) =>
                            failTurn(
                              { code: decodeDiagnosticFailureCode("research-failed") },
                              error,
                            ),
                          ),
                        ),
                        Effect.andThen(
                          Effect.sleep(timeoutMs),
                          Effect.gen(function* () {
                            researchAbort.abort();
                            return yield* failTurn(
                              { code: decodeDiagnosticFailureCode("research-timed-out") },
                              decodeChatFailure({
                                category: "failed",
                                message: "Research did not return before the turn deadline.",
                              }),
                            );
                          }),
                        ),
                      ),
                    );
                    if (executionSignal?.aborted) return;
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
                  const toolAbort = new AbortController();
                  const toolSignal =
                    executionSignal === undefined
                      ? toolAbort.signal
                      : AbortSignal.any([executionSignal, toolAbort.signal]);
                  // App-owned work suspends the idle timeout, so the call gets
                  // the same window as its own deadline: a tool that never
                  // returns ends the turn with a named cause instead of
                  // hanging it past the point the provider went silent.
                  const execution = yield* idle.during(
                    Effect.raceFirst(
                      Effect.tryPromise({
                        try: () =>
                          toolSet.execute({
                            name: event.toolName,
                            inputJson: event.inputJson,
                            signal: toolSignal,
                          }),
                        catch: () =>
                          decodeChatFailure({
                            category: "failed",
                            message: "App-managed tool execution failed.",
                          }),
                      }).pipe(
                        Effect.catchAll((error) =>
                          failTurn({ code: decodeDiagnosticFailureCode("tool-failed") }, error),
                        ),
                      ),
                      Effect.andThen(
                        Effect.sleep(timeoutMs),
                        Effect.gen(function* () {
                          toolAbort.abort();
                          return yield* failTurn(
                            { code: decodeDiagnosticFailureCode("tool-timed-out") },
                            decodeChatFailure({
                              category: "failed",
                              message:
                                "An app-managed tool call did not return before the turn deadline.",
                            }),
                          );
                        }),
                      ),
                    ),
                  );
                  if (executionSignal?.aborted) return;
                  yield* connection.answerTool({
                    sessionId: input.attempt.providerSessionId,
                    requestId: event.requestId,
                    resultJson: boundedToolResultJson(execution.result),
                    ...(execution.images === undefined ? {} : { images: execution.images }),
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
                if (event.kind === "task-progress") {
                  // Providers restate the whole plan as it moves; the attempt
                  // carries the latest list so a replayed attempt-updated is
                  // the full state, not a delta another event may never heal.
                  // The runtime vocabulary says "in-progress"; the persisted
                  // one says "running" — the transcript's own word.
                  const nextTasks = upsertThreadTaskProgress(currentAttempt.tasks, {
                    taskId: event.taskId,
                    state: event.status === "in-progress" ? "running" : event.status,
                    summary: event.summary,
                  });
                  if (nextTasks === currentAttempt.tasks) return;
                  currentAttempt = { ...currentAttempt, tasks: nextTasks, updatedAt: updatedAt() };
                  yield* input.persistAttempt(currentAttempt);
                  return;
                }
                if (event.kind === "waiting") {
                  yield* persistOutcome("waiting");
                  terminalOutcome = "waiting";
                  return;
                }
                if (event.kind === "user-input-request") {
                  if (parkedQuestionRequestId !== undefined) {
                    // The turn parks on one question at a time; a second
                    // concurrent one cannot both be answered from one
                    // surface. A multi-question set queues behind the park and
                    // is asked right after its predecessor is answered, so
                    // this interrupt is only for genuinely concurrent asks.
                    yield* connection
                      .interrupt(input.attempt.providerSessionId)
                      .pipe(Effect.catchAll(() => Effect.void));
                    return;
                  }
                  const answer = yield* parkOnQuestion(
                    decodeChatAttemptQuestion({
                      requestId: event.requestId,
                      prompt: boundedQuestionText(event.prompt),
                      options: event.options
                        .slice(0, MAX_ATTEMPT_QUESTION_OPTIONS)
                        .map((option) => ({
                          label: boundedQuestionText(option.label),
                          ...(option.description === undefined
                            ? {}
                            : { description: boundedQuestionText(option.description) }),
                        })),
                      ...(event.questionIndex === undefined || event.questionCount === undefined
                        ? {}
                        : {
                            questionIndex: event.questionIndex,
                            questionCount: event.questionCount,
                          }),
                    }),
                  );
                  yield* connection.answerUserInput({
                    sessionId: input.attempt.providerSessionId,
                    requestId: event.requestId,
                    answer,
                  });
                  yield* settleAnsweredAttempt(answer, event.requestId);
                  return;
                }
                if (event.kind === "completed") {
                  if (currentAttempt.outcome === "queued") {
                    yield* persistOutcome("streaming");
                  }
                  if (currentAttempt.responseRefs.length === 0 || !sawVisibleResponse) {
                    return yield* failTurn(
                      { code: decodeDiagnosticFailureCode("no-visible-reply") },
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
                          usage: {
                            inputTokens: actualInputTokens,
                            outputTokens: actualOutputTokens,
                          },
                        }
                      : {}),
                  };
                  yield* input.persistAttempt(currentAttempt);
                  terminalOutcome = "completed";
                  yield* observeCompleted();
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
                  yield* persistOutcome("interrupted", {
                    code: decodeDiagnosticFailureCode("interrupted"),
                  });
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
        send: Effect.gen(function* () {
          // The abort and timeout watchers forked above get a turn to record a
          // cancellation before this send commits the turn to the provider.
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
        }),
      });

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
        // A provider failure that surfaced mid-turn — from a connection call
        // inside the event loop rather than acquire or send — still names
        // its cause on the attempt before the original error propagates.
        const providerFailure = Option.getOrUndefined(Cause.failureOption(exit.cause));
        if (providerFailure !== undefined && isProviderFailure(providerFailure)) {
          yield* persistProviderFailure(providerFailure).pipe(Effect.catchAll(() => Effect.void));
        }
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
