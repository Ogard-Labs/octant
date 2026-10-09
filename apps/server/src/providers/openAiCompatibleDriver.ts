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
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Option } from "effect";
import {
  resolveModelContextWindow,
  resolveModelInputModalities,
} from "@octant/domain/model-context-window";
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
import { chatGptPlanModelsListing, isChatGptPlanDescriptor } from "./chatGptPlanProfile";
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
import {
  carryModelContextWindowFacts,
  learnFromEndpointRequest,
  type EndpointRequestOutcome,
} from "./modelContextWindowFacts";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import type { SubscriptionOAuthHost } from "@octant/provider-sdk/subscription-oauth";

/** The request profile the resolved credential selects, when it selects one. */
type CompatiblePlanProfile = "chatgpt-plan" | undefined;

function planProfileOf(options: OpenAiCompatibleDriverOptions): CompatiblePlanProfile {
  return isChatGptPlanDescriptor(options.configuration.oauthDescriptorId)
    ? "chatgpt-plan"
    : undefined;
}

/**
 * The ChatGPT plan route speaks only the Responses protocol: its fixed wire
 * contract (`store:false`, `stream:true`, Responses input shape) cannot be
 * expressed as a Chat Completions request. Refusing here, before anything
 * leaves the process, keeps the module's guarantee that an unexpressible
 * request is typed and refused rather than sent under a protocol the plan
 * does not cover.
 */
