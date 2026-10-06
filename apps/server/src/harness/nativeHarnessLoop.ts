import {
  decodeProviderFailure,
  decodeProviderSessionId,
  type CorrelationId,
  type NativeHarnessTranscriptToolCall,
  type NativeHarnessTranscriptToolResult,
  type OctantMode,
  type ProviderContextBlock,
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
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { renderProviderTurnPrompt } from "@octant/provider-sdk/chat-conformance";
import { Effect, PubSub, Stream, type Scope } from "effect";
import { isEndpointRetriesExhausted } from "../providers/endpointRetry";
import type { ObservedRateLimitBucket } from "../providers/rateLimitHeaders";
import { nativeHarnessToolGuide } from "./nativeHarnessInstructions";
import type {
  NativeHarnessTranscript,
  NativeHarnessTranscriptStore,
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
const OMITTED_HISTORY_NOTE =
  "Earlier messages of this session were left out to fit the context window. Your task list and the files on disk still reflect that work.";

export type NativeHarnessDriverKind =
  | "openai-compatible"
  | "anthropic-compatible"
  | "azure-foundry";

export interface NativeHarnessConnectionOptions {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: NativeHarnessDriverKind;
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
  /** Everything this turn's requests have cost so far; a figure no request reported stays absent. */
  usage: NativeHarnessUsage;
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
      readonly modelId: ProviderModelId;
      readonly endpoint: NativeHarnessTransportSession;
      readonly messages: NativeHarnessMessage[];
      readonly tools?: ReadonlyArray<ProviderToolDefinition> | undefined;
    }): SessionState => ({
      sessionId: input.sessionId,
      transcriptId: input.transcriptId,
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
      fallback: undefined,
      attempted: [],
      nextSequence: 1,
      inFlight: undefined,
      abortController: undefined,
      stopped: false,
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });

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
          options.transcripts.append(state.transcriptId, message);
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
      const step = sendOnLead(state, request, controller.signal)
        .then((response) => settleResponse(state, response))
        .catch((error: unknown) => {
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
        onEvent: (event: NativeHarnessStreamEvent) => emit(state, { ...event }),
      };
      let current = request;
      if (state.fallback !== undefined) {
        const refit = fitRequest(state.fallback.endpoint, {
          ...request,
          modelId: state.fallback.target.modelId,
        });
        if (refit === undefined) {
          throw failure(
            "invalid-configuration",
            "The provider request exceeded the configured size limit.",
          );
        }
        current = refit;
      }
      for (;;) {
        try {
          return await (state.fallback?.endpoint ?? state.endpoint).send(current, stream);
        } catch (error) {
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
          const moved = fitRequest(outcome.endpoint, {
            ...current,
            modelId: outcome.target.modelId,
          });
          if (moved === undefined) {
            outcome.endpoint.release();
            throw failure(
              "invalid-configuration",
              "The provider request exceeded the configured size limit.",
            );
          }
          state.fallback?.endpoint.release();
          state.fallback = { target: outcome.target, endpoint: outcome.endpoint };
          current = moved;
        }
      }
    };

    const settleResponse = (state: SessionState, response: NativeHarnessResponse) => {
      // Header buckets describe the account after this response; they go
      // first so a consumer that stops at the terminal still sees them.
      for (const bucket of response.rateLimitBuckets ?? []) emitBucket(state, bucket);
      if (response.usage !== undefined)
        state.usage = addNativeHarnessUsage(state.usage, response.usage);
      if (response.toolCalls.length > 0) {
        const refused = refuseToolCalls(state.tools, response.toolCalls);
        if (refused !== undefined) {
          emit(state, { kind: "failed", failure: failure("protocol", refused) });
          return;
        }
        const message: NativeHarnessMessage = {
          role: "assistant",
          text: response.text,
          toolCalls: response.toolCalls,
        };
        options.transcripts.append(state.transcriptId, message);
        state.messages.push(message);
        state.pending = { calls: response.toolCalls, answers: new Map() };
        for (const call of response.toolCalls) {
          emit(state, {
            kind: "tool-request",
            requestId: call.toolCallId,
            toolName: call.toolName,
            inputJson: call.argumentsJson,
          });
        }
        return;
      }
      const message: NativeHarnessMessage = { role: "assistant", text: response.text };
      options.transcripts.append(state.transcriptId, message);
      state.messages.push(message);
      const steered = takeSteeringRequest(state);
      if (steered !== undefined) {
        void runStep(state, steered);
        return;
      }
      // A turn that took several requests reports its whole cost once more
      // before it ends; consumers keep the latest usage they saw.
      if (state.steps > 1 && (state.usage.inputTokens > 0 || state.usage.outputTokens > 0)) {
        emit(state, { kind: "usage", ...state.usage });
      }
      state.acceptingSteering = false;
      emit(state, { kind: "completed", resumeCursor: cursorFor(state) });
    };

    const emitBucket = (state: SessionState, bucket: ObservedRateLimitBucket) =>
      emit(state, { kind: "rate-limit-bucket", ...bucket });

    const requestFor = (state: SessionState, history: ReadonlyArray<NativeHarnessMessage>) =>
      fitRequest(state.endpoint, {
        sessionId: state.sessionId,
        modelId: state.modelId,
        system: state.system,
        history,
        tools: sortToolDefinitionsByName(state.tools),
      });

    return {
      subscribe: Stream.fromPubSub(events, { scoped: true }),
      start: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (sessions.has(String(input.sessionId))) {
              throw failure("protocol", "Provider session is already active.");
            }
            const endpoint = await options.transport.open(input.modelId);
            try {
              options.transcripts.open(input.sessionId, {
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
              modelId: input.modelId,
              endpoint,
              messages: [],
              tools: input.tools,
            });
            admit(state);
            return { sessionId: input.sessionId, resumeCursor: cursorFor(state) };
          },
          catch: sanitizeFailure,
        }),
      resume: (input) =>
        Effect.tryPromise({
          try: async () => {
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
            const endpoint = await options.transport.open(transcript.binding.modelId);
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
            const state = newState({
              sessionId: input.sessionId,
              transcriptId,
              modelId: transcript.binding.modelId,
              endpoint,
              messages,
              tools: input.tools,
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
            // Nothing is recorded for a request that cannot be sent: the user
            // message joins the conversation only once it provably fits.
            const request = requestFor(state, [...state.messages, user]);
            if (request === undefined) {
              throw failure(
                "invalid-configuration",
                "The provider request exceeded the configured size limit.",
              );
            }
            options.transcripts.append(state.transcriptId, user);
            state.messages.push(user);
            state.pending = undefined;
            state.answered.clear();
            // Each turn starts on the lead's own model again.
            state.fallback?.endpoint.release();
            state.fallback = undefined;
            state.attempted = [];
            state.turn = input;
            state.steps = 0;
            state.usage = { inputTokens: 0, outputTokens: 0 };
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
            // else reports the cancellation. The unanswered calls stay
            // unsettled in the journal; a resume closes them honestly.
            if (state.pending !== undefined) {
              state.pending = undefined;
              emit(state, { kind: "interrupted", message: "The provider request was cancelled." });
            }
            release(state);
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
            options.transcripts.settle(state.transcriptId, {
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
              return undefined;
            }
            void runStep(state, request);
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
 * Fails closed on a step the server must not execute: a call id used twice
 * would let one answer satisfy several calls, and a tool the turn never
 * offered has no authority behind it.
 */
function refuseToolCalls(
  offered: ReadonlyArray<ProviderToolDefinition>,
  calls: ReadonlyArray<NativeHarnessTranscriptToolCall>,
): string | undefined {
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.toolCallId)) return "The provider returned duplicate tool call identifiers.";
    seen.add(call.toolCallId);
  }
  const names = new Set(offered.map((tool) => tool.name));
  const unoffered = calls.find((call) => !names.has(call.toolName));
  return unoffered === undefined
    ? undefined
    : `The provider requested an unsupported tool: ${unoffered.toolName}.`;
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
 */
export function fitRequest(
  endpoint: Pick<NativeHarnessTransportSession, "fits">,
  request: NativeHarnessRequest,
): NativeHarnessRequest | undefined {
  if (endpoint.fits(request)) return request;
  const history = [...request.history];
  const fits = (candidate: ReadonlyArray<NativeHarnessMessage>) =>
    endpoint.fits({ ...request, history: candidate });
  for (let index = 0; index < history.length - 1; index += 1) {
    const message = history[index];
    if (message?.toolResults === undefined) continue;
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
  let start = 0;
  for (;;) {
    let next = start + 1;
    while (next < history.length - 1 && !isPlainUserMessage(history[next])) next += 1;
    if (next >= history.length - 1 && !isPlainUserMessage(history[next])) return undefined;
    start = next;
    const candidate = [
      { role: "user" as const, text: OMITTED_HISTORY_NOTE },
      ...history.slice(start),
    ];
    if (fits(candidate)) return { ...request, history: candidate };
    if (start >= history.length - 1) return undefined;
  }
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
