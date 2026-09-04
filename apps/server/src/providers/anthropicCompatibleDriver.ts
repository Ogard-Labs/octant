import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  decodeProviderFailure,
  decodeProviderObservedState,
  type AnthropicCompatibleProviderConfiguration,
  type CorrelationId,
  type ProviderCapabilities,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
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
import { Effect, PubSub, Stream } from "effect";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  makeAnthropicCompatibleEndpoint,
  markAnthropicModelVerified,
  probeAnthropicModels,
  type AnthropicCompatibleEndpoint,
  type AnthropicCompatibleFetch,
} from "./anthropicCompatibleEndpoint";
import {
  sendAnthropicMessagesTurn,
  type AnthropicHistoryMessage,
  type AnthropicTurnEvent,
  type AnthropicTurnResult,
} from "./anthropicMessages";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import type { ObservedRateLimitBucket } from "./rateLimitHeaders";

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

export interface AnthropicCompatibleDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: AnthropicCompatibleProviderConfiguration;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: AnthropicCompatibleFetch;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly onConnectionReleased?: () => void;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
  readonly correlationId: CorrelationId;
  endpoint: AnthropicCompatibleEndpoint | undefined;
  readonly history: AnthropicHistoryMessage[];
  nextSequence: number;
  inFlight: Promise<void> | undefined;
  abortController: AbortController | undefined;
  active: boolean;
  stopped: boolean;
}

export function makeAnthropicCompatibleDriver(
  options: AnthropicCompatibleDriverOptions,
): ProviderDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? randomUUID;
  return {
    kind: "anthropic-compatible",
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              const endpoint = endpointFor(options, options.credentialResolver);
              const result = await probeAnthropicModels(endpoint);
              const observedAt = clock() as UtcTimestamp;
              const probe = decodeProviderObservedState({
                instanceId,
                readiness: result.readiness,
                processState: "stopped",
                ...(options.configuration.authentication !== "none"
                  ? { credentialStatus: "stored" }
                  : {}),
                models: result.models,
                capabilities: initialCapabilities,
                ...(result.failure === undefined ? {} : { message: result.failure.message }),
                lastSuccessfulProbeAt: observedAt,
                observedAt,
              });
              options.runtimeRegistry.setObservedState(probe);
              return probe;
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
          : makeConnection(options, clock, makeCorrelation),
  };
}

function makeConnection(
  options: AnthropicCompatibleDriverOptions,
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
            const credential = await resolveSessionCredential(options);
            const endpoint = endpointFor(
              options,
              credential === undefined
                ? undefined
                : { has: async () => true, resolve: async () => credential },
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
            const rejected = validateChatTurnInput(
              input,
              observed?.capabilities ?? initialCapabilities,
              model,
            );
            if (rejected !== undefined) throw rejected;
            const controller = new AbortController();
            const started = deferred();
            const priorHistory = state.history.slice();
            const prompt = renderProviderTurnPrompt(input);
            assertTurnRequestConstructable(options, state, priorHistory, prompt);
            state.abortController = controller;
            state.history.push({ role: "user", text: prompt });
            const turn = runTurn(
              options,
              state,
              priorHistory,
              prompt,
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
      answerTool: () => unsupportedAnswerTool(initialCapabilities.appManagedTools),
    };
  });
}

async function runTurn(
  options: AnthropicCompatibleDriverOptions,
  state: SessionState,
  history: readonly AnthropicHistoryMessage[],
  prompt: string,
  signal: AbortSignal,
  offer: (event: ProviderRuntimeEvent) => void,
  clock: () => string,
  started: () => void,
): Promise<AnthropicTurnResult> {
  const endpoint = state.endpoint;
  if (endpoint === undefined) throw failure("protocol", "Provider session is not active.");
  const onEvent = (event: AnthropicTurnEvent) => {
    state.nextSequence = event.sequence + 1;
    offer(runtimeEvent(options.instanceId, state, event, clock));
  };
  started();
  try {
    return await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint,
        modelId: state.modelId,
        history,
        prompt,
        sequenceStart: state.nextSequence,
        signal,
        onEvent,
      }),
    );
  } catch (error) {
    if (signal.aborted) throw failure("interrupted", "The provider request was cancelled.");
    throw error;
  }
}

function finishSuccessfulTurn(
  options: AnthropicCompatibleDriverOptions,
  state: SessionState,
  result: AnthropicTurnResult,
  offer: (event: ProviderRuntimeEvent) => void,
  clock: () => string,
): void {
  // Header buckets go out first: they describe the account after this
  // response, and a consumer that stops at the terminal event still sees them.
  for (const bucket of result.rateLimitBuckets ?? []) {
    offer(rateLimitBucketEvent(options.instanceId, state, bucket, clock));
  }
  state.history.push({ role: "assistant", text: result.text });
  const current = options.runtimeRegistry.observedState(options.instanceId);
  const models = markAnthropicModelVerified(
    current?.models ?? manualModels(options.configuration.manualModelIds),
    result.verifiedManualModelId ?? "",
  );
  options.runtimeRegistry.setObservedState({
    instanceId: options.instanceId,
    readiness: current?.readiness ?? "degraded",
    processState: "stopped",
    ...(options.configuration.authentication !== "none" ? { credentialStatus: "stored" } : {}),
    models,
    capabilities: {
      ...initialCapabilities,
      streaming: "supported",
      reasoning: result.reasoning.length > 0 ? "supported" : "unavailable",
      usage: result.usage === undefined ? "unavailable" : "supported",
    },
    ...(current?.message === undefined ? {} : { message: current.message }),
    ...(current?.lastSuccessfulProbeAt === undefined
      ? {}
      : { lastSuccessfulProbeAt: current.lastSuccessfulProbeAt }),
    observedAt: clock(),
  });
  offer(terminalEvent(options.instanceId, state, { kind: "completed" }, clock));
}

function finishFailedTurn(
  instanceId: ProviderInstanceId,
  state: SessionState,
  failed: ProviderFailure,
  offer: (event: ProviderRuntimeEvent) => void,
  clock: () => string,
): void {
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
  event: AnthropicTurnEvent,
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

function rateLimitBucketEvent(
  instanceId: ProviderInstanceId,
  state: SessionState,
  bucket: ObservedRateLimitBucket,
  clock: () => string,
): ProviderRuntimeEvent {
  return {
    kind: "rate-limit-bucket",
    ...bucket,
    instanceId,
    sessionId: state.sessionId,
    sequence: state.nextSequence++,
    correlationId: state.correlationId,
    occurredAt: clock() as UtcTimestamp,
  } as ProviderRuntimeEvent;
}

function endpointFor(
  options: AnthropicCompatibleDriverOptions,
  credentialResolver: ProviderCredentialResolver | undefined,
): AnthropicCompatibleEndpoint {
  return makeAnthropicCompatibleEndpoint({
    instanceId: options.instanceId,
    configuration: options.configuration,
    ...(credentialResolver === undefined ? {} : { credentialResolver }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

async function resolveSessionCredential(
  options: AnthropicCompatibleDriverOptions,
): Promise<string | undefined> {
  if (options.configuration.authentication === "none") return undefined;
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
  options: AnthropicCompatibleDriverOptions,
  state: SessionState,
  history: readonly AnthropicHistoryMessage[],
  prompt: string,
): void {
  const endpoint = state.endpoint;
  if (endpoint === undefined) throw failure("protocol", "Provider session is not active.");
  const body = {
    model: state.modelId,
    messages: [
      ...history.map(({ role, text }) => ({ role, content: text })),
      { role: "user" as const, content: prompt },
    ],
    stream: true,
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
