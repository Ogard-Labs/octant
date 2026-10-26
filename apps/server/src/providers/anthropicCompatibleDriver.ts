import {
  decodeProviderFailure,
  decodeProviderObservedState,
  type AnthropicCompatibleProviderConfiguration,
  type ProviderCapabilities,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderTurnInput,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import type {
  HarnessEndpointDriver,
  HarnessEndpointRequest,
  HarnessEndpointTransport,
} from "@octant/provider-sdk/harness-endpoint";
import { Effect } from "effect";
import {
  resolveModelContextWindow,
  resolveModelInputModalities,
} from "@octant/domain/model-context-window";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { runProviderEffect } from "./runProviderEffect";
import { capabilityEchoToolDefinition, isCapabilityEchoToolCall } from "./openAiToolEncoding";
import {
  directEndpointRequestResolver,
  honestDirectEndpointCapabilities,
  inspectDirectEndpointCredential,
} from "./directEndpointSubscriptionOAuth";
import {
  makeAnthropicCompatibleEndpoint,
  markAnthropicModelVerified,
  probeAnthropicModels,
  type AnthropicCompatibleEndpoint,
  type AnthropicCompatibleFetch,
} from "./anthropicCompatibleEndpoint";
import {
  buildAnthropicMessagesBody,
  sendAnthropicMessagesTurn,
  type AnthropicTurnEvent,
  type AnthropicTurnResult,
} from "./anthropicMessages";
import { carryModelContextWindowFacts } from "./modelContextWindowFacts";
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
  // appManagedTools stays "unsupported" for the whole endpoint. Every server
  // tool gate reads "provider flag supported, or this model verified", so a
  // provider-level "supported" offered Octant tools to every model the
  // endpoint routes, including ones that answer a tool call in text. Tools
  // follow a person's per-model Verify tools result (verifiedToolModelIds).
  // Octant Harness keeps a Code session's transcript and compacts it. Chat and
  // Work continue their journaled session too, but the host plans and compacts
  // their history and rebuilds a fresh session from it after a compaction.
  sessionCompaction: { chat: "unsupported", work: "unsupported", code: "supported" },
  ...unsupportedChatCapabilities,
};

export interface AnthropicCompatibleDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: AnthropicCompatibleProviderConfiguration;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: AnthropicCompatibleFetch;
  readonly clock?: () => string;
  /** Host refresh and access for a subscription-oauth credential. */
  readonly subscriptionOAuth?: SubscriptionOAuthHost;
}

/**
 * An Anthropic-compatible Messages endpoint as an Octant Harness endpoint,
 * through the provider-sdk harness endpoint port. The host's harness loop owns
 * the conversation, every tool call, retries, and what each request teaches
 * about its model's window; this driver supplies one request attempt, its
 * credential gate, and the per-model Verify tools check.
 */
export function makeAnthropicCompatibleDriver(
  options: AnthropicCompatibleDriverOptions,
): HarnessEndpointDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    kind: "anthropic-compatible",
    harnessEndpoint: {
      ...anthropicCompatibleTransport(options, clock),
      admitTurn: (turn, modelId) => admitTurn(options, turn, modelId),
    },
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              const observedAt = clock() as UtcTimestamp;
              const gate = await inspectDirectEndpointCredential({
                authentication: options.configuration.authentication,
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
              const endpoint = endpointFor(
                options,
                gate.kind === "oauth"
                  ? directEndpointRequestResolver(anthropicOAuthInput(options, clock))
                  : options.credentialResolver,
                gate.kind === "oauth",
              );
              const result = await probeAnthropicModels(endpoint);
              // A person's tool verification outlives routine probes, which
              // run no generating request of their own.
              const prior = options.runtimeRegistry.observedState(instanceId);
              const priorVerified = prior?.verifiedToolModelIds;
              const probe = decodeProviderObservedState({
                instanceId,
                readiness: result.readiness,
                processState: "stopped",
                ...(options.configuration.authentication !== "none"
                  ? { credentialStatus: "stored" }
                  : {}),
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
              const observedAt = clock();
              const gate = await inspectDirectEndpointCredential({
                authentication: options.configuration.authentication,
                expectedDescriptorId: options.configuration.oauthDescriptorId,
                credentialResolver: options.credentialResolver,
                instanceId,
                host: options.subscriptionOAuth,
                now: () => Date.parse(observedAt),
                baseUrl: options.configuration.baseUrl,
              });
              if (gate.kind === "report") throw failure(gate.readiness, gate.message);
              const endpoint = endpointFor(
                options,
                gate.kind === "oauth"
                  ? directEndpointRequestResolver(anthropicOAuthInput(options, clock))
                  : options.credentialResolver,
                gate.kind === "oauth",
              );
              // One forced tool call proves the model answers with a tool use.
              // Transport failures (auth, timeout, provider error) propagate so
              // the person sees the real error instead of a false "unsupported".
              const result = await runProviderEffect(
                sendAnthropicMessagesTurn({
                  endpoint,
                  modelId,
                  history: [],
                  prompt: "echo ready",
                  tools: [capabilityEchoToolDefinition()],
                  toolChoice: "required",
                  maxTokens: 256,
                }),
              );
              return {
                instanceId,
                modelId,
                appManagedTools: result.toolCalls.some((call) =>
                  isCapabilityEchoToolCall(call.toolName),
                )
                  ? ("supported" as const)
                  : ("unsupported" as const),
              };
            },
            catch: sanitizeFailure,
          }),
  };
}

