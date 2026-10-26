import {
  decodeProviderFailure,
  decodeProviderSessionId,
  type CorrelationId,
  type NativeHarnessTranscriptToolCall,
  type NativeHarnessTranscriptToolResult,
  type OctantMode,
  type ProviderContextBlock,
  type ProviderDriverKind,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderResumeCursor,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderToolAnswer,
  type ProviderToolDefinition,
  type ProviderTurnInput,
  type UtcTimestamp,
} from "@octant/contracts";
import type { ProviderConnection, ProviderSessionCompaction } from "@octant/provider-sdk/driver";
import { estimateTurnCostUsd } from "@octant/domain/turn-metrics-display";
import { renderProviderTurnPrompt } from "@octant/provider-sdk/chat-conformance";
import { Effect, PubSub, Stream, type Scope } from "effect";
import { isContextOverflowFailure } from "../providers/contextOverflowRefusal";
import { isEndpointRetriesExhausted } from "../providers/endpointRetry";
import type { ObservedRateLimitBucket } from "../providers/rateLimitHeaders";
import { nativeHarnessToolGuide } from "./nativeHarnessInstructions";
import {
  MemoryNativeHarnessTranscriptStore,
  type NativeHarnessTranscript,
  type NativeHarnessTranscriptCompaction,
  type NativeHarnessTranscriptStore,
} from "./nativeHarnessTranscriptStore";
import type {
  NativeHarnessLeadFallback,
  NativeHarnessLeadFallbackOutcome,
  NativeHarnessLeadTarget,
  NativeHarnessMessage,
  NativeHarnessRequest,
  NativeHarnessResponse,
  NativeHarnessStreamEvent,
  NativeHarnessTransport,
  NativeHarnessTransportSession,
  NativeHarnessUsage,
} from "./nativeHarnessTransport";
import { addNativeHarnessUsage } from "./nativeHarnessTransport";

/**
 * Tools whose call only reads. One the process stopped in the middle of can be
 * called again with no harm; every other tool may already have changed
 * something, so the model is told to check before it repeats one.
 */
const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "web-fetch",
  "web-search",
  "context-remaining",
  "journal-lookup",
]);

const OMITTED_RESULT_JSON = JSON.stringify({
  omitted: true,
  note: "An older tool result was removed to fit the context window. Call the tool again if you still need it.",
});
const NOT_RUN_RESULT_JSON = JSON.stringify({
  notRun: true,
  note: "This call was not run: the turn stopped after repeated malformed tool calls.",
});
const OMITTED_HISTORY_NOTE =
  "Earlier messages of this session were left out to fit the context window.";

/**
 * The note in front of a cut. It names message numbers only when the lead is
 * offered `journal-lookup` and every number it names is already journaled, so
 * the model is never handed a handle it cannot fetch. A Chat thread has no
 * folder, so its note does not point the lead at files it cannot reach.
 */
function omittedHistoryNote(
  mode: OctantMode | undefined,
  journaledBefore: number | undefined,
): string {
  const kept =
    mode === "work" || mode === "code"
      ? `${OMITTED_HISTORY_NOTE} Your task list and the files on disk still reflect that work.`
      : `${OMITTED_HISTORY_NOTE} Your task list still reflects that work.`;
  return journaledBefore === undefined || journaledBefore < 1
    ? kept
    : `${kept} Messages 0 to ${journaledBefore - 1} are kept in the journal: call journal-lookup with one of those numbers as from to re-read them.`;
}

/**
 * The compaction request asks for continuation material, not a reply: what a
 * later request needs to carry on the same work without the turns it replaces.
 */
const COMPACTION_INSTRUCTION = [
  "Summarize the coding session excerpts below so the session can continue",
  "without them. Preserve the task and goal, decisions, the files and",
  "identifiers involved, what was changed, what was verified, and what is",
  "still open. Do not answer anything, do not add commentary, and do not",
  "invent detail that is not present.",
].join(" ");
/**
 * The lead keeps its task list only through `todo-write` calls in the
 * conversation, so a summary that replaced the latest call would leave it
 * without one. The list is carried verbatim after the summary rather than
 * trusting the model to restate it.
 */
const TASK_LIST_LEAD = "Your task list as you last wrote it with todo-write in those turns:";
/** How much of one message's text or one tool payload a compaction request carries. */
const COMPACTION_ITEM_CHARACTERS = 4_000;
/** At most one liveness event per interval while a mid-turn summary streams. */
const SUMMARY_LIVENESS_INTERVAL_MS = 5_000;

/**
 * How many steps in one turn may come back with a malformed tool call before
 * the turn is failed. Each such step costs a round trip; a model that keeps
 * asking for a tool that does not exist, reusing a call id, or sending
 * arguments that are not JSON would otherwise loop forever.
 */
const MAX_SELF_CORRECTION_ROUNDS = 3;

export interface NativeHarnessConnectionOptions {
  readonly instanceId: ProviderInstanceId;
  /** The driver the session's resume cursor names, so only that driver resumes it. */
  readonly driverKind: ProviderDriverKind;
  readonly projectRoot: string;
  readonly mode: OctantMode;
  readonly transport: NativeHarnessTransport;
  readonly transcripts: NativeHarnessTranscriptStore;
  /** The endpoint's verdict on a turn's input; a failure refuses the turn before anything is recorded. */
  readonly admitTurn: (
    input: ProviderTurnInput,
    modelId: ProviderModelId,
  ) => ProviderFailure | undefined;
  /**
   * Where a turn continues when the lead's own model keeps failing. Without
   * it the turn simply fails once the endpoint's retries are spent.
   */
  readonly leadFallback?: NativeHarnessLeadFallback;
  readonly onSessionCountChange?: (delta: 1 | -1) => void;
  readonly onReleased?: () => void;
  readonly clock: () => string;
  readonly correlationId: () => string;
}

interface PendingStep {
  readonly calls: ReadonlyArray<NativeHarnessTranscriptToolCall>;
  readonly answers: Map<string, ProviderToolAnswer>;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  /** The journal aggregate this session appends to; a resumed session keeps its original one. */
  readonly transcriptId: ProviderSessionId;
  /**
   * Where the conversation is kept: the connection's journal, or for a
   * single-use session a store that ends with it, since no thread records a
   * single-use session and a purge could never find its journaled transcript.
   */
  readonly transcripts: NativeHarnessTranscriptStore;
  readonly modelId: ProviderModelId;
  readonly correlationId: CorrelationId;
  readonly endpoint: NativeHarnessTransportSession;
  readonly messages: NativeHarnessMessage[];
  readonly steering: Array<{
    readonly text: string;
    readonly resolve: (outcome: "steered" | "unsupported") => void;
  }>;
  acceptingSteering: boolean;
  system: string | undefined;
  tools: ReadonlyArray<ProviderToolDefinition>;
  pending: PendingStep | undefined;
  /** Every call answered in this turn, so a retried answer after its step moved on is ignored. */
  readonly answered: Set<string>;
  /** The turn in flight, kept so a fallback model can be asked whether it accepts it. */
  turn: ProviderTurnInput | undefined;
  /**
   * The message that opened the turn in flight. A compaction during the turn
   * stops before it: steering notes are turn boundaries too, but the running
   * turn's own prompt and steps are never summarized away under it.
   */
  turnMessage: NativeHarnessMessage | undefined;
  /** The model the lead moved to this turn once its own failed, until the turn ends. */
  fallback:
    | {
        readonly target: NativeHarnessLeadTarget;
        readonly endpoint: NativeHarnessTransportSession;
      }
    | undefined;
  /** Models this turn already ran on and gave up on. */
  attempted: NativeHarnessLeadTarget[];
  nextSequence: number;
  inFlight: Promise<void> | undefined;
  abortController: AbortController | undefined;
  stopped: boolean;
  steps: number;
  /** Steps this turn whose tool calls arrived malformed; a model that will not correct itself is cut off. */
  selfCorrections: number;
  /** Whether this turn sent a request to summarize earlier turns; what it cost is in `usage`. */
  compactedThisTurn: boolean;
  /** Everything this turn's requests have cost so far; a figure no request reported stays absent. */
  usage: NativeHarnessUsage;
  latestReportedUsage: NativeHarnessUsage | undefined;
  estimatedCostUsd: number | null;
  pricingBoundariesKnown: boolean;
  requestEstimateUsd: number | null | undefined;
  /** When the request now in flight was sent, which dates the usage it reports. */
  requestStartedAt: string | undefined;
  /**
   * The compaction the conversation carries, if any: `messages` then begins
   * with its summary, which stands for the transcript's first `turns` turns
   * and is not a turn of its own.
   */
  compaction: NativeHarnessTranscriptCompaction | undefined;
  /**
   * The journal's number for the first message of `messages` it holds (the
   * one after a compaction summary), so a cut note can name the numbers
   * `journal-lookup` reads back.
   */
  journalOffset: number;
}

