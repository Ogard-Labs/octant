import type {
  ProviderChildActivityEvent,
  ShieldWatcherLabel,
  TurnStopReason,
} from "@octant/contracts";
import {
  observeTurnMetrics,
  markThreadToolStepOutsideContent,
  outsideContentRecordedOnly,
  recordThreadShieldReview,
  recordThreadToolStep,
  startTurnMetrics,
  workThreadAccessOf,
  type ThreadToolSteps,
} from "@octant/domain";
import type { RuntimeForgeChangeObserver } from "../shield/runtimeForgeChanges";
import { boundedToolResultJson } from "../providers/toolResultJson";
import {
  MAX_PROVIDER_CONTEXT_BLOCKS,
  MAX_WORK_TURN_RESPONSE_BYTES,
  type ProviderAttachmentInput,
  type ProviderModelOptionValues,
  type ProviderNativeSetup,
  type ProviderContextBlock,
  type ProviderFailure,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderResumeCursor,
  type StartWorkThreadTurnCommand,
  DEFAULT_WORK_ACCESS,
  type WorkAccess,
  type WorkTurnFailure,
  type WorkTurnRequestId,
  type WorkTurnState,
  MAX_THREAD_TASKS_PER_TURN,
  restateThreadTaskList,
  upsertThreadTaskProgress,
  type ThreadTaskProgress,
  type ThreadTaskProgressList,
} from "@octant/contracts";
import type { ProviderDriver, ProviderSessionHandle } from "@octant/provider-sdk/driver";
import { Deferred, Effect, Fiber, Scope, Stream } from "effect";
import { summarizeTurnEnd, type TurnEndSummary } from "../metrics/turnEnd";
import type { LiveTurnTracker } from "../liveTurn/liveTurnRegistry";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { heldTurnContext } from "../providers/heldTurnContext";
import { subscribeThenSend } from "../providers/providerEventDelivery";
import { TurnCompactions, type AutomaticCompactionSighting } from "../context/automaticCompaction";
import {
  NO_RUNTIME_OUTSIDE_CONTENT_MARKS,
  RUNTIME_OUTSIDE_CONTENT_REFUSAL,
  type RuntimeOutsideContentMarking,
} from "../context/runtimeOutsideContentMark";
import { normalizedProviderCallbackId } from "./workRequestRuntime";
import {
  countsTowardTurnEventBudget,
  endsHarnessRetryWait,
  makeIdleTimeout,
  makeTurnTextParagraphs,
  type IdleTimeout,
} from "../providers/turnBudget";

// Discrete events only; streaming deltas are exempt (see turnBudget.ts).
const MAX_EVENTS = 4_096;
// Inactivity window, not total wall time. Matches Chat and Code: a model
// writing one long tool call, such as a Canvas design, can be silent for
// minutes.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const RESPONSE_TRUNCATION_MARKER = "\n[Output truncated by Octant.]";
const textEncoder = new TextEncoder();

export type WorkTurnRuntimeOutcome =
  | {
      readonly kind: "completed";
      readonly response: string;
      readonly outputLimited?: true;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "waiting"; readonly failure: WorkTurnFailure }
  | { readonly kind: "failed"; readonly failure: WorkTurnFailure };

