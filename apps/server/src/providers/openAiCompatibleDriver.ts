import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  decodeProviderFailure,
  decodeProviderObservedState,
  type CorrelationId,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderCapabilities,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderToolAnswer,
  type ProviderToolDefinition,
  type UtcTimestamp,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  renderProviderTurnPrompt,
  textOnlyInputModalities,
  unsupportedAnswerTool,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Option, PubSub, Stream } from "effect";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { sendChatCompletionsTurn, type ChatCompletionsTurnResult } from "./openAiChatCompletions";
import {
  makeOpenAiCompatibleEndpoint,
  markCompatibleModelVerified,
  probeModels,
  type CompatibleFetch,
  type OpenAiCompatibleAuthStrategy,
  type OpenAiCompatibleEndpoint,
} from "./openAiCompatibleEndpoint";
import {
  selectCompatibleProtocol,
  type CompatibleProtocol,
  type CompatibleProtocolAttemptResult,
} from "./openAiProtocolSelection";
import {
  sendResponsesTurn,
  type ProtocolHistoryMessage,
  type ProtocolToolCall,
  type ProtocolTurnEvent,
  type ProtocolTurnFailureMetadata,
  type ProtocolTurnResult,
} from "./openAiResponses";
import {
  capabilityEchoToolDefinition,
  isCapabilityEchoToolCall,
  normalizeToolName,
} from "./openAiToolEncoding";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const initialCapabilities: ProviderCapabilities = {
  streaming: "unavailable",
  resume: "unsupported",
  interruption: "supported",
  approvals: "unsupported",
  userQuestions: "unsupported",
  reasoning: "unavailable",
  usage: "unavailable",
  toolActivity: "unsupported",
  fileChanges: "unsupported",
  diffs: "unsupported",
  taskProgress: "unsupported",
  nativeChildAgents: "unsupported",
  ...unsupportedChatCapabilities,
};

export interface OpenAiCompatibleDriverProfile {
  readonly driverKind: "openai-compatible" | "azure-foundry";
  readonly authStrategy: OpenAiCompatibleAuthStrategy;
}

export interface OpenAiCompatibleDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: OpenAiCompatibleProviderConfiguration;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: CompatibleFetch;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly onConnectionReleased?: () => void;
  /**
   * Driver identity and credential strategy. Defaults to the OpenAI-compatible
   * profile derived from the configuration. Azure AI Foundry reuses this driver
   * core with `azure-foundry` identity and `api-key` authentication.
   */
  readonly profile?: OpenAiCompatibleDriverProfile;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
  readonly correlationId: CorrelationId;
  endpoint: OpenAiCompatibleEndpoint | undefined;
  readonly history: ProtocolHistoryMessage[];
  nextSequence: number;
  inFlight: Promise<void> | undefined;
  abortController: AbortController | undefined;
  active: boolean;
  stopped: boolean;
  pendingToolCalls: readonly ProtocolToolCall[];
  toolAnswers: ProviderToolAnswer[];
  activeTools: readonly ProviderToolDefinition[];
  accumulatedInputTokens: number;
  accumulatedOutputTokens: number;
}

type CompatibleTurnResult = ProtocolTurnResult | ChatCompletionsTurnResult;

