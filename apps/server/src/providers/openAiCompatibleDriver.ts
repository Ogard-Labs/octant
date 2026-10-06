import { chatCompletionsToolImages } from "./openAiToolEncoding";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  decodeProviderFailure,
  decodeProviderObservedState,
  type OctantMode,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderCapabilities,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderToolAnswer,
  type ProviderTurnInput,
  type UtcTimestamp,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  textOnlyInputModalities,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Option } from "effect";
import type { NativeHarnessEndpointHooks } from "../harness/nativeHarnessEndpointRegistry";
import { createNativeHarnessConnection } from "../harness/nativeHarnessLoop";
import type {
  NativeHarnessRequest,
  NativeHarnessStreamEvent,
  NativeHarnessTransport,
} from "../harness/nativeHarnessTransport";
import {
  MemoryNativeHarnessTranscriptStore,
  type NativeHarnessTranscriptStore,
} from "../harness/nativeHarnessTranscriptStore";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { sendWithEndpointRetry } from "./endpointRetry";
import { runProviderEffect } from "./runProviderEffect";
import {
  directEndpointRequestResolver,
  honestDirectEndpointCapabilities,
  inspectDirectEndpointCredential,
} from "./directEndpointSubscriptionOAuth";
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
  type ProtocolTurnEvent,
  type ProtocolTurnFailureMetadata,
  type ProtocolTurnResult,
} from "./openAiResponses";
import { capabilityEchoToolDefinition, isCapabilityEchoToolCall } from "./openAiToolEncoding";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import type { SubscriptionOAuthHost } from "@octant/provider-sdk/subscription-oauth";

const initialCapabilities: ProviderCapabilities = {
  streaming: "unavailable",
  resume: "supported",
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
  harnessAutoReview: "unsupported",
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
  /**
   * Where harness sessions keep their conversation. Shared by every
   * connection of this driver, so a later turn can resume what an earlier
   * one started; the server passes the journal-backed store.
   */
  readonly transcripts?: NativeHarnessTranscriptStore;
  /** How the harness retries this endpoint and where its lead goes when it stays down. */
  readonly harness?: NativeHarnessEndpointHooks;
  /**
   * Host refresh and access for a subscription-oauth credential. Absent means
   * a stored pointer cannot be used; it is never sent as an API key.
   */
  readonly subscriptionOAuth?: SubscriptionOAuthHost;
}

type CompatibleTurnResult = ProtocolTurnResult | ChatCompletionsTurnResult;