export interface WorkTurnRuntimePort {
  run(input: {
    readonly command: StartWorkThreadTurnCommand;
    readonly providerSessionId: ProviderSessionId;
    readonly resumeCursor?: ProviderResumeCursor;
    readonly onSessionReady?: (handle: ProviderSessionHandle) => void;
    readonly projectRoot: string;
    /** The Project's extra folders, granted what `projectRoot` is granted. */
    readonly extraFolders?: ReadonlyArray<string>;
    readonly driver: ProviderDriver;
    readonly signal: AbortSignal;
    readonly attachments?: ReadonlyArray<ProviderAttachmentInput>;
    readonly context?: ReadonlyArray<ProviderContextBlock>;
    readonly modelOptionValues?: ProviderModelOptionValues;
    /** The thread's access; absent reads as ask-first, which Work always was. */
    readonly access?: WorkAccess;
    /** The thread chose the runtime's own artifact tool and this turn offers it. */
    readonly nativeArtifacts?: boolean;
    /** What the session may load of the provider's own setup; absent keeps it all off. */
    readonly nativeSetup?: ProviderNativeSetup;
    readonly appManagedTools?: AppManagedToolSet;
    /**
     * Records that the runtime's own web search, page fetch, or hosted tool
     * put outside content in front of the model. Without it such a call stops
     * the turn.
     */
    readonly outsideContentMarks?: RuntimeOutsideContentMarking;
    /**
     * Journals each push or pull-request change the runtime's own shell starts,
     * flagging a hard line at Full access; the runtime reports a command only
     * as it starts, so this records and never stops one.
     */
    readonly forgeChanges?: RuntimeForgeChangeObserver;
    /** Told of every runtime event, for Octant Shield's record of remote commands. */
    readonly observeRemoteCommand?: (event: ProviderRuntimeEvent) => void;
    readonly onUsage?: (usage: Extract<ProviderRuntimeEvent, { readonly kind: "usage" }>) => void;
    /**
     * Told of each compaction the runtime made by itself during this turn, so
     * the thread's context ledger can record it.
     */
    readonly onAutomaticCompaction?: (sighting: AutomaticCompactionSighting) => void;
    /** The prompt is about to go to the provider, so the turn may now be charged. */
    readonly onPromptSent?: () => void;
    readonly onDelta?: (response: string) => void;
    /** The endpoint is sending the request again. */
    readonly onRetrying?: (
      notice: Extract<ProviderRuntimeEvent, { readonly kind: "retrying" }>,
    ) => void;
    /** Text, reasoning, or a tool call arrived, so the retry wait is over. */
    readonly onRetryCleared?: () => void;
    /** The provider's restated task list, whole, whenever it moves. */
    readonly onTasks?: (tasks: ThreadTaskProgressList) => void;
    /** The turn's tool calls, whole, whenever one starts, moves, or ends. */
    readonly onToolSteps?: (toolSteps: ThreadToolSteps) => void;
    readonly onChildActivity?: (event: ProviderChildActivityEvent) => void;
    readonly onRequestSettled?: (
      input: { readonly providerSessionId: ProviderSessionId; readonly providerCallbackId: string },
      release: () => void,
    ) => () => void;
    /** Told once when the turn is over, whatever its outcome, with what it cost and how it ran. */
    readonly onTurnEnded?: (turn: TurnEndSummary) => void;
    /** Tells the navigation read what the running turn is doing, from its start to its end. */
    readonly liveTurn?: LiveTurnTracker;
    /** The wall clock the turn is timed against. */
    readonly clock?: () => string;
  }): Promise<WorkTurnRuntimeOutcome>;
  /** Shows an Octant Shield decision on the thread's running turn, if one runs. */
  recordShieldReview?(review: WorkShieldReview & { readonly threadId: string }): void;
}

type WorkTurnRunInput = Parameters<WorkTurnRuntimePort["run"]>[0];

/** One Octant Shield decision for a running Work turn's tool steps. */
type WorkShieldReview = Parameters<typeof recordThreadShieldReview>[1];

/** What a turn tells its meter as the provider's events arrive. */
interface WorkTurnMeter {
  readonly observe: (event: ProviderRuntimeEvent) => void;
  /** The prompt is about to be sent; the wait for a first token starts here. */
  readonly sent: () => void;
}

export interface WorkTurnRuntimeOptions {
  readonly timeoutMs?: number;
}