/**
 * The native harness's agent loop over one direct endpoint.
 *
 * The loop owns the conversation. Every step is journaled as it happens: the
 * user message once the request is known to fit, each assistant reply, and
 * each tool call the moment it settles. A session therefore survives the
 * process: `resume` rebuilds it from the journal, and a call that was asked
 * for but never settled is closed with an honest interrupted result instead
 * of being silently replayed.
 *
 * Tool execution stays with the server. A step's calls go out as
 * `tool-request` events; the turn runner executes each through its tool set
 * (and so through the authority service) and answers with `answerTool`. Once
 * every call of the step is answered the results return in one message, in
 * the order the model asked for them, and the next request starts.
 */
export function createNativeHarnessConnection(
  options: NativeHarnessConnectionOptions,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<string, SessionState>();
    let closed = false;
    const offer = (event: ProviderRuntimeEvent) => {
      Effect.runFork(PubSub.publish(events, event));
    };
    const emit = (state: SessionState, body: Record<string, unknown>) =>
      offer({
        ...body,
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        sequence: state.nextSequence++,
        correlationId: state.correlationId,
        occurredAt: options.clock() as UtcTimestamp,
      } as ProviderRuntimeEvent);
    const cursorFor = (state: SessionState): ProviderResumeCursor => ({
      driverKind: options.driverKind,
      value: String(state.transcriptId),
    });

    // Frees the live session only; its conversation stays in the journal for a resume.
    const release = (state: SessionState) => {
      if (state.stopped) return;
      state.stopped = true;
      state.acceptingSteering = false;
      for (const note of state.steering.splice(0)) note.resolve("unsupported");
      state.fallback?.endpoint.release();
      state.fallback = undefined;
      state.turn = undefined;
      state.messages.length = 0;
      state.pending = undefined;
      state.abortController = undefined;
      state.inFlight = undefined;
      state.endpoint.release();
      if (sessions.get(String(state.sessionId)) === state) {
        sessions.delete(String(state.sessionId));
        options.onSessionCountChange?.(-1);
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true;
        for (const state of sessions.values()) state.abortController?.abort();
        await Promise.allSettled(
          [...sessions.values()].flatMap((state) =>
            state.inFlight === undefined ? [] : [state.inFlight],
          ),
        );
        for (const state of sessions.values()) release(state);
        await Effect.runPromise(PubSub.shutdown(events));
        options.onReleased?.();
      }),
    );

    const stateFor = (sessionId: ProviderSessionId): SessionState => {
      const state = sessions.get(String(sessionId));
      if (state === undefined) throw failure("protocol", "Provider session is not active.");
      return state;
    };

    const admit = (state: SessionState) => {
      sessions.set(String(state.sessionId), state);
      options.onSessionCountChange?.(1);
    };

    const newState = (input: {
      readonly sessionId: ProviderSessionId;
      readonly transcriptId: ProviderSessionId;
      readonly transcripts: NativeHarnessTranscriptStore;
      readonly modelId: ProviderModelId;
      readonly endpoint: NativeHarnessTransportSession;
      readonly messages: NativeHarnessMessage[];
      readonly tools?: ReadonlyArray<ProviderToolDefinition> | undefined;
      readonly compaction?: NativeHarnessTranscriptCompaction | undefined;
      readonly journalOffset?: number;
    }): SessionState => ({
      sessionId: input.sessionId,
      transcriptId: input.transcriptId,
      transcripts: input.transcripts,
      modelId: input.modelId,
      correlationId: options.correlationId() as CorrelationId,
      endpoint: input.endpoint,
      messages: input.messages,
      steering: [],
      acceptingSteering: false,
      system: undefined,
      tools: input.tools ?? [],
      pending: undefined,
      answered: new Set(),
      turn: undefined,
      turnMessage: undefined,
      fallback: undefined,
      attempted: [],
      nextSequence: 1,
      inFlight: undefined,
      abortController: undefined,
      stopped: false,
      steps: 0,
      selfCorrections: 0,
      compactedThisTurn: false,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latestReportedUsage: undefined,
      estimatedCostUsd: 0,
      pricingBoundariesKnown: true,
      requestEstimateUsd: undefined,
      requestStartedAt: undefined,
      compaction: input.compaction,
      journalOffset: input.journalOffset ?? 0,
    });

    /**
     * The journal's number for a message of the session's conversation. One
     * not journaled yet (the message a send or a steering note is adding) is
     * numbered as the next, which every message before it precedes.
     */
    const journalNumberIn =
      (state: SessionState) =>
      (message: NativeHarnessMessage): number | undefined => {
        const summary = state.compaction === undefined ? 0 : 1;
        const index = state.messages.indexOf(message);
        if (index >= 0 && index < summary) return undefined;
        return state.journalOffset - summary + (index < 0 ? state.messages.length : index);
      };

    // A note is acknowledged only after it is durable and its next request
    // fits. Inserting it between a tool call and its results would break the
    // provider's conversation, so it waits for that step's complete boundary.
    const takeSteeringRequest = (state: SessionState): NativeHarnessRequest | undefined => {
      const notes = state.steering.splice(0);
      if (notes.length === 0) return undefined;
      const messages: NativeHarnessMessage[] = notes.map((note) => ({
        role: "user",
        text: note.text,
      }));
      const request = requestFor(state, [...state.messages, ...messages]);
      if (request === undefined) {
        for (const note of notes) note.resolve("unsupported");
        return undefined;
      }
      // Fitting can omit earlier queued notes. Object identity also keeps
      // distinct notes with identical text from acknowledging one another.
      const retained = notes.flatMap((note, index) => {
        const message = messages[index];
        if (message === undefined || !request.history.includes(message)) {
          note.resolve("unsupported");
          return [];
        }
        return [{ note, message }];
      });
      try {
        for (const { message } of retained) {
          state.transcripts.append(state.transcriptId, message);
          state.messages.push(message);
        }
      } catch (error) {
        for (const { note } of retained) note.resolve("unsupported");
        throw error;
      }
      for (const { note } of retained) note.resolve("steered");
      return request;
    };

    /** Runs one request and settles what it returned; never rejects. */
    const runStep = (state: SessionState, request: NativeHarnessRequest): Promise<void> => {
      const controller = new AbortController();
      state.abortController = controller;
      state.steps += 1;
      state.requestEstimateUsd = undefined;
      const step = sendOnLead(state, request, controller.signal)
        .then((response) => settleResponse(state, response))
        .catch((error: unknown) => {
          if (state.latestReportedUsage !== undefined) {
            // Replace the partial request reports so an unfinished retry cannot
            // leave a whole-turn estimate, without adding the known tokens twice.
            const estimatedCostUsd =
              state.pricingBoundariesKnown &&
              state.estimatedCostUsd !== null &&
              typeof state.requestEstimateUsd === "number"
                ? state.estimatedCostUsd + state.requestEstimateUsd
                : null;
            emit(state, { kind: "usage", ...state.latestReportedUsage, estimatedCostUsd });
          }
          state.pending = undefined;
          state.acceptingSteering = false;
          for (const note of state.steering.splice(0)) note.resolve("unsupported");
          const failed = controller.signal.aborted
            ? failure("interrupted", "The provider request was cancelled.")
            : sanitizeFailure(error);
          emit(
            state,
            failed.category === "interrupted"
              ? { kind: "interrupted", message: "The provider request was cancelled." }
              : { kind: "failed", failure: failed },
          );
        })
        .finally(() => {
          // A step waiting on tool answers keeps the turn in flight so
          // interrupt and stop still reach it during the tool phase.
          if (state.pending !== undefined || state.inFlight !== step) return;
          state.inFlight = undefined;
          state.abortController = undefined;
        });
      state.inFlight = step;
      return step;
    };

    const leadTarget = (state: SessionState): NativeHarnessLeadTarget =>
      state.fallback?.target ?? { providerInstanceId: options.instanceId, modelId: state.modelId };

    /**
     * Sends a request on the lead's model, and on its fallback when the
     * endpoint's own retries ran out without anything streaming. Each model
     * is asked at most once per turn; once the router has nothing left the
     * turn fails with the endpoint's own failure and the reason none was found.
     */
    const sendOnLead = async (
      state: SessionState,
      request: NativeHarnessRequest,
      signal: AbortSignal,
    ): Promise<NativeHarnessResponse> => {
      const stream = {
        signal,
        // A request's own usage says when that request was sent, which is what
        // lets its timing leave out the tool time between requests.
        onEvent: (event: NativeHarnessStreamEvent) => {
          if (event.kind === "retrying") state.pricingBoundariesKnown = false;
          if (event.kind === "usage") {
            state.latestReportedUsage = addNativeHarnessUsage(state.usage, event);
            state.requestEstimateUsd = state.pricingBoundariesKnown
              ? (estimateTurnCostUsd(String(leadTarget(state).modelId), event) ?? null)
              : null;
          }
          emit(
            state,
            event.kind === "usage"
              ? {
                  ...event,
                  ...(state.requestStartedAt === undefined
                    ? {}
                    : { requestStartedAt: state.requestStartedAt }),
                  estimatedCostUsd: state.requestEstimateUsd,
                }
              : { ...event },
          );
        },
      };
      let current = request;
      if (state.fallback !== undefined) {
        const refit = fitRequest(
          state.fallback.endpoint,
          { ...request, modelId: state.fallback.target.modelId },
          { journalNumberOf: journalNumberIn(state), mode: options.mode },
        );
        if (refit === undefined) {
          throw failure(
            "invalid-configuration",
            "The provider request exceeded the configured size limit.",
          );
        }
        current = refit;
      }
      // Summarizing earlier turns is tried at most once per request, before
      // anything is cut: when fitting already left whole exchanges out, and
      // when the endpoint refuses the request as too large.
      let compactionTried = false;
      if (leftOutHistory(current)) {
        compactionTried = true;
        current = (await compactToFit(state, signal)) ?? current;
      }
      // The endpoint accepted the request's size estimate yet still refused it
      // as too large. A summary of earlier turns goes first; failing that, or
      // if the summarized request is refused too, one ladder step is forced
      // and the request sent once more before the failure is allowed to stand.
      let recoveredFromOverflow = false;
      for (;;) {
        try {
          state.requestStartedAt = options.clock();
          return await (state.fallback?.endpoint ?? state.endpoint).send(current, stream);
        } catch (error) {
          if (!signal.aborted && isContextOverflowFailure(sanitizeFailure(error))) {
            const compacted = compactionTried ? undefined : await compactToFit(state, signal);
            compactionTried = true;
            if (compacted !== undefined) {
              state.pricingBoundariesKnown = false;
              current = compacted;
              continue;
            }
            const refit = recoveredFromOverflow
              ? undefined
              : fitRequest(state.fallback?.endpoint ?? state.endpoint, current, {
                  reduceOnce: true,
                  journalNumberOf: journalNumberIn(state),
                  mode: options.mode,
                });
            if (refit !== undefined) {
              state.pricingBoundariesKnown = false;
              recoveredFromOverflow = true;
              current = refit;
              continue;
            }
          }
          if (
            options.leadFallback === undefined ||
            state.turn === undefined ||
            signal.aborted ||
            !isEndpointRetriesExhausted(error)
          ) {
            throw error;
          }
          const failed = leadTarget(state);
          state.attempted.push(failed);
          const spent = sanitizeFailure(error);
          // A router that cannot answer leaves the endpoint's own failure standing.
          const outcome: NativeHarnessLeadFallbackOutcome = await options.leadFallback
            .next({
              failed,
              attempted: [...state.attempted],
              failure: spent,
              turn: state.turn,
            })
            .catch(() => ({ status: "none", reason: "not-routed" }) as const);
          if (outcome.status === "none") throw withoutFallback(spent, outcome.reason);
          if (signal.aborted || state.stopped) {
            outcome.endpoint.release();
            throw error;
          }
          const moved = fitRequest(
            outcome.endpoint,
            { ...current, modelId: outcome.target.modelId },
            { journalNumberOf: journalNumberIn(state), mode: options.mode },
          );
          if (moved === undefined) {
            outcome.endpoint.release();
            throw failure(
              "invalid-configuration",
              "The provider request exceeded the configured size limit.",
            );
          }
          state.fallback?.endpoint.release();
          state.pricingBoundariesKnown = false;
          state.fallback = { target: outcome.target, endpoint: outcome.endpoint };
          current = moved;
        }
      }
    };

    /**
     * Sends a settled step's results back as the next request. A steering note
     * queued during the step is offered first, so a person's redirect is
     * answered before the model continues on its own plan; when nothing fits,
     * or the latest message alone does not, the turn fails honestly.
     */
    const advanceAfterResults = (state: SessionState): void => {
      const pending = state.pending;
      if (pending === undefined) return;
      const results: NativeHarnessMessage = {
        role: "assistant",
        text: "",
        toolResults: pending.calls.flatMap((call) => {
          const answer = pending.answers.get(call.toolCallId);
          return answer === undefined
            ? []
            : [
                {
                  toolCallId: answer.requestId,
                  resultJson: answer.resultJson,
                  isError: answer.isError,
                  ...(answer.images === undefined ? {} : { images: answer.images }),
                },
              ];
        }),
      };
      state.messages.push(results);
      state.pending = undefined;
      const request = takeSteeringRequest(state) ?? requestFor(state, [...state.messages]);
      if (request === undefined) {
        emit(state, {
          kind: "failed",
          failure: failure(
            "invalid-configuration",
            "The provider request exceeded the configured size limit.",
          ),
        });
        state.inFlight = undefined;
        state.abortController = undefined;
        state.acceptingSteering = false;
        return;
      }
      void runStep(state, request);
    };

    /**
     * Closes the tool step a cancel caught so the conversation stays valid for
     * the next send: every call the runner never answered gets the same
     * interrupted result a resume would have journaled, and the results message
     * joins the conversation.
     */
    const closePendingStep = (state: SessionState): void => {
      const pending = state.pending;
      if (pending === undefined) return;
      const unanswered = pending.calls.filter((call) => !pending.answers.has(call.toolCallId));
      for (const result of interruptedResults(unanswered)) {
        state.transcripts.settle(state.transcriptId, result);
        pending.answers.set(result.toolCallId, {
          sessionId: state.sessionId,
          requestId: result.toolCallId,
          resultJson: result.resultJson,
          isError: true,
        });
      }
      state.messages.push({
        role: "assistant",
        text: "",
        toolResults: pending.calls.flatMap((call) => {
          const answer = pending.answers.get(call.toolCallId);
          return answer === undefined
            ? []
            : [
                {
                  toolCallId: answer.requestId,
                  resultJson: answer.resultJson,
                  isError: answer.isError,
                },
              ];
        }),
      });
      state.pending = undefined;
    };

    /**
     * Ends the running turn without ending the session. The conversation the
     * journal already holds stays live, so a cancel is followed by a plain send
     * that continues it rather than a rebuild from the journal.
     */
    const settleTurnWithoutStopping = (state: SessionState) => {
      state.acceptingSteering = false;
      for (const note of state.steering.splice(0)) note.resolve("unsupported");
      state.fallback?.endpoint.release();
      state.fallback = undefined;
      state.turn = undefined;
      state.pending = undefined;
      state.abortController = undefined;
      state.inFlight = undefined;
    };

    /** Adds one settled request of this turn to the turn's usage and estimated cost. */
    const chargeRequest = (state: SessionState, usage: NativeHarnessUsage | undefined) => {
      const requestCost =
        usage === undefined || !state.pricingBoundariesKnown
          ? undefined
          : estimateTurnCostUsd(String(leadTarget(state).modelId), usage);
      state.estimatedCostUsd =
        state.estimatedCostUsd === null || requestCost === undefined
          ? null
          : state.estimatedCostUsd + requestCost;
      if (usage !== undefined) {
        state.usage = addNativeHarnessUsage(state.usage, usage);
        state.latestReportedUsage = state.usage;
      } else if (state.usage.costUsd !== undefined) {
        // A request that reported nothing may still have been charged, so the
        // turn no longer has a whole cost.
        const { costUsd: _unknown, ...withoutCost } = state.usage;
        state.usage = withoutCost;
        if (state.latestReportedUsage !== undefined) state.latestReportedUsage = state.usage;
      }
    };

    const settleResponse = (state: SessionState, response: NativeHarnessResponse) => {
      // Header buckets describe the account after this response; they go
      // first so a consumer that stops at the terminal still sees them.
      for (const bucket of response.rateLimitBuckets ?? []) emitBucket(state, bucket);
      // This request is now included in the settled total even if journaling fails below.
      chargeRequest(state, response.usage);
      state.requestEstimateUsd = 0;
      if (response.toolCalls.length > 0) {
        const calls = response.toolCalls;
        // The model's own call is journaled either way: a malformed call is
        // answered with what was wrong so the model can correct itself, and it
        // must be able to read the call it is correcting.
        const message: NativeHarnessMessage = {
          role: "assistant",
          text: response.text,
          toolCalls: calls,
        };
        state.transcripts.append(state.transcriptId, message);
        state.messages.push(message);
        const answers = new Map<string, ProviderToolAnswer>();
        const malformed = new Set<string>();
        const idCounts = new Map<string, number>();
        for (const call of calls) {
          idCounts.set(call.toolCallId, (idCounts.get(call.toolCallId) ?? 0) + 1);
        }
        for (const call of calls) {
          const problem = toolCallProblem(state.tools, call, idCounts);
          if (problem === undefined) continue;
          malformed.add(call.toolCallId);
          answers.set(call.toolCallId, {
            sessionId: state.sessionId,
            requestId: call.toolCallId,
            resultJson: problem,
            isError: true,
          });
          state.transcripts.settle(state.transcriptId, {
            toolCallId: call.toolCallId,
            resultJson: problem,
            isError: true,
          });
        }
        state.pending = { calls, answers };
        if (malformed.size > 0) {
          state.selfCorrections += 1;
          if (state.selfCorrections > MAX_SELF_CORRECTION_ROUNDS) {
            // The well-formed calls of this step will never run. Each gets a
            // result that says so and the step is closed, so the journal and
            // the next send do not carry calls without results.
            for (const call of calls) {
              if (malformed.has(call.toolCallId)) continue;
              state.transcripts.settle(state.transcriptId, {
                toolCallId: call.toolCallId,
                resultJson: NOT_RUN_RESULT_JSON,
                isError: true,
              });
              answers.set(call.toolCallId, {
                sessionId: state.sessionId,
                requestId: call.toolCallId,
                resultJson: NOT_RUN_RESULT_JSON,
                isError: true,
              });
            }
            closePendingStep(state);
            // This branch returns normally, so the step's catch does not run.
            // A note queued during the step would otherwise stay pending.
            state.acceptingSteering = false;
            for (const note of state.steering.splice(0)) note.resolve("unsupported");
            emit(state, {
              kind: "failed",
              failure: failure(
                "protocol",
                "The provider repeatedly returned tool calls the harness could not run.",
              ),
            });
            return;
          }
        }
        for (const call of calls) {
          if (malformed.has(call.toolCallId)) continue;
          emit(state, {
            kind: "tool-request",
            requestId: call.toolCallId,
            toolName: call.toolName,
            inputJson: call.argumentsJson,
          });
        }
        // A step with nothing left for the runner to do continues at once,
        // carrying the error results back to the model.
        if (calls.every((call) => malformed.has(call.toolCallId))) advanceAfterResults(state);
        return;
      }
      const message: NativeHarnessMessage = { role: "assistant", text: response.text };
      state.transcripts.append(state.transcriptId, message);
      state.messages.push(message);
      const steered = takeSteeringRequest(state);
      if (steered !== undefined) {
        void runStep(state, steered);
        return;
      }
      // A turn that took several requests (a summary request counts) reports
      // its whole cost once more before it ends; consumers keep the latest
      // usage they saw.
      if (
        (state.steps > 1 || state.compactedThisTurn) &&
        (state.usage.inputTokens > 0 || state.usage.outputTokens > 0)
      ) {
        emit(state, { kind: "usage", ...state.usage, estimatedCostUsd: state.estimatedCostUsd });
      }
      state.acceptingSteering = false;
      emit(state, {
        kind: "completed",
        resumeCursor: cursorFor(state),
        ...(response.outputStopReason === undefined
          ? {}
          : { stopReason: response.outputStopReason }),
      });
    };

    const emitBucket = (state: SessionState, bucket: ObservedRateLimitBucket) =>
      emit(state, { kind: "rate-limit-bucket", ...bucket });

    /**
     * Summarizes the turns before the latest with the session's own endpoint
     * and journals the summary in their place. As many of the oldest turns are
     * summarized as fit one request; the rest stay as they were. Nothing is
     * journaled unless the summary came back, so a failure leaves the session
     * exactly as it was. The summary request's own usage is handed back so a
     * turn that compacted part-way can count what it cost.
     */
    const summarizeEarlierTurns = async (
      state: SessionState,
      signal: AbortSignal,
      /** The running turn's opening message; only turns before it are summarized. */
      keepFrom?: NativeHarnessMessage,
    ): Promise<{
      readonly result: ProviderSessionCompaction;
      /**
       * Present once the summary request went out, with the usage it reported
       * and whether the endpoint retried it, which leaves one request's price
       * tiers unknown for that usage.
       */
      readonly sent?: { readonly usage: NativeHarnessUsage | undefined; readonly retried: boolean };
    }> => {
      const body = state.compaction === undefined ? state.messages : state.messages.slice(1);
      const starts = turnStarts(body);
      if (body.length === 0 && state.compaction === undefined) {
        return { result: { kind: "refused", reason: "no-session" } };
      }
      const latest =
        keepFrom === undefined
          ? starts.length - 1
          : starts.findIndex((start) => body[start] === keepFrom);
      if (latest < 1) return { result: { kind: "refused", reason: "nothing-to-compact" } };
      let chosen: { readonly turns: number; readonly request: NativeHarnessRequest } | undefined;
      for (let turns = latest; turns >= 1 && chosen === undefined; turns -= 1) {
        const request: NativeHarnessRequest = {
          sessionId: state.sessionId,
          modelId: state.modelId,
          system: COMPACTION_INSTRUCTION,
          history: [
            {
              role: "user",
              text: compactionMaterial(state.compaction, body.slice(0, starts[turns])),
            },
          ],
          tools: [],
        };
        if (state.endpoint.fits(request)) chosen = { turns, request };
      }
      const unchanged = (message: string) =>
        ({ kind: "failed", message, sessionMayHaveChanged: false }) as const;
      if (chosen === undefined) {
        return { result: unchanged("Not even the oldest turn fits one compaction request.") };
      }
      let response: NativeHarnessResponse;
      let retried = false;
      let livenessAt: number | undefined;
      try {
        // The summary is not a reply: none of its text or reasoning reaches the
        // session's events. Mid-turn, though, the turn runner interrupts a turn
        // that goes quiet for its inactivity window, and a summary over a long
        // session can stream for longer than that, so its activity is forwarded
        // as content-free liveness, at most once per interval like an adapter's.
        response = await state.endpoint.send(chosen.request, {
          signal,
          onEvent: (event) => {
            if (event.kind === "retrying") retried = true;
            if (keepFrom === undefined) return;
            const now = Date.parse(options.clock());
            if (livenessAt !== undefined && now - livenessAt < SUMMARY_LIVENESS_INTERVAL_MS) {
              return;
            }
            livenessAt = now;
            emit(state, { kind: "liveness" });
          },
        });
      } catch {
        return {
          result: unchanged(
            signal.aborted
              ? "The compaction request was cancelled."
              : "The endpoint could not summarize the session.",
          ),
          // A failed request may still have been charged.
          sent: { usage: undefined, retried },
        };
      }
      const usage = response.usage;
      const summarized = response.text.trim();
      if (summarized.length === 0 || state.stopped || signal.aborted) {
        return { result: unchanged("The endpoint returned no summary."), sent: { usage, retried } };
      }
      const replaced = body.slice(0, starts[chosen.turns]);
      const taskList = carriedTaskList(state.compaction, replaced);
      const hidden = state.compaction?.turns ?? 0;
      const compaction = {
        summary:
          taskList === undefined ? summarized : `${summarized}\n\n${TASK_LIST_LEAD}\n${taskList}`,
        turns: hidden + chosen.turns,
        // The turns run before the first one that reads the summary: every
        // visible turn for a requested compaction, which the next turn reads,
        // but not the running turn when it compacts mid-turn, since that turn
        // reads the summary itself. A fork through the running turn then
        // carries the summary that turn actually read.
        afterTurns: hidden + (keepFrom === undefined ? starts.length : latest),
      };
      try {
        state.transcripts.compact(state.transcriptId, compaction);
      } catch {
        // The marker never reached the journal, so the session still reads
        // the turns it would have replaced.
        return {
          result: unchanged("The compaction could not be recorded."),
          sent: { usage, retried },
        };
      }
      const kept = starts[chosen.turns] ?? 0;
      state.messages.splice(
        0,
        state.messages.length,
        compactionSummaryMessage(compaction),
        ...body.slice(kept),
      );
      // Every message the summary replaced was journaled before it, so the
      // journal's numbering moves on by exactly that many, whether a person
      // asked for the compaction or the running turn needed the room.
      state.journalOffset += kept;
      state.compaction = compaction;
      return { result: { kind: "compacted" }, sent: { usage, retried } };
    };

    const compactSession = async (state: SessionState): Promise<ProviderSessionCompaction> => {
      if (state.stopped) throw failure("protocol", "Provider session is not active.");
      if (state.inFlight !== undefined) return { kind: "refused", reason: "turn-running" };
      const controller = new AbortController();
      state.abortController = controller;
      const run = summarizeEarlierTurns(state, controller.signal).then(({ result }) => {
        if (result.kind === "compacted") {
          emit(state, { kind: "context-compacted", trigger: "requested" });
        }
        return result;
      });
      const settled = run.then(() => undefined);
      state.inFlight = settled;
      try {
        return await run;
      } finally {
        if (state.inFlight === settled) {
          state.inFlight = undefined;
          state.abortController = undefined;
        }
      }
    };

    /**
     * The turn's request rebuilt after summarizing earlier turns in place,
     * or undefined when nothing was summarized. A Code session only, whose
     * transcript the harness keeps (Chat and Work send the host's planned
     * history), and only on the lead's own model: the summary is sized for
     * its window, and a fallback model's window may differ. The compaction is
     * the runtime's own as far as the turn runner can tell, so it is reported
     * `automatic` and marks the turn's usage compacted.
     */
    const compactToFit = async (
      state: SessionState,
      signal: AbortSignal,
    ): Promise<NativeHarnessRequest | undefined> => {
      if (options.mode !== "code" || state.fallback !== undefined) return undefined;
      // One summary request per turn: after a success nothing before the
      // running turn is left to summarize, and after a failure every later
      // step would pay for the same large request again only to fall back to
      // the ladder anyway.
      if (state.turnMessage === undefined || state.compactedThisTurn) return undefined;
      const { result, sent } = await summarizeEarlierTurns(state, signal, state.turnMessage);
      if (sent !== undefined) {
        // The summary request went out whether or not it came back; the turn pays for it.
        state.compactedThisTurn = true;
        if (sent.retried) state.pricingBoundariesKnown = false;
        chargeRequest(state, sent.usage);
      }
      if (result.kind !== "compacted") return undefined;
      emit(state, { kind: "context-compacted", trigger: "automatic" });
      return requestFor(state, [...state.messages]);
    };

    const refuseCancelledOpening = (
      signal: AbortSignal,
      endpoint?: NativeHarnessTransportSession,
    ) => {
      // Transport opening can finish after Effect interruption or scope cleanup.
      // A late endpoint must never resurrect the session or write its transcript.
      if (closed || signal.aborted) {
        endpoint?.release();
        throw failure("interrupted", "Provider session opening was cancelled.");
      }
    };

    const requestFor = (state: SessionState, history: ReadonlyArray<NativeHarnessMessage>) =>
      fitRequest(
        state.endpoint,
        {
          sessionId: state.sessionId,
          modelId: state.modelId,
          system: state.system,
          history,
          tools: sortToolDefinitionsByName(state.tools),
        },
        { journalNumberOf: journalNumberIn(state), mode: options.mode },
      );

    return {
      subscribe: Stream.fromPubSub(events, { scoped: true }),
      start: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (sessions.has(String(input.sessionId))) {
              throw failure("protocol", "Provider session is already active.");
            }
            refuseCancelledOpening(signal);
            const endpoint = await options.transport.open(input.modelId);
            refuseCancelledOpening(signal, endpoint);
            const transcripts =
              input.singleUse === true
                ? new MemoryNativeHarnessTranscriptStore()
                : options.transcripts;
            try {
              transcripts.open(input.sessionId, {
                instanceId: options.instanceId,
                modelId: input.modelId,
                projectRoot: options.projectRoot,
                mode: options.mode,
              });
            } catch (error) {
              endpoint.release();
              throw error;
            }
            const state = newState({
              sessionId: input.sessionId,
              transcriptId: input.sessionId,
              transcripts,
              modelId: input.modelId,
              endpoint,
              messages: [],
              tools: input.tools,
            });
            admit(state);
            return input.singleUse === true
              ? { sessionId: input.sessionId }
              : { sessionId: input.sessionId, resumeCursor: cursorFor(state) };
          },
          catch: sanitizeFailure,
        }),
      resume: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (input.resumeCursor.driverKind !== options.driverKind) {
              throw failure(
                "stale-resume",
                "The harness session belongs to another endpoint kind.",
              );
            }
            const transcriptId = transcriptIdOf(input.resumeCursor);
            const transcript =
              transcriptId === undefined ? undefined : options.transcripts.load(transcriptId);
            if (
              transcriptId === undefined ||
              transcript === undefined ||
              String(transcript.binding.instanceId) !== String(options.instanceId) ||
              transcript.binding.projectRoot !== options.projectRoot ||
              transcript.binding.mode !== options.mode
            ) {
              throw failure(
                "stale-resume",
                "The harness session does not belong to this endpoint, folder, and mode.",
              );
            }
            if (sessions.has(String(input.sessionId))) {
              throw failure("protocol", "Provider session is already active.");
            }
            refuseCancelledOpening(signal);
            const endpoint = await options.transport.open(transcript.binding.modelId);
            refuseCancelledOpening(signal, endpoint);
            // A call the process stopped in the middle of is closed before
            // anything else: the model must read what happened to it, and a
            // results message must follow its call for the request to be valid.
            let messages: NativeHarnessMessage[];
            try {
              messages = closeOpenStep(transcriptId, transcript, options.transcripts);
            } catch (error) {
              endpoint.release();
              throw error;
            }
            const compacted = afterCompaction(messages, transcript.compactions.at(-1));
            const state = newState({
              sessionId: input.sessionId,
              transcriptId,
              transcripts: options.transcripts,
              modelId: transcript.binding.modelId,
              endpoint,
              messages: compacted.messages,
              tools: input.tools,
              compaction: compacted.compaction,
              journalOffset: compacted.journalOffset,
            });
            admit(state);
            return { sessionId: input.sessionId, resumeCursor: cursorFor(state) };
          },
          catch: sanitizeFailure,
        }),
      send: (input) =>
        Effect.tryPromise({
          try: async () => {
            const state = stateFor(input.sessionId);
            if (state.stopped) throw failure("protocol", "Provider session is not active.");
            if (state.inFlight !== undefined) {
              throw failure("protocol", "Provider session already has an in-flight turn.");
            }
            const rejected = options.admitTurn(input, state.modelId);
            if (rejected !== undefined) throw rejected;
            const { system, rest } = splitInstructions(input.context);
            state.system = composeSystem(system, input.tools);
            state.tools = input.tools;
            const user: NativeHarnessMessage = {
              role: "user",
              text: renderProviderTurnPrompt({ prompt: input.prompt, context: rest }),
            };
            const live: NativeHarnessMessage =
              input.attachments.length === 0 ? user : { ...user, attachments: input.attachments };
            // An earlier turn's attachments were sent with that turn only.
            const earlier = state.messages.map(({ attachments: _sent, ...message }) => message);
            // Nothing is recorded for a request that cannot be sent: the user
            // message joins the conversation only once it provably fits.
            const request = requestFor(state, [...earlier, live]);
            if (request === undefined) {
              throw failure(
                "invalid-configuration",
                "The provider request exceeded the configured size limit.",
              );
            }
            state.transcripts.append(state.transcriptId, user);
            state.messages.splice(0, state.messages.length, ...earlier, live);
            state.pending = undefined;
            state.answered.clear();
            // Each turn starts on the lead's own model again.
            state.fallback?.endpoint.release();
            state.fallback = undefined;
            state.attempted = [];
            state.turn = input;
            state.turnMessage = user;
            state.steps = 0;
            state.selfCorrections = 0;
            state.compactedThisTurn = false;
            state.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
            state.latestReportedUsage = undefined;
            state.estimatedCostUsd = 0;
            state.pricingBoundariesKnown = true;
            state.acceptingSteering = true;
            void runStep(state, request);
          },
          catch: sanitizeFailure,
        }),
      steer: ({ sessionId, message }) =>
        Effect.promise(async () => {
          const state = sessions.get(String(sessionId));
          if (
            state === undefined ||
            state.stopped ||
            !state.acceptingSteering ||
            state.abortController?.signal.aborted ||
            state.steering.length >= 16 ||
            message.trim().length === 0 ||
            message.length > 4096
          )
            return "unsupported" as const;
          return await new Promise<"steered" | "unsupported">((resolve) =>
            state.steering.push({ text: message, resolve }),
          );
        }),
      ...(options.mode === "code"
        ? {
            compact: ({ sessionId }) =>
              Effect.tryPromise({
                try: () => compactSession(stateFor(sessionId)),
                catch: sanitizeFailure,
              }),
          }
        : {}),
      interrupt: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const state = stateFor(sessionId);
            if (state.inFlight === undefined || state.abortController === undefined) {
              throw failure("protocol", "Provider session has no in-flight turn.");
            }
            state.abortController.abort();
            await state.inFlight;
            // During the tool phase the request already settled, so nothing
            // else reports the cancellation; the calls the runner never
            // answered are closed here so the conversation stays valid.
            if (state.pending !== undefined) {
              // A journal write that fails here must drop the live session.
              // Clearing the turn in memory would discard the open step without
              // a durable results message, and leaving it in flight rejects
              // every later send. Resume rebuilds that step from the journal.
              try {
                closePendingStep(state);
              } catch (error) {
                release(state);
                throw error;
              }
              if (state.estimatedCostUsd === null && state.latestReportedUsage !== undefined) {
                emit(state, {
                  kind: "usage",
                  ...state.latestReportedUsage,
                  estimatedCostUsd: null,
                });
              }
              emit(state, { kind: "interrupted", message: "The provider request was cancelled." });
            }
            // The session and its conversation stay live, so the next send
            // continues this session instead of rebuilding it from the journal.
            settleTurnWithoutStopping(state);
          },
          catch: sanitizeFailure,
        }),
      stop: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const state = sessions.get(String(sessionId));
            if (state === undefined) return;
            state.abortController?.abort();
            if (state.inFlight !== undefined) await state.inFlight;
            release(state);
          },
          catch: sanitizeFailure,
        }),
      answerApproval: () =>
        Effect.fail(failure("unsupported", "This provider does not support approval requests.")),
      answerUserInput: () =>
        Effect.fail(failure("unsupported", "This provider does not support user questions.")),
      answerTool: (input) =>
        Effect.try({
          try: () => {
            const state = stateFor(input.sessionId);
            const pending = state.pending;
            // A retried answer must not start a second continuation or send
            // the same result twice, even after its step has moved on.
            if (state.answered.has(input.requestId)) return undefined;
            if (state.tools.length === 0 && pending === undefined) {
              throw failure("unsupported", "This provider does not support app-managed tools.");
            }
            if (
              pending === undefined ||
              !pending.calls.some((call) => call.toolCallId === input.requestId)
            ) {
              throw failure("protocol", "The tool request is unknown.");
            }
            pending.answers.set(input.requestId, input);
            state.answered.add(input.requestId);
            state.transcripts.settle(state.transcriptId, {
              toolCallId: input.requestId,
              resultJson: input.resultJson,
              isError: input.isError,
              ...(input.images === undefined || input.images.length === 0
                ? {}
                : { imagesOmitted: input.images.length }),
            });
            if (!pending.calls.every((call) => pending.answers.has(call.toolCallId))) {
              return undefined;
            }
            advanceAfterResults(state);
            return undefined;
          },
          catch: sanitizeFailure,
        }).pipe(Effect.asVoid),
    };
  });
}