export function makeOpenAiCompatibleDriver(options: OpenAiCompatibleDriverOptions): ProviderDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? randomUUID;
  const profile: OpenAiCompatibleDriverProfile = options.profile ?? {
    driverKind: "openai-compatible",
    authStrategy: options.configuration.authentication,
  };
  return {
    kind: profile.driverKind,
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              const endpoint = endpointFor(options, options.credentialResolver, profile);
              const result = await probeModels(endpoint);
              const observedAt = clock() as UtcTimestamp;
              // Do NOT run a generating tool-echo turn during routine probes:
              // ChatService.#prepareTurnExecution calls driver.probe() before
              // every Chat turn, so a probe-time tool echo would add an
              // unadvertised paid request per turn and would only test the
              // first listed model while setting the provider-level
              // appManagedTools flag, enabling tools for unverified models.
              // Tool support is gated on per-model verification
              // (verifiedToolModelIds for Foundry; stickyToolSupport after a
              // successful tool turn for non-Foundry) instead.
              const priorObserved = options.runtimeRegistry.observedState(instanceId);
              const priorVerified = priorObserved?.verifiedToolModelIds;
              // For non-Foundry profiles, preserve the prior sticky
              // appManagedTools so a re-probe before a Chat turn does not
              // wipe tool support that was observed during a prior successful
              // tool turn. For Foundry, tools are gated per-model via
              // verifiedToolModelIds, so the provider-level flag stays
              // "unsupported" until every deployment is verified.
              const priorAppManagedTools =
                profile.driverKind === "azure-foundry"
                  ? ("unsupported" as const)
                  : (priorObserved?.capabilities.appManagedTools ?? "unsupported");
              const probe = decodeProviderObservedState({
                instanceId,
                readiness: result.readiness,
                processState: "stopped",
                ...(profile.authStrategy !== "none" ? { credentialStatus: "stored" } : {}),
                models: result.models,
                capabilities: {
                  ...initialCapabilities,
                  appManagedTools: priorAppManagedTools,
                },
                ...(priorVerified === undefined ? {} : { verifiedToolModelIds: priorVerified }),
                ...(result.failure === undefined ? {} : { message: result.failure.message }),
                lastSuccessfulProbeAt: observedAt,
                observedAt,
              });
              options.runtimeRegistry.setObservedState(probe);
              return probe;
            },
            catch: sanitizeFailure,
          }),
    verifyToolCapability: ({ instanceId, modelId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              const endpoint = endpointFor(options, options.credentialResolver, profile);
              // Propagate transport failures (auth, timeout, provider error)
              // so the user sees the actual error instead of a false
              // "unsupported" result.
              const toolSupport = await probeToolCapabilityForModel(
                options,
                endpoint,
                modelId,
                true,
              );
              return {
                instanceId,
                modelId,
                appManagedTools: toolSupport,
              };
            },
            catch: sanitizeFailure,
          }),
    acquire: ({ instanceId, projectRoot }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : !isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot
          ? Effect.fail(
              failure(
                "invalid-configuration",
                "Provider Project root must be an absolute normalized path.",
              ),
            )
          : makeConnection(options, profile, clock, makeCorrelation),
  };
}