/**
 * Provider-backed Work turn runner. Acquires the driver in Work mode with
 * project-backed workspace and optional request-projection context, then
 * streams text deltas into a bounded durable response. The session runs at the
 * thread's level with the shell and Git a Code session at that level has;
 * worktree, checkout and pull-request authority stay Code's.
 */
export class WorkTurnRuntime implements WorkTurnRuntimePort {
  readonly #timeoutMs: number;
  /** Each running turn's review rows, by thread: one Work thread runs one turn at a time. */
  readonly #shieldReviews = new Map<string, (review: WorkShieldReview) => void>();

  constructor(options: WorkTurnRuntimeOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Shows Octant Shield's decision on an approval the running turn's tools
   * asked for out of band (the Octant Harness's own approvals) as a review
   * row among the turn's tool steps. A thread with no running turn has no
   * row to add it to; the approval journal that asked still holds it.
   */
  recordShieldReview(review: WorkShieldReview & { readonly threadId: string }): void {
    this.#shieldReviews.get(review.threadId)?.(review);
  }

  async run(input: WorkTurnRunInput): Promise<WorkTurnRuntimeOutcome> {
    const clock = input.clock ?? (() => new Date().toISOString());
    const startedAt = clock();
    // Re-based when the prompt is sent, so the wait for a first token never
    // includes starting the provider's session.
    let timing = startTurnMetrics(startedAt);
    input.liveTurn?.begin(startedAt);
    let outcome: WorkTurnRuntimeOutcome;
    try {
      outcome = await this.#runTurn(input, {
        observe: (event) => {
          timing = observeTurnMetrics(timing, event);
          input.liveTurn?.observe(event);
        },
        sent: () => {
          timing = startTurnMetrics(clock());
        },
      });
    } finally {
      input.liveTurn?.end();
    }
    try {
      input.onTurnEnded?.(
        summarizeTurnEnd({
          metrics: timing,
          stopReason: stopReasonOf(outcome),
          startedAt,
          endedAt: clock(),
        }),
      );
    } catch {
      // Measuring a turn never decides how it ends.
    }
    return outcome;
  }

  async #runTurn(input: WorkTurnRunInput, meter: WorkTurnMeter): Promise<WorkTurnRuntimeOutcome> {
    try {
      if (input.signal.aborted) return { kind: "cancelled" };
      const cleanupTimeoutMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
      const idle = await Effect.runPromise(makeIdleTimeout(this.#timeoutMs));
      const execution = Effect.scoped(
        this.#execute(input, idle, meter).pipe(
          Effect.catchAll((error) => Effect.succeed<WorkTurnRuntimeOutcome>(failureOutcome(error))),
        ),
      ).pipe(Effect.map((outcome): LifecycleResult => ({ kind: "outcome", outcome })));
      const boundary = Effect.raceFirst(
        abortEffect(input.signal).pipe(Effect.as<LifecycleResult>({ kind: "cancelled" })),
        idle.expired.pipe(Effect.as<LifecycleResult>({ kind: "timeout" })),
      );
      const result = await Effect.runPromise(Effect.raceFirst(execution, boundary));
      if (result.kind === "cancelled") return { kind: "cancelled" };
      if (result.kind === "timeout") {
        return {
          kind: "waiting",
          failure: {
            category: "interrupted",
            message: "Provider turn timed out with an ambiguous outcome.",
          },
        };
      }
      void cleanupTimeoutMs;
      return result.outcome;
    } catch (error) {
      if (input.signal.aborted) return { kind: "cancelled" };
      return failureOutcome(error);
    }
  }