export function makeOpenAiCompatibleDriver(options: OpenAiCompatibleDriverOptions): ProviderDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? randomUUID;
  const profile: OpenAiCompatibleDriverProfile = options.profile ?? {
    driverKind: "openai-compatible",
    authStrategy: options.configuration.authentication,
  };
  const transcripts = options.transcripts ?? new MemoryNativeHarnessTranscriptStore();
  const transport = openAiCompatibleTransport(options, profile, clock);
  options.harness?.endpoints?.register(options.instanceId, {
    open: transport.open,
    admitTurn: (turn, modelId) => admitTurn(options, turn, modelId),
  });
  return {
    kind: profile.driverKind,
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              const observedAt = clock() as UtcTimestamp;
              const gate = await inspectDirectEndpointCredential({
                authentication: profile.authStrategy,
                expectedDescriptorId: options.configuration.oauthDescriptorId,
                credentialResolver: options.credentialResolver,
                instanceId,
                host: options.subscriptionOAuth,
                now: () => Date.parse(observedAt),
                baseUrl: options.configuration.baseUrl,
              });
              if (gate.kind === "report") {
                const refused = decodeProviderObservedState({
                  instanceId,
                  readiness: gate.readiness,
                  processState: "stopped",
                  credentialStatus: gate.credentialStatus,
                  models: [],
                  capabilities: honestDirectEndpointCapabilities,
                  message: gate.message,
                  observedAt,
                });
                options.runtimeRegistry.setObservedState(refused);
                return refused;
              }
              const plainCredential = gate.kind === "plain" ? gate.credential : undefined;
              const endpoint = endpointFor(
                options,
                gate.kind === "oauth"
                  ? directEndpointRequestResolver(oauthResolverInput(options, profile, clock))
                  : plainCredential !== undefined && plainCredential.length > 0
                    ? { has: async () => true, resolve: async () => plainCredential }
                    : options.credentialResolver,
                profile,
              );
              const result = await probeModels(endpoint);
              // Do NOT run a generating tool-echo turn during routine probes:
              // ChatService.#prepareTurnExecution calls driver.probe() before
              // every Chat turn, so a probe-time tool echo would add an
              // unadvertised paid request per turn and would only test the
              // first listed model while setting the provider-level
              // appManagedTools flag, enabling tools for unverified models.
              // Tool support is gated on per-model verification instead: a
              // person's "Verify tools" request records the model in
              // verifiedToolModelIds, which outlives this probe. The
              // provider-level flag stays "unsupported" so one verified model
              // never unlocks tools for the other models of the profile.
              const priorVerified =
                options.runtimeRegistry.observedState(instanceId)?.verifiedToolModelIds;
              const probe = decodeProviderObservedState({
                instanceId,
                readiness: result.readiness,
                processState: "stopped",
                ...(profile.authStrategy !== "none" ? { credentialStatus: "stored" } : {}),
                models: result.models,
                capabilities: initialCapabilities,
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
              const endpoint = endpointFor(
                options,
                directEndpointRequestResolver(oauthResolverInput(options, profile, clock)),
                profile,
              );
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
    acquire: ({ instanceId, projectRoot, mode }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : !isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot
          ? Effect.fail(
              failure(
                "invalid-configuration",
                "Provider Project root must be an absolute normalized path.",
              ),
            )
          : makeConnection(options, profile, transport, clock, makeCorrelation, transcripts, {
              projectRoot,
              mode: mode ?? "chat",
            }),
  };
}

function makeConnection(
  options: OpenAiCompatibleDriverOptions,
  profile: OpenAiCompatibleDriverProfile,
  transport: NativeHarnessTransport,
  clock: () => string,
  makeCorrelation: () => string,
  transcripts: NativeHarnessTranscriptStore,
  input: { readonly projectRoot: string; readonly mode: OctantMode },
): Effect.Effect<ProviderConnection, never, import("effect").Scope.Scope> {
  return createNativeHarnessConnection({
    instanceId: options.instanceId,
    driverKind: profile.driverKind,
    projectRoot: input.projectRoot,
    mode: input.mode,
    transport,
    transcripts,
    ...(options.harness?.leadFallback === undefined
      ? {}
      : { leadFallback: options.harness.leadFallback }),
    admitTurn: (turn, modelId) => admitTurn(options, turn, modelId),
    onSessionCountChange: (delta) =>
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        Math.max(0, options.runtimeRegistry.activeSessionCount(options.instanceId) + delta),
      ),
    ...(options.onConnectionReleased === undefined
      ? {}
      : { onReleased: options.onConnectionReleased }),
    clock,
    correlationId: makeCorrelation,
  });
}

/** Whether the endpoint accepts this turn's input for the session's model. */
function admitTurn(
  options: OpenAiCompatibleDriverOptions,
  input: ProviderTurnInput,
  modelId: ProviderModelId,
): ProviderFailure | undefined {
  const observed = options.runtimeRegistry.observedState(options.instanceId);
  const model = observed?.models.find((candidate) => candidate.id === modelId);
  const isCapabilityEchoProbe =
    input.tools.length > 0 && input.tools.every((tool) => isCapabilityEchoToolCall(tool.name));
  // Tool support is verified per model through the verify-model-tools command,
  // and the sender gates tool requests on the per-model verifiedToolModelIds
  // set alone, so one verified model does not unlock tools for the other
  // models of the same profile.
  const isVerifiedModel =
    observed?.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) ?? false;
  const effectiveCapabilities = {
    ...(observed?.capabilities ?? initialCapabilities),
    appManagedTools:
      isCapabilityEchoProbe || isVerifiedModel ? ("supported" as const) : ("unsupported" as const),
  };
  return validateChatTurnInput(input, effectiveCapabilities, model);
}