function makeConnection(
  options: OpenAiCompatibleDriverOptions,
  profile: OpenAiCompatibleDriverProfile,
  clock: () => string,
  makeCorrelation: () => string,
): Effect.Effect<ProviderConnection, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const offer = (event: ProviderRuntimeEvent) => {
      Effect.runFork(PubSub.publish(events, event));
    };
    const deactivate = (state: SessionState) => {
      if (!state.active) return;
      state.active = false;
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        Math.max(0, options.runtimeRegistry.activeSessionCount(options.instanceId) - 1),
      );
    };
    const releaseSession = (state: SessionState) => {
      state.history.length = 0;
      state.abortController = undefined;
      state.inFlight = undefined;
      state.endpoint = undefined;
      state.stopped = true;
      state.pendingToolCalls = [];
      state.toolAnswers = [];
      state.activeTools = [];
      deactivate(state);
      if (sessions.get(state.sessionId) === state) sessions.delete(state.sessionId);
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const state of sessions.values()) state.abortController?.abort();
        await Promise.allSettled(
          [...sessions.values()].flatMap((state) =>
            state.inFlight === undefined ? [] : [state.inFlight],
          ),
        );
        for (const state of sessions.values()) releaseSession(state);
        sessions.clear();
        await Effect.runPromise(PubSub.shutdown(events));
        options.onConnectionReleased?.();
      }),
    );

    const stateFor = (sessionId: ProviderSessionId): SessionState => {
      const state = sessions.get(sessionId);
      if (state === undefined) throw failure("protocol", "Provider session is not active.");
      return state;
    };

    return {
      subscribe: Stream.fromPubSub(events, { scoped: true }),
      start: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (sessions.has(input.sessionId)) {
              throw failure("protocol", "Provider session is already active.");
            }
            const credential = await resolveSessionCredential(options, profile);
            const endpoint = endpointFor(
              options,
              credential === undefined
                ? undefined
                : { has: async () => true, resolve: async () => credential },
              profile,
            );
            const state: SessionState = {
              sessionId: input.sessionId,
              modelId: input.modelId,
              correlationId: makeCorrelation() as CorrelationId,
              endpoint,
              history: [],
              nextSequence: 1,
              inFlight: undefined,
              abortController: undefined,
              active: true,
              stopped: false,
              pendingToolCalls: [],
              toolAnswers: [],
              activeTools: [],
              accumulatedInputTokens: 0,
              accumulatedOutputTokens: 0,
            };
            sessions.set(input.sessionId, state);
            options.runtimeRegistry.setActiveSessionCount(
              options.instanceId,
              options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
            );
            return { sessionId: input.sessionId };
          },
          catch: sanitizeFailure,
        }),
      resume: () =>
        Effect.fail(failure("unsupported", "This provider does not support session resume.")),
      send: (input) =>
        Effect.tryPromise({
          try: async () => {
            const state = stateFor(input.sessionId);
            if (state.stopped) throw failure("protocol", "Provider session is not active.");
            if (state.inFlight !== undefined) {
              throw failure("protocol", "Provider session already has an in-flight turn.");
            }
            const observed = options.runtimeRegistry.observedState(options.instanceId);
            const model = observed?.models.find((candidate) => candidate.id === state.modelId);
            const isCapabilityEchoProbe =
              input.tools.length > 0 &&
              input.tools.every((tool) => isCapabilityEchoToolCall(tool.name));
            // For Azure AI Foundry, tool support is verified per-deployment via
            // the separate verify-foundry-tools path. The sender gates tool
            // requests on the per-model verifiedToolModelIds set, not on the
            // provider-level appManagedTools flag, so one verified deployment
            // does not unlock tools for other deployments in the same profile.
            const isFoundry = options.profile?.driverKind === "azure-foundry";
            const isVerifiedModel =
              observed?.verifiedToolModelIds?.some((id) => String(id) === String(state.modelId)) ??
              false;
            const providerToolSupport =
              observed?.capabilities.appManagedTools ?? initialCapabilities.appManagedTools;
            const effectiveCapabilities = isCapabilityEchoProbe
              ? {
                  ...(observed?.capabilities ?? initialCapabilities),
                  appManagedTools: "supported" as const,
                }
              : isFoundry
                ? {
                    ...(observed?.capabilities ?? initialCapabilities),
                    // Foundry: only per-model verification gates tools, never
                    // the provider-level flag.
                    appManagedTools: isVerifiedModel
                      ? ("supported" as const)
                      : ("unsupported" as const),
                  }
                : {
                    ...(observed?.capabilities ?? initialCapabilities),
                    appManagedTools: isVerifiedModel ? ("supported" as const) : providerToolSupport,
                  };
            const rejected = validateChatTurnInput(input, effectiveCapabilities, model);
            if (rejected !== undefined) throw rejected;
            const controller = new AbortController();
            const started = deferred();
            const priorHistory = state.history.slice();
            const prompt = renderProviderTurnPrompt(input);
            assertTurnRequestConstructable(options, state, priorHistory, prompt);
            state.abortController = controller;
            state.history.push({ role: "user", text: prompt });
            state.pendingToolCalls = [];
            state.toolAnswers = [];
            state.activeTools = input.tools;
            state.accumulatedInputTokens = 0;
            state.accumulatedOutputTokens = 0;
            const turn = runTurn(
              options,
              state,
              priorHistory,
              prompt,
              input.tools,
              [],
              controller.signal,
              offer,
              clock,
              started.resolve,
            )
              .then((result) => finishSuccessfulTurn(options, state, result, offer, clock))
              .catch((error) =>
                finishFailedTurn(options.instanceId, state, sanitizeFailure(error), offer, clock),
              )
              .finally(() => {
                // Keep the turn in-flight while waiting for answerTool so
                // interrupt/stop continue to work during the tool phase.
                if (state.pendingToolCalls.length > 0) return;
                state.inFlight = undefined;
                state.abortController = undefined;
              });
            state.inFlight = turn;
            await started.promise;
          },
          catch: sanitizeFailure,
        }),
      interrupt: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const state = stateFor(sessionId);
            if (state.inFlight === undefined || state.abortController === undefined) {
              throw failure("protocol", "Provider session has no in-flight turn.");
            }
            state.stopped = true;
            state.abortController.abort();
            await state.inFlight;
            // If the turn is in the tool phase (pendingToolCalls > 0), the
            // inFlight promise is already settled and aborting the completed
            // request cannot trigger finishFailedTurn. Emit an interrupted
            // terminal so consumers observe the cancellation (P2 #6).
            if (state.pendingToolCalls.length > 0) {
              state.pendingToolCalls = [];
              state.toolAnswers = [];
              state.activeTools = [];
              offer(
                terminalEvent(
                  options.instanceId,
                  state,
                  { kind: "interrupted", message: "The provider request was cancelled." },
                  clock,
                ),
              );
            }
            releaseSession(state);
          },
          catch: sanitizeFailure,
        }),
      stop: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const state = sessions.get(sessionId);
            if (state === undefined) return;
            state.stopped = true;
            state.abortController?.abort();
            if (state.inFlight !== undefined) await state.inFlight;
            releaseSession(state);
          },
          catch: sanitizeFailure,
        }),
      answerApproval: () =>
        Effect.fail(failure("unsupported", "This provider does not support approval requests.")),
      answerUserInput: () =>
        Effect.fail(failure("unsupported", "This provider does not support user questions.")),
      answerTool: (input) =>
        answerToolEffect(options, stateFor(input.sessionId), input, offer, clock),
    };
  });
}