/** Whether the endpoint accepts this turn's input for the session's model. */
function admitTurn(
  options: AnthropicCompatibleDriverOptions,
  turn: ProviderTurnInput,
  modelId: ProviderModelId,
): ProviderFailure | undefined {
  const observed = options.runtimeRegistry.observedState(options.instanceId);
  const model = observed?.models.find((candidate) => candidate.id === modelId);
  const isCapabilityEchoProbe =
    turn.tools.length > 0 && turn.tools.every((tool) => isCapabilityEchoToolCall(tool.name));
  // A tool call proves only the model that made it, so admission reads the
  // per-model verifiedToolModelIds set and one verified model never unlocks
  // tools for its siblings on the same endpoint.
  const isVerifiedModel =
    observed?.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) ?? false;
  return validateChatTurnInput(
    turn,
    {
      ...(observed?.capabilities ?? initialCapabilities),
      appManagedTools: isCapabilityEchoProbe || isVerifiedModel ? "supported" : "unsupported",
    },
    model,
  );
}

/**
 * The endpoint as the harness loop sees it, one request attempt sent once.
 * The Messages API takes the whole conversation, results included, so the
 * request is the loop's history as is; the system prompt goes in its cached
 * system block. The host retries a failure that usually passes and keeps
 * what the response or refusal teaches about the model's window.
 */
function anthropicCompatibleTransport(
  options: AnthropicCompatibleDriverOptions,
  clock: () => string,
): HarnessEndpointTransport {
  return {
    open: async () => {
      const observedAt = clock();
      const gate = await inspectDirectEndpointCredential({
        authentication: options.configuration.authentication,
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
        options.configuration.authentication !== "none" &&
        gate.kind !== "oauth" &&
        (plainCredential === undefined || plainCredential.length === 0)
      ) {
        throw failure("unauthenticated", "The provider credential is missing or unavailable.");
      }
      const resolver =
        gate.kind === "oauth"
          ? directEndpointRequestResolver(anthropicOAuthInput(options, clock))
          : plainCredential !== undefined && plainCredential.length > 0
            ? { has: async () => true, resolve: async () => plainCredential }
            : undefined;
      let endpoint: AnthropicCompatibleEndpoint | undefined = endpointFor(
        options,
        resolver,
        gate.kind === "oauth",
      );
      return {
        fits: (request) => endpoint !== undefined && requestFits(options, endpoint, request),
        send: async (request, stream) => {
          const active = endpoint;
          if (active === undefined) throw failure("protocol", "Provider session is not active.");
          let result: AnthropicTurnResult;
          try {
            result = await runProviderEffect(
              sendAnthropicMessagesTurn({
                endpoint: active,
                modelId: request.modelId,
                history: request.history,
                prompt: "",
                ...(request.system === undefined ? {} : { system: request.system }),
                tools: request.tools,
                toolAnswers: [],
                signal: stream.signal,
                onEvent: (event: AnthropicTurnEvent) => {
                  if (event.kind === "usage") {
                    const { sequence: _sequence, ...usage } = event;
                    stream.onEvent(usage);
                    return;
                  }
                  stream.onEvent({ kind: event.kind, text: event.text });
                },
              }),
            );
          } catch (error) {
            if (stream.signal.aborted) {
              throw failure("interrupted", "The provider request was cancelled.");
            }
            throw error;
          }
          recordObservedTurn(options, result, clock);
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
        release: () => {
          endpoint = undefined;
        },
      };
    },
  };
}

/** What a successful response proves about the endpoint and its model. */
function recordObservedTurn(
  options: AnthropicCompatibleDriverOptions,
  result: AnthropicTurnResult,
  clock: () => string,
): void {
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
    ...(current?.verifiedToolModelIds === undefined
      ? {}
      : { verifiedToolModelIds: current.verifiedToolModelIds }),
    ...(current?.lastSuccessfulProbeAt === undefined
      ? {}
      : { lastSuccessfulProbeAt: current.lastSuccessfulProbeAt }),
    observedAt: clock(),
  });
}

function endpointFor(
  options: AnthropicCompatibleDriverOptions,
  credentialResolver: ProviderCredentialResolver | undefined,
  bearerOverride = false,
): AnthropicCompatibleEndpoint {
  const configuration =
    bearerOverride && options.configuration.authentication === "api-key"
      ? { ...options.configuration, authentication: "bearer" as const }
      : options.configuration;
  return makeAnthropicCompatibleEndpoint({
    instanceId: options.instanceId,
    configuration,
    ...(credentialResolver === undefined ? {} : { credentialResolver }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function anthropicOAuthInput(options: AnthropicCompatibleDriverOptions, clock: () => string) {
  return {
    authentication: options.configuration.authentication,
    expectedDescriptorId: options.configuration.oauthDescriptorId,
    credentialResolver: options.credentialResolver,
    instanceId: options.instanceId,
    host: options.subscriptionOAuth,
    now: () => Date.parse(clock()),
    baseUrl: options.configuration.baseUrl,
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

/** Whether a request fits the endpoint, measured on the body that would be sent. */
function requestFits(
  options: AnthropicCompatibleDriverOptions,
  endpoint: AnthropicCompatibleEndpoint,
  request: HarnessEndpointRequest,
): boolean {
  const body = JSON.stringify(
    buildAnthropicMessagesBody({
      modelId: request.modelId,
      history: request.history,
      prompt: "",
      ...(request.system === undefined ? {} : { system: request.system }),
      tools: request.tools,
      toolAnswers: [],
    }),
  );
  if (Buffer.byteLength(body, "utf8") > endpoint.limits.requestBodyBytes) return false;
  const model = options.runtimeRegistry
    .observedState(options.instanceId)
    ?.models.find((candidate) => String(candidate.id) === String(request.modelId));
  const contextLimit =
    model === undefined ? undefined : resolveModelContextWindow(model)?.contextWindow;
  // Roughly four bytes per token; only a model whose window is known is held to it.
  return contextLimit === undefined || body.length / 4 <= contextLimit;
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