/**
 * The endpoint as the harness loop sees it: one request at a time over
 * whichever OpenAI protocol the endpoint speaks, plus what each response
 * teaches the registry about the model.
 */
function openAiCompatibleTransport(
  options: OpenAiCompatibleDriverOptions,
  profile: OpenAiCompatibleDriverProfile,
  clock: () => string,
): NativeHarnessTransport {
  return {
    open: async () => {
      const observedAt = clock();
      const gate = await inspectDirectEndpointCredential({
        authentication: profile.authStrategy,
        expectedDescriptorId: options.configuration.oauthDescriptorId,
        credentialResolver: options.credentialResolver,
        instanceId: options.instanceId,
        host: options.subscriptionOAuth,
        now: () => Date.parse(observedAt),
        baseUrl: options.configuration.baseUrl,
      });
      if (gate.kind === "report") throw failure(gate.readiness, gate.message);
      const plainCredential = gate.kind === "plain" ? gate.credential : undefined;
      if (
        profile.authStrategy !== "none" &&
        (plainCredential === undefined || plainCredential.length === 0) &&
        gate.kind !== "oauth"
      ) {
        throw failure("unauthenticated", "The provider credential is missing or unavailable.");
      }
      const resolver =
        gate.kind === "oauth"
          ? directEndpointRequestResolver(oauthResolverInput(options, profile, clock))
          : plainCredential !== undefined && plainCredential.length > 0
            ? { has: async () => true, resolve: async () => plainCredential }
            : undefined;
      let endpoint: OpenAiCompatibleEndpoint | undefined = endpointFor(options, resolver, profile);
      return {
        fits: (request) => endpoint !== undefined && requestFits(options, endpoint, request),
        send: async (request, stream) => {
          const active = endpoint;
          if (active === undefined) throw failure("protocol", "Provider session is not active.");
          return sendWithEndpointRetry({
            signal: stream.signal,
            onEvent: stream.onEvent,
            options: options.harness?.retry,
            attempt: async (attempt) => {
              const result = await sendCompatibleRequest(options, active, request, attempt);
              recordObservedTurn(options, result, clock);
              return {
                text: result.text,
                toolCalls: result.toolCalls,
                ...(result.usage === undefined ? {} : { usage: result.usage }),
                ...(result.rateLimitBuckets === undefined
                  ? {}
                  : { rateLimitBuckets: result.rateLimitBuckets }),
              };
            },
          });
        },
        release: () => {
          endpoint = undefined;
        },
      };
    },
  };
}

/**
 * The wire split both OpenAI protocols expect: a trailing plain user message
 * is the turn's prompt, and a trailing results message continues a tool loop.
 * Results are sent once, from the conversation; passing them again as answers
 * would encode every result twice.
 */
function protocolInput(request: NativeHarnessRequest): {
  readonly history: readonly ProtocolHistoryMessage[];
  readonly prompt: string;
  readonly toolAnswers: readonly ProviderToolAnswer[] | undefined;
} {
  const last = request.history.at(-1);
  if (last?.role === "user" && last.toolResults === undefined) {
    return {
      history: request.history.slice(0, -1),
      prompt: last.text,
      toolAnswers: undefined,
    };
  }
  return {
    history: request.history,
    prompt: "",
    toolAnswers: [],
  };
}