  #execute(
    input: WorkTurnRunInput,
    idle: IdleTimeout,
    meter: WorkTurnMeter,
  ): Effect.Effect<WorkTurnRuntimeOutcome, ProviderFailure, Scope.Scope> {
    const cleanupTimeoutMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
    const shieldReviews = this.#shieldReviews;
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await input.appManagedTools?.close?.();
        }).pipe(Effect.catchAllCause(() => Effect.logWarning("App-managed tool cleanup failed."))),
      );
      let reachedTerminalEvent = false;
      const outsideContentMarks = input.outsideContentMarks ?? NO_RUNTIME_OUTSIDE_CONTENT_MARKS;
      // An earlier turn's read that could not be marked is still in the
      // session this turn would resume.
      if (outsideContentMarks.settleOwed(String(input.command.threadId)).status === "refused") {
        return yield* Effect.fail<ProviderFailure>({
          category: "provider-failed",
          message: RUNTIME_OUTSIDE_CONTENT_REFUSAL,
        });
      }
      let toolSteps: ThreadToolSteps | undefined;
      const recordedOnly = outsideContentRecordedOnly({
        mode: "work",
        executionPolicy: workThreadAccessOf(input.access ?? DEFAULT_WORK_ACCESS).executionPolicy,
      });
      // Octant Shield's answer to an approval shows on the transcript beside
      // the turn's tool rows, whether the runtime asked through its session
      // or the turn's own tools asked out of band.
      const showShieldReview = (review: WorkShieldReview) => {
        toolSteps = recordThreadShieldReview(toolSteps, review);
        input.onToolSteps?.(toolSteps);
      };
      const threadKey = String(input.command.threadId);
      shieldReviews.set(threadKey, showShieldReview);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (shieldReviews.get(threadKey) === showShieldReview) shieldReviews.delete(threadKey);
        }),
      );
      const connection = yield* input.driver.acquire({
        instanceId: input.command.authority.providerInstanceId,
        projectRoot: input.projectRoot,
        ...(input.extraFolders === undefined ? {} : { extraFolders: input.extraFolders }),
        mode: "work",
        workRequest: {
          projectId: input.command.authority.projectId,
          threadId: input.command.threadId,
          sessionId: input.providerSessionId,
          signal: input.signal,
          onApprovalReviewed: showShieldReview,
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!reachedTerminalEvent) {
            yield* boundedCleanup(connection.interrupt(input.providerSessionId), cleanupTimeoutMs);
          }
          yield* boundedCleanup(connection.stop(input.providerSessionId), cleanupTimeoutMs);
        }),
      );
      const options = {
        sessionId: input.providerSessionId,
        ...(input.modelOptionValues === undefined
          ? {}
          : { modelOptionValues: input.modelOptionValues }),
        // The session starts at the thread's level exactly as a Code session
        // at that level does: shell, Git and edits follow it. Every driver
        // still checks the root before it allows an edit, and one without a
        // reviewer of its own keeps asking at Auto.
        ...workThreadAccessOf(input.access ?? DEFAULT_WORK_ACCESS),
        tools: input.appManagedTools?.definitions ?? [],
        ...(input.nativeArtifacts === true ? { nativeArtifacts: true } : {}),
        ...(input.nativeSetup === undefined ? {} : { nativeSetup: input.nativeSetup }),
      };
      const handle = yield* input.resumeCursor === undefined
        ? connection.start({ ...options, modelId: input.command.authority.modelId })
        : connection.resume({
            ...options,
            modelId: input.command.authority.modelId,
            resumeCursor: input.resumeCursor,
          });
      if (input.onSessionReady !== undefined) {
        yield* Effect.try({
          try: () => input.onSessionReady?.(handle),
          catch: () => ({
            category: "provider-failed" as const,
            message: "Work session identity could not be saved.",
          }),
        });
      }

      if (input.signal.aborted) {
        yield* connection
          .interrupt(input.providerSessionId)
          .pipe(Effect.catchAll(() => Effect.void));
        return { kind: "cancelled" };
      }
      let handledEvents = 0;
      let response = "";
      let tasks: ThreadTaskProgressList | undefined;
      // New tasks a full plan turned away, kept until the restatement that
      // follows them can drop the tasks they replace.
      const turnedAwayTasks = new Map<string, ThreadTaskProgress>();
      let terminal: ProviderRuntimeEvent | undefined;
      const pendingRequestHolds = new Map<string, Deferred.Deferred<void>>();
      const pendingRequestCleanups = new Map<string, () => void>();
      const releaseRequestHold = (key: string) => {
        const hold = pendingRequestHolds.get(key);
        if (hold === undefined) return;
        pendingRequestHolds.delete(key);
        pendingRequestCleanups.get(key)?.();
        pendingRequestCleanups.delete(key);
        void Effect.runPromise(Deferred.succeed(hold, undefined));
      };
      const answeredToolRequestIds = new Set<string>();
      const compactions = new TurnCompactions();
      const events = yield* subscribeThenSend({
        connection,
        consume: (runtimeEvents) =>
          runtimeEvents.pipe(
            Stream.filter((event) => event.sessionId === input.providerSessionId),
            Stream.map(makeTurnTextParagraphs()),
            Stream.takeUntil((event) => isTerminalEvent(event) || handledEvents > MAX_EVENTS),
            Stream.tap(() => idle.touch),
            // Liveness only restarts the idle clock above; nothing else sees it.
            Stream.filter((event) => event.kind !== "liveness"),
            Stream.tap((event) => Effect.sync(() => meter.observe(event))),
            Stream.tap((event) => Effect.sync(() => input.observeRemoteCommand?.(event))),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (countsTowardTurnEventBudget(event)) handledEvents += 1;
                // Marked before the budget is looked at: what the runtime
                // read reached its model either way.
                const markToolRow = (
                  toolCallId: string,
                  toolName: string,
                  labels: ReadonlyArray<ShieldWatcherLabel>,
                ) => {
                  const next = markThreadToolStepOutsideContent(toolSteps, {
                    toolCallId,
                    toolName,
                    // At Full access the mark is recorded only: a quiet tag.
                    mark: recordedOnly ? { labels, recordedOnly: true } : { labels },
                  });
                  if (next === undefined || next === toolSteps) return;
                  toolSteps = next;
                  input.onToolSteps?.(next);
                };
                if (event.kind === "outside-content-result") {
                  const watched = outsideContentMarks.watch(String(input.command.threadId), event);
                  if (watched.status === "refused") {
                    return yield* Effect.fail<ProviderFailure>({
                      category: "provider-failed",
                      message: RUNTIME_OUTSIDE_CONTENT_REFUSAL,
                    });
                  }
                  markToolRow(event.toolCallId, event.toolName, watched.labels);
                  return;
                }
                if (event.kind === "outside-content-read") {
                  const marked = outsideContentMarks.mark(String(input.command.threadId), event);
                  if (marked.status === "marked") {
                    markToolRow(event.toolCallId, event.toolName, []);
                    return;
                  }
                  // The scope's finalizer interrupts the session, as for any
                  // turn that ends before its terminal event.
                  return yield* Effect.fail<ProviderFailure>({
                    category: "provider-failed",
                    message: RUNTIME_OUTSIDE_CONTENT_REFUSAL,
                  });
                }
                if (event.kind === "tool-start" && event.argument !== undefined) {
                  input.forgeChanges?.observe({
                    threadId: String(input.command.threadId),
                    command: event.argument,
                    fullAccess:
                      workThreadAccessOf(input.access ?? DEFAULT_WORK_ACCESS).executionPolicy ===
                      "full-access",
                  });
                }
                if (handledEvents > MAX_EVENTS) return;
                if (event.kind === "usage") input.onUsage?.(event);
                const sighting = compactions.observe(event);
                if (sighting !== undefined && input.onAutomaticCompaction !== undefined) {
                  const record = input.onAutomaticCompaction;
                  // The receipt is accounting; failing to write it never
                  // fails the turn whose session it describes.
                  yield* Effect.try(() => record(sighting)).pipe(
                    Effect.catchAll(() =>
                      Effect.logWarning("An automatic compaction could not be journaled."),
                    ),
                  );
                }
                if (event.kind === "child-agent-activity") input.onChildActivity?.(event);
                if (event.kind === "text-delta") {
                  response = appendBoundedResponse(response, event.text);
                  input.onDelta?.(response);
                }
                if (endsHarnessRetryWait(event)) input.onRetryCleared?.();
                if (event.kind === "retrying") input.onRetrying?.(event);
                if (event.kind === "task-progress") {
                  const task: ThreadTaskProgress = {
                    taskId: event.taskId,
                    state: event.status === "in-progress" ? "running" : event.status,
                    summary: event.summary,
                  };
                  const next = upsertThreadTaskProgress(tasks, task);
                  if (next === tasks) {
                    if (turnedAwayTasks.size < MAX_THREAD_TASKS_PER_TURN)
                      turnedAwayTasks.set(task.taskId, task);
                    return;
                  }
                  tasks = next;
                  input.onTasks?.(next);
                }
                if (event.kind === "task-list") {
                  const next = restateThreadTaskList(tasks, event.taskIds, turnedAwayTasks);
                  turnedAwayTasks.clear();
                  if (next === tasks) return;
                  tasks = next;
                  input.onTasks?.(next);
                }
                const nextToolSteps = recordThreadToolStep(toolSteps, event);
                if (nextToolSteps !== toolSteps && nextToolSteps !== undefined) {
                  toolSteps = nextToolSteps;
                  input.onToolSteps?.(nextToolSteps);
                }
                if (event.kind === "tool-request") {
                  if (answeredToolRequestIds.has(event.requestId)) return;
                  answeredToolRequestIds.add(event.requestId);
                  const toolSet = input.appManagedTools;
                  const offered = toolSet?.definitions.some(
                    (definition) => definition.name === event.toolName,
                  );
                  if (toolSet === undefined || offered !== true) {
                    yield* connection
                      .answerTool({
                        sessionId: input.providerSessionId,
                        requestId: event.requestId,
                        resultJson: JSON.stringify({ error: "tool-unavailable" }),
                        isError: true,
                      })
                      .pipe(Effect.catchAll(() => Effect.void));
                    return;
                  }
                  const requestSignal = connection.toolRequestSignal?.({
                    sessionId: input.providerSessionId,
                    requestId: event.requestId,
                  });
                  const executionSignal =
                    requestSignal === undefined
                      ? input.signal
                      : AbortSignal.any([input.signal, requestSignal]);
                  if (executionSignal.aborted) return;
                  const execution = yield* idle.during(
                    Effect.promise(async () => {
                      try {
                        return await toolSet.execute({
                          name: event.toolName,
                          inputJson: event.inputJson,
                          signal: executionSignal,
                        });
                      } catch {
                        return {
                          result: { error: "tool-execution-failed" },
                          images: [],
                          isError: true,
                        } as const;
                      }
                    }),
                  );
                  if (executionSignal.aborted) return;
                  // A refused call carries a mark only when it reached for a
                  // protected secret, which its row then shows.
                  if (execution.outsideContent !== undefined) {
                    markToolRow(event.requestId, event.toolName, execution.outsideContent.labels);
                  }
                  yield* connection
                    .answerTool({
                      sessionId: input.providerSessionId,
                      requestId: event.requestId,
                      resultJson: boundedToolResultJson(execution.result),
                      ...(execution.images === undefined ? {} : { images: execution.images }),
                      isError: execution.isError === true,
                    })
                    .pipe(Effect.catchAll(() => Effect.void));
                  return;
                }
                if (event.kind === "approval-request" || event.kind === "user-input-request") {
                  const providerCallbackId = normalizedProviderCallbackId(event.requestId);
                  if (providerCallbackId === undefined) return;
                  const requestKey = `${String(event.sessionId)}:${providerCallbackId}`;
                  const hold = yield* Deferred.make<void>();
                  pendingRequestHolds.set(requestKey, hold);
                  const cleanup = input.onRequestSettled?.(
                    {
                      providerSessionId: event.sessionId,
                      providerCallbackId,
                    },
                    () => releaseRequestHold(requestKey),
                  );
                  if (cleanup !== undefined) {
                    pendingRequestCleanups.set(requestKey, cleanup);
                  }
                  yield* Effect.forkScoped(idle.during(Deferred.await(hold)));
                  return;
                }
                if (isTerminalEvent(event)) terminal = event;
              }),
            ),
          ),
        send: Effect.sync(() => {
          meter.sent();
          input.onPromptSent?.();
        }).pipe(
          Effect.zipRight(
            connection.send({
              sessionId: input.providerSessionId,
              prompt: input.command.prompt,
              // A runtime that keeps its own conversation already holds the
              // standing context an earlier completed turn of this session
              // carried.
              context: [
                ...(input.driver.conversationOwnership === "provider"
                  ? heldTurnContext.forTurn({
                      sessionId: input.providerSessionId,
                      resumed: input.resumeCursor !== undefined,
                      context: input.context,
                    }).context
                  : (input.context ?? [])),
              ],
              attachments: [...(input.attachments ?? [])],
              tools: [...(input.appManagedTools?.definitions ?? [])],
            }),
          ),
        ),
      });
      yield* Fiber.join(events);
      for (const requestId of pendingRequestHolds.keys()) {
        releaseRequestHold(requestId);
      }

      if (handledEvents > MAX_EVENTS) {
        return {
          kind: "waiting",
          failure: {
            category: "interrupted",
            message: "Provider turn exceeded the bounded event budget.",
          },
        };
      }
      reachedTerminalEvent = terminal !== undefined;
      return outcomeFromEvents(terminal, response);
    });
  }
}