function answerToolEffect(
  options: OpenAiCompatibleDriverOptions,
  state: SessionState,
  input: ProviderToolAnswer,
  offer: (event: ProviderRuntimeEvent) => void,
  clock: () => string,
): Effect.Effect<void, ProviderFailure> {
  if (state.activeTools.length === 0) {
    return unsupportedAnswerTool(initialCapabilities.appManagedTools);
  }
  if (state.pendingToolCalls.length === 0) {
    return Effect.fail(failure("protocol", "The tool request is unknown."));
  }
  const known = state.pendingToolCalls.some((call) => call.toolCallId === input.requestId);
  if (!known) {
    return Effect.fail(failure("protocol", "The tool request is unknown."));
  }
  // Reject duplicate tool answers (P2 #5): if the app retries an answerTool
  // call for an already-recorded request, ignore the duplicate instead of
  // appending it. A duplicate would start a second continuation while the
  // first is running (single call) or encode duplicate tool results (parallel).
  const alreadyAnswered = state.toolAnswers.some((answer) => answer.requestId === input.requestId);
  if (alreadyAnswered) {
    return Effect.void;
  }
  state.toolAnswers.push(input);
  const allAnswered = state.pendingToolCalls.every((call) =>
    state.toolAnswers.some((answer) => answer.requestId === call.toolCallId),
  );
  if (!allAnswered) return Effect.void;
  // Persist tool results in history before starting the continuation (P2 #2):
  // if the continuation fails or asks for another tool, the stored conversation
  // must already include the tool outputs that answer the prior assistant
  // tool_calls, or subsequent recovery sends replay invalid history.
  state.history.push({
    role: "assistant",
    text: "",
    toolResults: state.toolAnswers.map((answer) => ({
      toolCallId: answer.requestId,
      resultJson: answer.resultJson,
      isError: answer.isError,
    })),
  });
  return Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      state.abortController = controller;
      const priorHistory = state.history.slice();
      const prompt = "";
      const started = deferred();
      const turn = runTurn(
        options,
        state,
        priorHistory,
        prompt,
        state.activeTools,
        state.toolAnswers.slice(),
        controller.signal,
        offer,
        clock,
        started.resolve,
      )
        .then((result) => finishSuccessfulTurn(options, state, result, offer, clock))
        .catch((error) =>
          finishFailedTurn(options.instanceId, state, sanitizeFailure(error), offer, clock),
        )
        .finally(() => {
          if (state.pendingToolCalls.length > 0) return;
          state.inFlight = undefined;
          state.abortController = undefined;
        });
      state.inFlight = turn;
      await started.promise;
    },
    catch: sanitizeFailure,
  });
}