async function sendCompatibleRequest(
  options: OpenAiCompatibleDriverOptions,
  endpoint: OpenAiCompatibleEndpoint,
  request: NativeHarnessRequest,
  stream: {
    readonly signal: AbortSignal;
    readonly onEvent: (event: NativeHarnessStreamEvent) => void;
  },
): Promise<CompatibleTurnResult> {
  const { history, prompt, toolAnswers } = protocolInput(request);
  const onEvent = (event: ProtocolTurnEvent) => {
    // Tool calls arrive on the result; the loop asks for them as a step.
    if (event.kind === "tool-call") return;
    if (event.kind === "usage") {
      const { sequence: _sequence, ...usage } = event;
      stream.onEvent(usage);
      return;
    }
    stream.onEvent({ kind: event.kind, text: event.text });
  };
  const shared = {
    endpoint,
    modelId: request.modelId,
    history,
    prompt,
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools.length === 0 ? {} : { tools: request.tools }),
    ...(toolAnswers === undefined ? {} : { toolAnswers }),
    signal: stream.signal,
    onEvent,
  };
  const { signal } = stream;
  return selectCompatibleProtocol({
    instanceId: options.instanceId,
    preference: options.configuration.protocol,
    cache: protocolCache(options),
    attempt: async (protocol): Promise<CompatibleProtocolAttemptResult<CompatibleTurnResult>> => {
      if (protocol === "chat-completions") {
        try {
          return { ok: true, value: await runProviderEffect(sendChatCompletionsTurn(shared)) };
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
          value: await runProviderEffect(
            sendResponsesTurn({
              ...shared,
              // One stable key per harness session, so every step of the
              // conversation is routed to the same prompt cache.
              promptCacheKey: String(request.sessionId),
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

function protocolCache(options: OpenAiCompatibleDriverOptions) {
  return {
    get: () => options.runtimeRegistry.compatibleProtocol(options.instanceId),
    set: (_instanceId: string, protocol: CompatibleProtocol) =>
      options.runtimeRegistry.setCompatibleProtocol(options.instanceId, protocol),
    delete: () => options.runtimeRegistry.clearCompatibleProtocol(options.instanceId),
    clear: () => options.runtimeRegistry.clearCompatibleProtocol(options.instanceId),
  };
}

/** What a successful response proves about the endpoint and its model. */
function recordObservedTurn(
  options: OpenAiCompatibleDriverOptions,
  result: CompatibleTurnResult,
  clock: () => string,
): void {
  const current = options.runtimeRegistry.observedState(options.instanceId);
  const models = markCompatibleModelVerified(
    current?.models ?? manualModels(options.configuration.manualModelIds),
    result.verifiedManualModelId ?? "",
  );
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

function oauthResolverInput(
  options: OpenAiCompatibleDriverOptions,
  profile: OpenAiCompatibleDriverProfile,
  clock: () => string,
) {
  return {
    authentication: profile.authStrategy,
    expectedDescriptorId: options.configuration.oauthDescriptorId,
    credentialResolver: options.credentialResolver,
    instanceId: options.instanceId,
    host: options.subscriptionOAuth,
    now: () => Date.parse(clock()),
    baseUrl: options.configuration.baseUrl,
  };
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

/**
 * Whether a request fits the endpoint as the selected protocol would send it.
 * The measured body carries the system prompt, every message including tool
 * payloads, and the tool schemas, so the estimate matches the real request.
 */
function requestFits(
  options: OpenAiCompatibleDriverOptions,
  endpoint: OpenAiCompatibleEndpoint,
  request: NativeHarnessRequest,
): boolean {
  const messages = [
    ...(request.system === undefined ? [] : [{ role: "system", content: request.system }]),
    ...request.history.flatMap((entry): Record<string, unknown>[] => {
      if (entry.toolResults !== undefined) {
        return [
          ...entry.toolResults.map((result) => ({
            role: "tool",
            tool_call_id: result.toolCallId,
            content: result.resultJson,
          })),
          ...chatCompletionsToolImages(entry.toolResults),
        ];
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
  ];
  const tools =
    request.tools.length === 0
      ? {}
      : { tools: request.tools.map((tool) => ({ type: "function", function: tool })) };
  const body = { model: request.modelId, messages, stream: true, ...tools };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > endpoint.limits.requestBodyBytes) {
    return false;
  }
  const contextLimit = options.runtimeRegistry
    .observedState(options.instanceId)
    ?.models.find((model) => String(model.id) === String(request.modelId))?.contextLimit;
  // Roughly four bytes per token; only a model whose window is known is held to it.
  return contextLimit === undefined || JSON.stringify(body).length / 4 <= contextLimit;
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