type LifecycleResult =
  | { readonly kind: "outcome"; readonly outcome: WorkTurnRuntimeOutcome }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

function abortEffect(signal: AbortSignal): Effect.Effect<"cancelled"> {
  return Effect.suspend(() => {
    if (signal.aborted) return Effect.succeed("cancelled" as const);
    return Effect.async<"cancelled">((resume) => {
      const onAbort = () => resume(Effect.succeed("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
  });
}

function boundedCleanup<E, R>(
  effect: Effect.Effect<void, E, R>,
  timeoutMs: number,
): Effect.Effect<void, never, R> {
  // Finalizers are uninterruptible. Keep the raced children interruptible so
  // a completed cleanup cancels its timer instead of waiting out the budget.
  return Effect.raceFirst(
    effect.pipe(
      Effect.catchAll(() => Effect.void),
      Effect.interruptible,
    ),
    Effect.sleep(timeoutMs).pipe(Effect.interruptible),
  );
}

function stopReasonOf(outcome: WorkTurnRuntimeOutcome): TurnStopReason {
  switch (outcome.kind) {
    case "completed":
      return outcome.outputLimited === true ? "max-tokens" : "end-of-turn";
    case "cancelled":
      return "cancelled";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
  }
}

/**
 * `waiting` ends the turn here as it already does in Chat and Code. Claude,
 * Codex, and OpenCode send it when their runtime went away under the turn, and
 * nothing follows it; not ending on it left the Work turn running until the
 * idle timeout and then replaced the provider's reason with a generic one.
 */
function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "completed" ||
    event.kind === "interrupted" ||
    event.kind === "failed" ||
    event.kind === "waiting"
  );
}

function outcomeFromEvents(
  terminal: ProviderRuntimeEvent | undefined,
  response: string,
): WorkTurnRuntimeOutcome {
  if (terminal?.kind === "completed") {
    return {
      kind: "completed",
      response,
      ...(terminal.stopReason === "max-tokens" ? { outputLimited: true as const } : {}),
    };
  }
  if (terminal?.kind === "waiting") {
    return {
      kind: "waiting",
      failure: { category: "interrupted", message: truncateMessage(terminal.message) },
    };
  }
  if (terminal?.kind === "interrupted") {
    return {
      kind: "waiting",
      failure: {
        category: "interrupted",
        message: "Provider turn was interrupted.",
      },
    };
  }
  if (terminal?.kind === "failed") {
    const usageLimit = terminal.failure.usageLimit;
    return {
      kind: "failed",
      failure: {
        category: terminal.failure.category === "rate-limited" ? "rate-limited" : "failed",
        message: truncateMessage(terminal.failure.message || "Provider turn failed."),
        ...(usageLimit === undefined ? {} : { usageLimit }),
      },
    };
  }
  return {
    kind: "waiting",
    failure: {
      category: "interrupted",
      message: "Provider turn ended without a terminal receipt.",
    },
  };
}

function failureOutcome(error: unknown): WorkTurnRuntimeOutcome {
  if (isProviderFailure(error)) {
    const category =
      error.category === "interrupted"
        ? "interrupted"
        : error.category === "unauthorized" || error.category === "unauthenticated"
          ? "unauthorized"
          : error.category === "unsupported" || error.category === "incompatible"
            ? "unsupported"
            : error.category === "rate-limited"
              ? "rate-limited"
              : error.category === "provider-failed"
                ? "failed"
                : "unavailable";
    return {
      kind: category === "interrupted" ? "waiting" : "failed",
      failure: {
        category,
        message: truncateMessage(error.message),
        ...(error.usageLimit === undefined ? {} : { usageLimit: error.usageLimit }),
      },
    };
  }
  return {
    kind: "failed",
    failure: {
      category: "unavailable",
      message: truncateMessage(
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Work provider turn is unavailable.",
      ),
    },
  };
}

function isProviderFailure(error: unknown): error is ProviderFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof (error as ProviderFailure).message === "string"
  );
}

