import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  decodeProviderFailure,
  decodeProviderObservedState,
  type AnthropicCompatibleProviderConfiguration,
  type OctantMode,
  type ProviderCapabilities,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type UtcTimestamp,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  textOnlyInputModalities,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Effect } from "effect";
import { createNativeHarnessConnection } from "../harness/nativeHarnessLoop";
import type {
  NativeHarnessRequest,
  NativeHarnessTransport,
} from "../harness/nativeHarnessTransport";
import {
  MemoryNativeHarnessTranscriptStore,
  type NativeHarnessTranscriptStore,
} from "../harness/nativeHarnessTranscriptStore";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
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
  // Tool use is part of the Messages protocol itself, not a per-model extra,
  // so an Anthropic-compatible endpoint offers app-managed tools from the
  // first turn rather than after a probe.
  appManagedTools: "supported",
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
  /** Where harness sessions keep their conversation; see the OpenAI-compatible driver. */
  readonly transcripts?: NativeHarnessTranscriptStore;
  /** Host refresh and access for a subscription-oauth credential. */
  readonly subscriptionOAuth?: SubscriptionOAuthHost;
}

export function makeAnthropicCompatibleDriver(
  options: AnthropicCompatibleDriverOptions,
): ProviderDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? randomUUID;
  const transcripts = options.transcripts ?? new MemoryNativeHarnessTranscriptStore();
  return {
    kind: "anthropic-compatible",
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
          : makeConnection(options, clock, makeCorrelation, transcripts, {
              projectRoot,
              mode: mode ?? "chat",
            }),
  };
}

function makeConnection(
  options: AnthropicCompatibleDriverOptions,
  clock: () => string,
  makeCorrelation: () => string,
  transcripts: NativeHarnessTranscriptStore,
  input: { readonly projectRoot: string; readonly mode: OctantMode },
): Effect.Effect<ProviderConnection, never, import("effect").Scope.Scope> {
  return createNativeHarnessConnection({
    instanceId: options.instanceId,
    driverKind: "anthropic-compatible",
    projectRoot: input.projectRoot,
    mode: input.mode,
    transport: anthropicCompatibleTransport(options, clock),
    transcripts,
    admitTurn: (turn, modelId) => {
      const observed = options.runtimeRegistry.observedState(options.instanceId);
      const model = observed?.models.find((candidate) => candidate.id === modelId);
      return validateChatTurnInput(turn, observed?.capabilities ?? initialCapabilities, model);
    },
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

/**
 * The endpoint as the harness loop sees it. The Messages API takes the whole
 * conversation, results included, so the request is the loop's history as is;
 * the system prompt goes in its cached system block.
 */
function anthropicCompatibleTransport(
  options: AnthropicCompatibleDriverOptions,
  clock: () => string,
): NativeHarnessTransport {
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
            result = await Effect.runPromise(
              sendAnthropicMessagesTurn({
                endpoint: active,
                modelId: request.modelId,
                history: request.history,
                prompt: "",
                ...(request.system === undefined ? {} : { system: request.system }),
                tools: request.tools,
                toolAnswers: [],
                signal: stream.signal,
                onEvent: (event: AnthropicTurnEvent) =>
                  stream.onEvent(
                    event.kind === "usage"
                      ? {
                          kind: "usage",
                          inputTokens: event.inputTokens,
                          outputTokens: event.outputTokens,
                        }
                      : { kind: event.kind, text: event.text },
                  ),
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

/** Whether a request fits the endpoint, measured on the body that would be sent. */
function requestFits(
  options: AnthropicCompatibleDriverOptions,
  endpoint: AnthropicCompatibleEndpoint,
  request: NativeHarnessRequest,
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
  const contextLimit = options.runtimeRegistry
    .observedState(options.instanceId)
    ?.models.find((model) => String(model.id) === String(request.modelId))?.contextLimit;
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