async function runTurn(
  options: OpenAiCompatibleDriverOptions,
  state: SessionState,
  history: readonly ProtocolHistoryMessage[],
  prompt: string,
  tools: readonly ProviderToolDefinition[],
  toolAnswers: readonly ProviderToolAnswer[],
  signal: AbortSignal,
  offer: (event: ProviderRuntimeEvent) => void,
  clock: () => string,
  started: () => void,
): Promise<CompatibleTurnResult> {
  const endpoint = state.endpoint;
  if (endpoint === undefined) throw failure("protocol", "Provider session is not active.");
  const onEvent = (event: ProtocolTurnEvent) => {
    state.nextSequence = event.sequence + 1;
    // The tool-call kind is an internal protocol event; the driver emits the
    // public tool-request event separately after the turn completes.
    if (event.kind === "tool-call") return;
    offer(runtimeEvent(options.instanceId, state, event, clock));
  };
  const cache = {
    get: () => options.runtimeRegistry.compatibleProtocol(options.instanceId),
    set: (_instanceId: string, protocol: CompatibleProtocol) =>
      options.runtimeRegistry.setCompatibleProtocol(options.instanceId, protocol),
    delete: () => options.runtimeRegistry.clearCompatibleProtocol(options.instanceId),
    clear: () => options.runtimeRegistry.clearCompatibleProtocol(options.instanceId),
  };
  started();
  return selectCompatibleProtocol({
    instanceId: options.instanceId,
    preference: options.configuration.protocol,
    cache,
    attempt: async (protocol): Promise<CompatibleProtocolAttemptResult<CompatibleTurnResult>> => {
      if (protocol === "chat-completions") {
        try {
          return {
            ok: true,
            value: await Effect.runPromise(
              sendChatCompletionsTurn({
                endpoint,
                modelId: state.modelId,
                history,
                prompt,
                ...(tools.length === 0 ? {} : { tools }),
                ...(toolAnswers.length === 0 ? {} : { toolAnswers }),
                sequenceStart: state.nextSequence,
                signal,
                onEvent,
              }),
            ),
          };
        } catch (error) {
          return {
            ok: false,
            failure: signal.aborted
              ? failure("interrupted", "The provider request was cancelled.")
              : sanitizeFailure(error),
            accepted: false,
            outputStarted: false,
          };
        }
      }
      let metadata: ProtocolTurnFailureMetadata | undefined;
      try {
        return {
          ok: true,
          value: await Effect.runPromise(
            sendResponsesTurn({
              endpoint,
              modelId: state.modelId,
              history,
              prompt,
              ...(tools.length === 0 ? {} : { tools }),
              ...(toolAnswers.length === 0 ? {} : { toolAnswers }),
              sequenceStart: state.nextSequence,
              signal,
              onEvent,
              onAttemptFailure: (value) => {
                metadata = value;
              },
            }),
          ),
        };
      } catch (error) {
        return {
          ok: false,
          failure: signal.aborted
            ? failure("interrupted", "The provider request was cancelled.")
            : sanitizeFailure(error),
          accepted: metadata?.accepted ?? false,
          outputStarted: metadata?.outputStarted ?? false,
          ...(metadata?.httpStatus === undefined ? {} : { httpStatus: metadata.httpStatus }),
        };
      }
    },
  });
}