function refuseChatCompletionsUnderPlan(
  profile: CompatiblePlanProfile,
  protocol: CompatibleProtocol,
): ProviderFailure | undefined {
  if (profile !== "chatgpt-plan" || protocol !== "chat-completions") return undefined;
  return failure("unsupported", "The ChatGPT plan route supports only the Responses API.");
}

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
              // The plan route may not enumerate models; its profile reads that
              // answer as an honest "cannot list" state instead of a failure.
              const result = await probeModels(
                endpoint,
                undefined,
                planProfileOf(options) === "chatgpt-plan" ? chatGptPlanModelsListing : undefined,
              );
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
              const prior = options.runtimeRegistry.observedState(instanceId);
              const priorVerified = prior?.verifiedToolModelIds;
              const probe = decodeProviderObservedState({
                instanceId,
                readiness: result.readiness,
                processState: "stopped",
                ...(profile.authStrategy !== "none" ? { credentialStatus: "stored" } : {}),
                // What requests taught about each model's window, and a
                // person's override, outlive the probe a Chat turn runs first.
                models: carryModelContextWindowFacts(result.models, prior?.models),
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
                planProfileOf(options),
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
      // The ChatGPT plan request profile applies when the resolved
      // credential's descriptor is the plan offer; plan usage is disabled
      // when the sign-in did not grant use of the subscription.
      const planProfile = planProfileOf(options);
      const subscriptionUsageGranted =
        gate.kind === "oauth" ? gate.subscriptionUsageGranted : undefined;
      // What each protocol's last successful call measured and billed. A
      // responses token count must not calibrate a request automatic mode may
      // send as chat completions.
      const calibration: Partial<Record<CompatibleProtocol, ObservedRequestCalibration>> = {};
      return {
        fits: (request) =>
          endpoint !== undefined && requestFits(options, endpoint, request, calibration),
        send: async (request, stream) => {
          const active = endpoint;
          if (active === undefined) throw failure("protocol", "Provider session is not active.");
          const learn = (outcome: EndpointRequestOutcome) =>
            learnFromEndpointRequest({
              runtimeRegistry: options.runtimeRegistry,
              instanceId: options.instanceId,
              modelId: request.modelId,
              outcome,
              memory: options.harness?.contextWindows,
            });
          return sendWithEndpointRetry({
            signal: stream.signal,
            onEvent: stream.onEvent,
            options: options.harness?.retry,
            attempt: async (attempt) => {
              let result: CompatibleTurnResult;
              try {
                result = await sendCompatibleRequest(options, active, request, attempt, {
                  profile: planProfile,
                  subscriptionUsageGranted,
                });
              } catch (error) {
                // Learned before the harness shrinks and resends, so the
                // shrink is measured against the window the endpoint named.
                learn({ kind: "refused", failure: sanitizeFailure(error) });
                throw error;
              }
              recordObservedTurn(options, result, clock);
              learn({
                kind: "completed",
                servedModelId: result.servedModelId,
                usedTokens:
                  result.usage === undefined
                    ? undefined
                    : result.usage.inputTokens + result.usage.outputTokens,
              });
              if (result.usage !== undefined && result.usage.inputTokens > 0) {
                calibration[result.protocol] = {
                  measured: JSON.stringify(estimateBody(request, result.protocol)).length,
                  tokens: result.usage.inputTokens,
                };
              }
              return {
                text: result.text,
                toolCalls: result.toolCalls,
                ...(result.usage === undefined ? {} : { usage: result.usage }),
                ...(result.rateLimitBuckets === undefined
                  ? {}
                  : { rateLimitBuckets: result.rateLimitBuckets }),
                ...(result.outputStopReason === undefined
                  ? {}
                  : { outputStopReason: result.outputStopReason }),
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
  plan: {
    readonly profile: "chatgpt-plan" | undefined;
    readonly subscriptionUsageGranted: boolean | undefined;
  } = { profile: undefined, subscriptionUsageGranted: undefined },
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
    ...(plan.profile === undefined ? {} : { profile: plan.profile }),
    ...(plan.subscriptionUsageGranted === undefined
      ? {}
      : { subscriptionUsageGranted: plan.subscriptionUsageGranted }),
    signal: stream.signal,
    onEvent,
  };
  const { signal } = stream;
  return selectCompatibleProtocol({
    instanceId: options.instanceId,
    preference: options.configuration.protocol,
    cache: protocolCache(options),
    attempt: async (protocol): Promise<CompatibleProtocolAttemptResult<CompatibleTurnResult>> => {
      // The plan profile never speaks Chat Completions: an explicit
      // chat-completions preference, or an auto fallback onto it, is refused
      // before anything leaves the process.
      const refusal = refuseChatCompletionsUnderPlan(plan.profile, protocol);
      if (refusal !== undefined) {
        return { ok: false, failure: refusal, accepted: false, outputStarted: false };
      }
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
  profile: CompatiblePlanProfile = undefined,
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
        // The probe speaks only the protocols the active request profile
        // permits; the ChatGPT plan route supports only Responses, and its
        // usage refusal must be checked by the Responses sender too.
        const refusal = refuseChatCompletionsUnderPlan(profile, protocol);
        if (refusal !== undefined) {
          return { ok: false, failure: refusal, accepted: false, outputStarted: false };
        }
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
            ...(profile === undefined ? {} : { profile }),
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
    ...resolveModelInputModalities({ id: String(id) }),
    options: [],
  }));
}

/**
 * Whether a request fits the endpoint as the protocol that may be sent would
 * send it. The measured body carries the system prompt, every message including
 * tool payloads, and the tool schemas, so the estimate matches that protocol.
 *
 * When the last call on that protocol reported how many input tokens it billed,
 * that figure calibrates the measurement. Automatic mode may abandon a cached
 * responses route for chat completions, so that decision uses the chat estimate
 * and the chat calibration — never a ratio learned from a responses call.
 */
function requestFits(
  options: OpenAiCompatibleDriverOptions,
  endpoint: OpenAiCompatibleEndpoint,
  request: NativeHarnessRequest,
  calibration: Partial<Record<CompatibleProtocol, ObservedRequestCalibration>>,
): boolean {
  const body = compatibleEstimateBody(request);
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > endpoint.limits.requestBodyBytes) {
    return false;
  }
  const model = options.runtimeRegistry
    .observedState(options.instanceId)
    ?.models.find((candidate) => String(candidate.id) === String(request.modelId));
  const contextLimit =
    model === undefined ? undefined : resolveModelContextWindow(model)?.contextWindow;
  if (contextLimit === undefined) return true;
  return contextProtocols(options).every((protocol) =>
    contextEstimateFits(request, protocol, calibration[protocol], contextLimit),
  );
}

/**
 * The protocol a pre-send context check can honestly judge. A fixed preference
 * is only itself. Automatic mode may still switch a cached responses route to
 * chat completions, so the check judges the chat estimate.
 */
function contextProtocols(options: OpenAiCompatibleDriverOptions): readonly CompatibleProtocol[] {
  const preference = options.configuration.protocol;
  if (preference === "chat-completions" || preference === "responses") return [preference];
  return ["chat-completions"];
}

function contextEstimateFits(
  request: NativeHarnessRequest,
  protocol: CompatibleProtocol,
  calibration: ObservedRequestCalibration | undefined,
  contextLimit: number,
): boolean {
  const measured = JSON.stringify(estimateBody(request, protocol)).length;
  const bytesPerToken =
    calibration !== undefined && calibration.tokens > 0 && calibration.measured > 0
      ? calibration.measured / calibration.tokens
      : 4;
  return measured / bytesPerToken <= contextLimit;
}

/** The bytes one call measured and the input tokens the endpoint billed for it. */
interface ObservedRequestCalibration {
  readonly measured: number;
  readonly tokens: number;
}

function estimateBody(
  request: NativeHarnessRequest,
  protocol: CompatibleProtocol,
): Record<string, unknown> {
  return protocol === "responses"
    ? responsesEstimateBody(request)
    : compatibleEstimateBody(request);
}

/**
 * The same responses-shaped proxy a calibration measurement and a later fit
 * check share. It is not the wire body; both sides must use this function so
 * a responses token count is never paired with a chat-completions estimate.
 */
function responsesEstimateBody(request: NativeHarnessRequest): Record<string, unknown> {
  const { history, prompt, toolAnswers } = protocolInput(request);
  const includeUserPrompt = !(prompt.length === 0 && toolAnswers !== undefined);
  const input = [
    ...history.flatMap((entry) => {
      if (entry.toolResults !== undefined && entry.toolCalls === undefined) {
        return entry.toolResults.map((result) => ({
          type: "function_call_output" as const,
          call_id: result.toolCallId,
          output: result.resultJson,
        }));
      }
      return [
        { role: entry.role, content: entry.text },
        ...(entry.toolCalls === undefined
          ? []
          : entry.toolCalls.map((call) => ({
              type: "function_call" as const,
              call_id: call.toolCallId,
              name: call.toolName,
              arguments: call.argumentsJson,
            }))),
        ...(entry.toolResults === undefined
          ? []
          : entry.toolResults.map((result) => ({
              type: "function_call_output" as const,
              call_id: result.toolCallId,
              output: result.resultJson,
            }))),
      ];
    }),
    ...(includeUserPrompt ? [{ role: "user" as const, content: prompt }] : []),
    ...(toolAnswers === undefined
      ? []
      : toolAnswers.map((answer) => ({
          type: "function_call_output" as const,
          call_id: answer.requestId,
          output: answer.resultJson,
        }))),
  ];
  return {
    model: request.modelId,
    ...(request.system === undefined ? {} : { instructions: request.system }),
    input,
    stream: true,
    store: false,
    prompt_cache_key: String(request.sessionId),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            parameters: tool.inputSchema,
          })),
        }),
  };
}

function compatibleEstimateBody(request: NativeHarnessRequest): Record<string, unknown> {
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
  return { model: request.modelId, messages, stream: true, ...tools };
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