function appendBoundedResponse(current: string, delta: string): string {
  const next = current + delta;
  if (textEncoder.encode(next).byteLength <= MAX_WORK_TURN_RESPONSE_BYTES) return next;
  const marker = RESPONSE_TRUNCATION_MARKER;
  const budget = MAX_WORK_TURN_RESPONSE_BYTES - textEncoder.encode(marker).byteLength;
  let truncated = current;
  while (
    textEncoder.encode(truncated + marker).byteLength > MAX_WORK_TURN_RESPONSE_BYTES &&
    truncated.length > 0
  ) {
    truncated = truncated.slice(0, Math.max(0, truncated.length - 16));
  }
  if (textEncoder.encode(truncated).byteLength > budget) {
    truncated = truncated.slice(0, Math.max(0, truncated.length - 32));
  }
  return `${truncated}${marker}`;
}

function truncateMessage(message: string): string {
  const bytes = textEncoder.encode(message);
  if (bytes.byteLength <= 8_192) return message;
  return new TextDecoder().decode(bytes.slice(0, 8_192));
}

/**
 * Prior Work turns on the same thread, as provider context for a follow-up.
 * The current request is omitted so the new prompt is not duplicated.
 */
export function workTurnFollowUpContext(
  turns: ReadonlyArray<WorkTurnState>,
  currentRequestId: WorkTurnRequestId,
): ReadonlyArray<ProviderContextBlock> {
  const blocks: ProviderContextBlock[] = [];
  for (const turn of turns) {
    if (String(turn.requestId) === String(currentRequestId)) continue;
    for (const entry of turn.transcript) {
      if (entry.text.trim() === "") continue;
      blocks.push({
        kind: entry.role === "user" ? "user-message" : "assistant-message",
        text: entry.text,
      });
      if (blocks.length >= MAX_PROVIDER_CONTEXT_BLOCKS) return blocks;
    }
  }
  return blocks;
}