function finishSuccessfulTurn(
  options: OpenAiCompatibleDriverOptions,
  state: SessionState,
  result: CompatibleTurnResult,
  offer: (event: ProviderRuntimeEvent) => void,
  clock: () => string,
): void {
  const current = options.runtimeRegistry.observedState(options.instanceId);
  const models = markCompatibleModelVerified(
    current?.models ?? manualModels(options.configuration.manualModelIds),
    result.verifiedManualModelId ?? "",
  );
  const toolCallingObserved = result.terminal === "tool-calls";
  // Tool support is sticky once observed: a follow-up plain completion after
  // answerTool must not downgrade appManagedTools back to unsupported.
  const priorToolSupport = current?.capabilities.appManagedTools ?? "unsupported";
  // For Azure AI Foundry, tool support is per-deployment (gated by
  // verifiedToolModelIds), so the provider-level appManagedTools flag must
  // stay "unsupported" even after a verified deployment produces a tool call.
  // Otherwise a successful tool turn on one deployment would unlock tools for
  // all deployments in the same profile.
  const isFoundry = options.profile?.driverKind === "azure-foundry";
  const stickyToolSupport = isFoundry
    ? ("unsupported" as const)
    : priorToolSupport === "supported" || toolCallingObserved
      ? ("supported" as const)
      : priorToolSupport;
  // Accumulate usage across the tool loop so the final completed terminal
  // carries the total cost of the logical turn (P2 #9).
  if (result.usage !== undefined) {
    state.accumulatedInputTokens += result.usage.inputTokens;
    state.accumulatedOutputTokens += result.usage.outputTokens;
  }
  if (toolCallingObserved) {
    // Reject duplicate tool call identifiers before publishing any requests
    // (P2 #8): a malformed provider response with reused call ids would make
    // answerTool treat one answer as satisfying every duplicate.
    const seenCallIds = new Set<string>();
    for (const call of result.toolCalls) {
      if (seenCallIds.has(call.toolCallId)) {
        state.pendingToolCalls = [];
        state.toolAnswers = [];
        state.activeTools = [];
        offer(
          terminalEvent(
            options.instanceId,
            state,
            {
              kind: "failed",
              failure: {
                category: "protocol",
                message: "The provider returned duplicate tool call identifiers.",
              },
            },
            clock,
          ),
        );
        return;
      }
      seenCallIds.add(call.toolCallId);
    }
    // Reject unoffered tool calls before emitting requests (P2 #5): if the
    // provider returns a tool name that was not in the active tool set, fail
    // closed instead of waiting for the app to answer an unauthorized tool.
    const activeToolNames = new Set(state.activeTools.map((tool) => normalizeToolName(tool.name)));
    for (const call of result.toolCalls) {
      if (!activeToolNames.has(call.toolName)) {
        state.pendingToolCalls = [];
        state.toolAnswers = [];
        state.activeTools = [];
        offer(
          terminalEvent(
            options.instanceId,
            state,
            {
              kind: "failed",
              failure: {
                category: "protocol",
                message: `The provider requested an unsupported tool: ${call.toolName}.`,
              },
            },
            clock,
          ),
        );
        return;
      }
    }
    state.pendingToolCalls = result.toolCalls;
    // Clear tool answers from the previous round; the new tool-call requests
    // start a fresh tool phase. Prior tool results are already in history.
    state.toolAnswers = [];
    // Preserve the assistant tool-call message in history so continuation
    // requests include the model call that the tool answers respond to.
    state.history.push({ role: "assistant", text: result.text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      offer(toolRequestEvent(options.instanceId, state, call, clock));
    }
    // Do not emit a terminal: the turn stays in-flight until answerTool
    // completes the tool loop and produces the final completed/failed event.
  } else {
    // Tool results are already persisted in history by answerTool before
    // starting the continuation (P2 #2), so only append the final assistant
    // text and clear tool state here.
    const wasContinuation = state.toolAnswers.length > 0;
    state.pendingToolCalls = [];
    state.toolAnswers = [];
    state.activeTools = [];
    state.history.push({ role: "assistant", text: result.text });
    // Emit a final usage event with the accumulated total before the
    // completed terminal so consumers persist the full turn cost (P2 #9).
    // Only emit for continuation turns; single turns already emitted usage
    // during the stream and a duplicate would confuse consumers.
    if (
      wasContinuation &&
      (state.accumulatedInputTokens > 0 || state.accumulatedOutputTokens > 0)
    ) {
      offer(
        runtimeEvent(
          options.instanceId,
          state,
          {
            kind: "usage",
            sequence: state.nextSequence++,
            inputTokens: state.accumulatedInputTokens,
            outputTokens: state.accumulatedOutputTokens,
          },
          clock,
        ),
      );
    }
    offer(terminalEvent(options.instanceId, state, { kind: "completed" }, clock));
  }
  options.runtimeRegistry.setObservedState({
    instanceId: options.instanceId,
    readiness: current?.readiness ?? "degraded",
    processState: "stopped",
    observedProtocol: result.protocol,
    ...(authStrategyOf(options) !== "none" ? { credentialStatus: "stored" } : {}),
    models,
    capabilities: {
      ...initialCapabilities,
      streaming: result.protocol === "chat-completions" ? result.streaming : "supported",
      reasoning: result.reasoning.length > 0 ? "supported" : "unavailable",
      usage: result.usage === undefined ? "unavailable" : "supported",
      appManagedTools: stickyToolSupport,
    },
    ...(current?.message === undefined ? {} : { message: current.message }),
    ...(current?.verifiedToolModelIds === undefined
      ? {}
      : { verifiedToolModelIds: current.verifiedToolModelIds }),
    ...(current?.lastSuccessfulProbeAt === undefined
      ? {}
      : { lastSuccessfulProbeAt: current.lastSuccessfulProbeAt }),
    observedAt: clock(),
  });
}

function finishFailedTurn(
  instanceId: ProviderInstanceId,
  state: SessionState,
  failed: ProviderFailure,
  offer: (event: ProviderRuntimeEvent) => void,
  clock: () => string,
): void {
  // Clear pending tool state on failure (P2 #4): if the follow-up request
  // after answerTool fails, pendingToolCalls must be cleared so the .finally
  // guard in the turn chain cleans up inFlight and later send calls succeed.
  state.pendingToolCalls = [];
  state.toolAnswers = [];
  state.activeTools = [];
  offer(
    failed.category === "interrupted"
      ? terminalEvent(
          instanceId,
          state,
          { kind: "interrupted", message: "The provider request was cancelled." },
          clock,
        )
      : terminalEvent(instanceId, state, { kind: "failed", failure: failed }, clock),
  );
}

function runtimeEvent(
  instanceId: ProviderInstanceId,
  state: SessionState,
  event: ProtocolTurnEvent,
  clock: () => string,
): ProviderRuntimeEvent {
  return {
    ...event,
    instanceId,
    sessionId: state.sessionId,
    correlationId: state.correlationId,
    occurredAt: clock() as UtcTimestamp,
  } as ProviderRuntimeEvent;
}

function toolRequestEvent(
  instanceId: ProviderInstanceId,
  state: SessionState,
  call: ProtocolToolCall,
  clock: () => string,
): ProviderRuntimeEvent {
  return {
    kind: "tool-request",
    requestId: call.toolCallId,
    toolName: call.toolName,
    inputJson: call.argumentsJson,
    instanceId,
    sessionId: state.sessionId,
    sequence: state.nextSequence++,
    correlationId: state.correlationId,
    occurredAt: clock() as UtcTimestamp,
  } as ProviderRuntimeEvent;
}

function terminalEvent(
  instanceId: ProviderInstanceId,
  state: SessionState,
  terminal:
    | { readonly kind: "completed" }
    | { readonly kind: "interrupted"; readonly message: string }
    | { readonly kind: "failed"; readonly failure: ProviderFailure },
  clock: () => string,
): ProviderRuntimeEvent {
  return {
    ...terminal,
    instanceId,
    sessionId: state.sessionId,
    sequence: state.nextSequence++,
    correlationId: state.correlationId,
    occurredAt: clock() as UtcTimestamp,
  } as ProviderRuntimeEvent;
}

function authStrategyOf(options: OpenAiCompatibleDriverOptions): OpenAiCompatibleAuthStrategy {
  return options.profile?.authStrategy ?? options.configuration.authentication;
}

function endpointFor(
  options: OpenAiCompatibleDriverOptions,
  credentialResolver: ProviderCredentialResolver | undefined,
  profile: OpenAiCompatibleDriverProfile,
): OpenAiCompatibleEndpoint {
  return makeOpenAiCompatibleEndpoint({
    instanceId: options.instanceId,
    configuration: options.configuration,
    authStrategy: profile.authStrategy,
    ...(credentialResolver === undefined ? {} : { credentialResolver }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

// Probe tool support by sending a minimal turn with the
// octant_capability_echo tool (P2 #7). The probe uses the same protocol
// selection/fallback path as real turns (P2 #3) and forces tool use with
// tool_choice: "required" so a model that supports tools but would otherwise
// answer normally still proves tool support (P2 #4). Any failure or non-tool
// response leaves tool support at the default ("unsupported") so the probe
// never fails the whole provider setup just because tool calling is unavailable.
async function probeToolCapabilityForModel(
  options: OpenAiCompatibleDriverOptions,
  endpoint: OpenAiCompatibleEndpoint,
  modelId: ProviderModelId,
  propagateFailures = false,
): Promise<"supported" | "unsupported"> {
  const echoTool = capabilityEchoToolDefinition();
  const cache = {
    get: () => options.runtimeRegistry.compatibleProtocol(options.instanceId),
    set: (_instanceId: string, protocol: CompatibleProtocol) =>
      options.runtimeRegistry.setCompatibleProtocol(options.instanceId, protocol),
    delete: () => options.runtimeRegistry.clearCompatibleProtocol(options.instanceId),
    clear: () => options.runtimeRegistry.clearCompatibleProtocol(options.instanceId),
  };
  try {
    const result = await selectCompatibleProtocol({
      instanceId: options.instanceId,
      preference: options.configuration.protocol,
      cache,
      attempt: async (protocol): Promise<CompatibleProtocolAttemptResult<CompatibleTurnResult>> => {
        if (protocol === "chat-completions") {
          const exit = await Effect.runPromiseExit(
            sendChatCompletionsTurn({
              endpoint,
              modelId,
              history: [],
              prompt: "echo ready",
              tools: [echoTool],
              toolChoice: "required",
            }),
          );
          if (Exit.isSuccess(exit)) {
            return { ok: true, value: exit.value };
          }
          const typedFailure = Option.getOrUndefined(Cause.failureOption(exit.cause));
          return protocolFailure(typedFailure ?? exit.cause);
        }
        // Capture attempt metadata (httpStatus, accepted, outputStarted) via
        // onAttemptFailure so selectCompatibleProtocol can decide whether chat
        // fallback is permitted. Without httpStatus, a 404 from an endpoint
        // that only implements /chat/completions would not qualify for
        // fallback and Verify tools would report unsupported even though
        // chat-completions tool calling works.
        let metadata: ProtocolTurnFailureMetadata | undefined;
        const exit = await Effect.runPromiseExit(
          sendResponsesTurn({
            endpoint,
            modelId,
            history: [],
            prompt: "echo ready",
            tools: [echoTool],
            toolChoice: "required",
            onAttemptFailure: (value) => {
              metadata = value;
            },
          }),
        );
        if (Exit.isSuccess(exit)) {
          return { ok: true, value: exit.value };
        }
        const typedFailure = Option.getOrUndefined(Cause.failureOption(exit.cause));
        return protocolFailure(typedFailure ?? exit.cause, metadata);
      },
    });
    return result.terminal === "tool-calls" ? "supported" : "unsupported";
  } catch (error) {
    // When propagateFailures is set (explicit Verify tools action), surface
    // transport failures (auth, timeout, provider error) instead of
    // converting them into a "unsupported" capability result. The caller
    // maps these to a user-visible error.
    if (propagateFailures) throw error;
    return "unsupported";
  }
}

function protocolFailure(
  error: unknown,
  metadata?: ProtocolTurnFailureMetadata,
): {
  ok: false;
  failure: ProviderFailure;
  accepted: boolean;
  outputStarted: boolean;
  httpStatus?: number;
} {
  const failure = sanitizeFailure(error);
  return {
    ok: false,
    failure,
    accepted: metadata?.accepted ?? false,
    outputStarted: metadata?.outputStarted ?? false,
    ...(metadata?.httpStatus === undefined ? {} : { httpStatus: metadata.httpStatus }),
  };
}

async function resolveSessionCredential(
  options: OpenAiCompatibleDriverOptions,
  profile: OpenAiCompatibleDriverProfile,
): Promise<string | undefined> {
  if (profile.authStrategy === "none") return undefined;
  try {
    const credential = (await options.credentialResolver?.resolve(options.instanceId)) ?? "";
    if (credential.length === 0) throw new Error("missing");
    return credential;
  } catch {
    throw failure("unauthenticated", "The provider credential is missing or unavailable.");
  }
}

function manualModels(modelIds: readonly ProviderModelId[]) {
  return modelIds.map((id) => ({
    id,
    displayName: id,
    source: "manual" as const,
    verification: "unverified" as const,
    reasoning: "unavailable" as const,
    inputModalities: textOnlyInputModalities,
    options: [],
  }));
}

function assertTurnRequestConstructable(
  options: OpenAiCompatibleDriverOptions,
  state: SessionState,
  history: readonly ProtocolHistoryMessage[],
  prompt: string,
): void {
  const endpoint = state.endpoint;
  if (endpoint === undefined) throw failure("protocol", "Provider session is not active.");
  // Account for tool payloads in the size estimate (P2 #6): history can
  // contain toolResults entries and the active turn can include tool schemas,
  // both of which contribute to the real request body size.
  const messages = [
    ...history.flatMap((entry): Record<string, unknown>[] => {
      if (entry.toolResults !== undefined) {
        return entry.toolResults.map((result) => ({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: result.resultJson,
        }));
      }
      return [
        entry.toolCalls === undefined
          ? { role: entry.role, content: entry.text }
          : {
              role: entry.role,
              content: entry.text,
              tool_calls: entry.toolCalls.map((call) => ({
                id: call.toolCallId,
                type: "function",
                function: { name: call.toolName, arguments: call.argumentsJson },
              })),
            },
      ];
    }),
    { role: "user" as const, content: prompt },
  ];
  const selected =
    options.configuration.protocol === "auto"
      ? (options.runtimeRegistry.compatibleProtocol(options.instanceId) ?? "responses")
      : options.configuration.protocol;
  const toolsField =
    state.activeTools.length === 0
      ? {}
      : {
          tools: state.activeTools.map((tool) => ({
            type: "function",
            function: { name: tool.name },
          })),
        };
  const body =
    selected === "responses"
      ? { model: state.modelId, input: messages, stream: true, store: false, ...toolsField }
      : {
          model: state.modelId,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...toolsField,
        };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > endpoint.limits.requestBodyBytes) {
    throw failure(
      "invalid-configuration",
      "The provider request exceeded the configured size limit.",
    );
  }
}

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