/**
 * Instructions blocks become the system prompt, joined in the order they came
 * so the prefix stays byte-stable from turn to turn; every other block rides
 * in the user message as before.
 */
function splitInstructions(context: ReadonlyArray<ProviderContextBlock> | undefined): {
  readonly system: ReadonlyArray<string>;
  readonly rest: ReadonlyArray<ProviderContextBlock>;
} {
  const blocks = context ?? [];
  return {
    system: blocks.filter((block) => block.kind === "instructions").map((block) => block.text),
    rest: blocks.filter((block) => block.kind !== "instructions"),
  };
}

function composeSystem(
  instructions: ReadonlyArray<string>,
  tools: ReadonlyArray<ProviderToolDefinition>,
): string | undefined {
  const guide = nativeHarnessToolGuide(tools.map((tool) => tool.name));
  const parts = [...instructions, ...(guide === undefined ? [] : [guide])];
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * Why a tool call the model made cannot be run, as the error result that goes
 * back to the model, or undefined when the call is well formed. A call whose
 * id repeats would let one answer satisfy several calls, a tool the turn never
 * offered has no authority behind it, and arguments that are not JSON cannot
 * be decoded; each goes back as an error the model can correct. Arguments are
 * never replaced by an empty object — the exact bytes the model sent are what
 * is refused.
 */
function toolCallProblem(
  offered: ReadonlyArray<ProviderToolDefinition>,
  call: NativeHarnessTranscriptToolCall,
  idCounts: ReadonlyMap<string, number>,
): string | undefined {
  if ((idCounts.get(call.toolCallId) ?? 0) > 1) {
    // One answer could satisfy several calls, so no call in a step that
    // reuses an id can run; every one of them goes back as an error.
    return JSON.stringify({
      error: "The tool call id was reused within this step.",
      toolCallId: call.toolCallId,
    });
  }
  if (!offered.some((tool) => tool.name === call.toolName)) {
    return JSON.stringify({
      error: `No tool named "${call.toolName}" was offered.`,
      tool: call.toolName,
    });
  }
  try {
    JSON.parse(call.argumentsJson);
  } catch {
    return JSON.stringify({
      error: "arguments were not valid JSON",
      arguments: call.argumentsJson.slice(0, 512),
    });
  }
  return undefined;
}

/**
 * The conversation a resume continues from. A step the process stopped in
 * the middle of is closed first: each call that never settled gets an honest
 * interrupted result, journaled like any other, so the model reads what
 * happened and every call is followed by its result as both protocols require.
 */
function closeOpenStep(
  transcriptId: ProviderSessionId,
  transcript: NativeHarnessTranscript,
  transcripts: NativeHarnessTranscriptStore,
): NativeHarnessMessage[] {
  const messages: NativeHarnessMessage[] = [...transcript.messages];
  const open = transcript.openStep;
  if (open === undefined) return messages;
  const settled = new Map(open.settled.map((result) => [result.toolCallId, result]));
  for (const result of interruptedResults(
    open.calls.filter((call) => !settled.has(call.toolCallId)),
  )) {
    transcripts.settle(transcriptId, result);
    settled.set(result.toolCallId, result);
  }
  messages.push({
    role: "assistant",
    text: "",
    toolResults: open.calls.flatMap((call) => {
      const result = settled.get(call.toolCallId);
      return result === undefined ? [] : [result];
    }),
  });
  return messages;
}

/** Where each turn of a conversation begins: the plain user message `send` journals for it. */
function turnStarts(messages: ReadonlyArray<NativeHarnessMessage>): ReadonlyArray<number> {
  return messages.flatMap((message, index) => (isPlainUserMessage(message) ? [index] : []));
}

/**
 * The summary as the model reads it. It says how much of the session it
 * stands for, so the lead knows those turns are out of view rather than
 * taking the summary for everything that happened.
 */
function compactionSummaryMessage(
  compaction: NativeHarnessTranscriptCompaction,
): NativeHarnessMessage {
  const replaced =
    compaction.turns === 1
      ? "The first turn of this session was summarized and is"
      : `The first ${compaction.turns} turns of this session were summarized and are`;
  return {
    role: "user",
    text: `${replaced} no longer shown in full; the files on disk still reflect that work. Summary:\n\n${compaction.summary}`,
  };
}

/**
 * The task list a compaction carries: the arguments of the latest
 * `todo-write` that did not fail in the turns being summarized, or else the
 * list the earlier summary already carried. Undefined when there is none.
 */
function carriedTaskList(
  earlier: NativeHarnessTranscriptCompaction | undefined,
  messages: ReadonlyArray<NativeHarnessMessage>,
): string | undefined {
  const failed = new Set(
    messages.flatMap((message) =>
      (message.toolResults ?? []).flatMap((result) => (result.isError ? [result.toolCallId] : [])),
    ),
  );
  const written = messages
    .flatMap((message) => message.toolCalls ?? [])
    .findLast((call) => call.toolName === "todo-write" && !failed.has(call.toolCallId));
  if (written !== undefined) return clipCompactionItem(written.argumentsJson);
  if (earlier === undefined) return undefined;
  const at = earlier.summary.lastIndexOf(TASK_LIST_LEAD);
  return at === -1 ? undefined : earlier.summary.slice(at + TASK_LIST_LEAD.length).trim();
}

function clipCompactionItem(value: string): string {
  return value.length <= COMPACTION_ITEM_CHARACTERS
    ? value
    : `${value.slice(0, COMPACTION_ITEM_CHARACTERS)} [truncated]`;
}

/**
 * The conversation a request is built from once the transcript was compacted:
 * the summary in place of the turns it covers, then every later message. A
 * marker that cannot be placed on this transcript's turns is not applied, so
 * the conversation is sent whole rather than cut at a guess.
 */
function afterCompaction(
  messages: NativeHarnessMessage[],
  compaction: NativeHarnessTranscriptCompaction | undefined,
): {
  readonly messages: NativeHarnessMessage[];
  readonly compaction: NativeHarnessTranscriptCompaction | undefined;
  /** The journal's number for the first message kept after the summary. */
  readonly journalOffset: number;
} {
  if (compaction === undefined) return { messages, compaction, journalOffset: 0 };
  const start = turnStarts(messages)[compaction.turns];
  if (start === undefined) return { messages, compaction: undefined, journalOffset: 0 };
  return {
    messages: [compactionSummaryMessage(compaction), ...messages.slice(start)],
    compaction,
    journalOffset: start,
  };
}

/** The turns a compaction summarizes, as one text the summary request carries. */
function compactionMaterial(
  earlier: NativeHarnessTranscriptCompaction | undefined,
  messages: ReadonlyArray<NativeHarnessMessage>,
): string {
  const clip = clipCompactionItem;
  const lines: string[] = [];
  if (earlier !== undefined) lines.push(`Earlier summary: ${clip(earlier.summary)}`);
  for (const message of messages) {
    if (message.text.length > 0) {
      lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${clip(message.text)}`);
    }
    for (const call of message.toolCalls ?? []) {
      lines.push(`Assistant called ${call.toolName}: ${clip(call.argumentsJson)}`);
    }
    for (const result of message.toolResults ?? []) {
      lines.push(
        `${result.isError ? "Tool error" : "Tool result"} for ${result.toolCallId}: ${clip(result.resultJson)}`,
      );
    }
  }
  return lines.join("\n\n");
}

function transcriptIdOf(cursor: ProviderResumeCursor): ProviderSessionId | undefined {
  try {
    return decodeProviderSessionId(cursor.value);
  } catch {
    return undefined;
  }
}

function interruptedResults(
  calls: ReadonlyArray<NativeHarnessTranscriptToolCall>,
): ReadonlyArray<NativeHarnessTranscriptToolResult> {
  return calls.map((call) => ({
    toolCallId: call.toolCallId,
    isError: true,
    resultJson: JSON.stringify(
      REPLAY_SAFE_TOOLS.has(call.toolName)
        ? {
            interrupted: true,
            replay: "safe",
            note: "This call was interrupted before it returned. It only reads, so you can call it again.",
          }
        : {
            interrupted: true,
            replay: "unsafe",
            note: "This call was interrupted before it returned. It may or may not have taken effect. Check the current state before you repeat it.",
          },
    ),
  }));
}

/**
 * The tool definitions in one fixed order, by name. The order a provider sees
 * is part of the request prefix its cache keys on, so the order a turn happens
 * to compose tools in (the harness set plus whatever else it offers) must
 * never reach the wire: two turns that offer the same tools then send the same
 * bytes, and a step reads the earlier steps from cache.
 */
export function sortToolDefinitionsByName(
  tools: ReadonlyArray<ProviderToolDefinition>,
): ReadonlyArray<ProviderToolDefinition> {
  return [...tools].sort((left, right) => {
    const leftName = String(left.name);
    const rightName = String(right.name);
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
}

/**
 * Shrinks the request until the endpoint accepts its size, without touching
 * the conversation itself (decision 0067): first older tool results are
 * replaced by a marker, oldest first, then whole earlier exchanges are left
 * out behind a note. The latest message is never cut. Undefined means even
 * that does not fit.
 *
 * `reduceOnce` forces at least one step of the ladder even when the endpoint's
 * own size estimate says the request fits. It is used after the endpoint has
 * refused a request as too large: the estimate was wrong, so the request must
 * actually shrink before it is sent again. A step that would leave the request
 * as it was (a result already omitted, a note already in front) is skipped,
 * since the refused request may itself have been reduced already; resending
 * the same bytes would only be refused again.
 *
 * `journalNumberOf` gives a message's number in the journal. When the request
 * offers `journal-lookup`, the note names the journaled messages before the
 * first one kept, which is every message a cut can have left out. `mode` is
 * the session's; without it the note claims no files on disk.
 */
export function fitRequest(
  endpoint: Pick<NativeHarnessTransportSession, "fits">,
  request: NativeHarnessRequest,
  options?: {
    readonly reduceOnce?: boolean | undefined;
    readonly journalNumberOf?: ((message: NativeHarnessMessage) => number | undefined) | undefined;
    readonly mode?: OctantMode | undefined;
  },
): NativeHarnessRequest | undefined {
  if (options?.reduceOnce !== true && endpoint.fits(request)) return request;
  const history = [...request.history];
  const fits = (candidate: ReadonlyArray<NativeHarnessMessage>) =>
    endpoint.fits({ ...request, history: candidate });
  for (let index = 0; index < history.length - 1; index += 1) {
    const message = history[index];
    if (message?.toolResults === undefined) continue;
    if (message.toolResults.every((result) => result.resultJson === OMITTED_RESULT_JSON)) continue;
    history[index] = {
      ...message,
      toolResults: message.toolResults.map((result) => ({
        toolCallId: result.toolCallId,
        resultJson: OMITTED_RESULT_JSON,
        isError: result.isError,
      })),
    };
    if (fits(history)) return { ...request, history };
  }
  // Leave out whole exchanges from the front. A cut only lands on a plain
  // user message so no tool result is separated from its call.
  const lookupOffered = request.tools.some((tool) => String(tool.name) === "journal-lookup");
  let start = 0;
  for (;;) {
    let next = start + 1;
    while (next < history.length - 1 && !isPlainUserMessage(history[next])) next += 1;
    if (next >= history.length - 1 && !isPlainUserMessage(history[next])) return undefined;
    start = next;
    const kept = history[start];
    const note = omittedHistoryNote(
      options?.mode,
      lookupOffered && kept !== undefined ? options?.journalNumberOf?.(kept) : undefined,
    );
    // Cutting only an earlier note and putting the same note back changes nothing.
    const unchanged = start === 1 && history[0]?.text === note;
    const candidate = [{ role: "user" as const, text: note }, ...history.slice(start)];
    if (!unchanged && fits(candidate)) return { ...request, history: candidate };
    if (start >= history.length - 1) return undefined;
  }
}

/** Whether fitting left whole earlier exchanges out of this request behind the note. */
function leftOutHistory(request: NativeHarnessRequest): boolean {
  const first = request.history[0];
  // The note may go on to name the journal numbers a lookup can read back.
  return isPlainUserMessage(first) && first?.text.startsWith(OMITTED_HISTORY_NOTE) === true;
}

function isPlainUserMessage(message: NativeHarnessMessage | undefined): boolean {
  return message?.role === "user" && message.toolResults === undefined;
}

/** The endpoint's own failure, saying why the turn found no other model to continue on. */
function withoutFallback(
  spent: ProviderFailure,
  reason: Extract<NativeHarnessLeadFallbackOutcome, { status: "none" }>["reason"],
): ProviderFailure {
  return { ...spent, message: `${spent.message} ${FALLBACK_REFUSAL_TEXT[reason]}` };
}

const FALLBACK_REFUSAL_TEXT = {
  "slot-empty": "No fallback model is configured.",
  "no-eligible-candidate": "No fallback model is ready.",
  "circuit-open": "Fallback is paused after repeated failures.",
  "no-other-model": "No other model is configured to continue on.",
  "not-routed": "No fallback model was available.",
  refused: "The fallback model cannot take this turn.",
} as const;

function sanitizeFailure(error: unknown): ProviderFailure {
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return failure("provider-failed", "The provider request failed.");
  }
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}
