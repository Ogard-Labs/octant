import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  decodeProviderFailure,
  decodeProviderProbeResult,
  type OctantMode,
  type OllamaProviderConfiguration,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderTurnInput,
  type UtcTimestamp,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { validateChatTurnInput } from "@octant/provider-sdk/chat-conformance";
import { resolveModelContextWindow } from "@octant/domain/model-context-window";
import { Effect } from "effect";
import type { NativeHarnessEndpointHooks } from "../harness/nativeHarnessEndpointRegistry";
import { createNativeHarnessConnection } from "../harness/nativeHarnessLoop";
import type {
  NativeHarnessRequest,
  NativeHarnessTransport,
} from "../harness/nativeHarnessTransport";
import {
  MemoryNativeHarnessTranscriptStore,
  type NativeHarnessTranscriptStore,
} from "../harness/nativeHarnessTranscriptStore";
import { sendWithEndpointRetry } from "./endpointRetry";
import {
  buildOllamaChatBody,
  makeOllamaEndpoint,
  ollamaChatInputFits,
  ollamaModelTakesTools,
  probeOllama,
  sendOllamaChat,
  type OllamaChatResult,
  type OllamaEndpoint,
  type OllamaFetch,
  type OllamaHttpLimits,
} from "./ollamaEndpoint";
import {
  capabilityEchoToolDefinition,
  isCapabilityEchoToolCall,
  OCTANT_CAPABILITY_ECHO_TOOL_NAME,
} from "./openAiToolEncoding";
import { outputStopReason } from "./outputStopReason";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface OllamaDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: OllamaProviderConfiguration;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly fetch?: OllamaFetch;
  readonly limits?: Partial<OllamaHttpLimits>;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly onConnectionReleased?: () => void;
  /** Where harness sessions keep their conversation; see the OpenAI-compatible driver. */
  readonly transcripts?: NativeHarnessTranscriptStore;
  /** How the harness retries this endpoint and where its lead goes when it stays down. */
  readonly harness?: NativeHarnessEndpointHooks;
}

/**
 * Ollama has no forced tool choice, so the check asks for the call in words.
 * A model that answers in text instead is not one Octant can hand its tools.
 */
const TOOL_CHECK_PROMPT = `Call the ${OCTANT_CAPABILITY_ECHO_TOOL_NAME} tool with echo set to "ready". Do not answer in text.`;

/**
 * The local Ollama service as an Octant Harness endpoint. The harness loop
 * owns the conversation and every tool call; this driver supplies the
 * transport over Ollama's native chat API on literal loopback, and the
 * per-model Verify tools check that gates which models are offered tools.
 */
export function makeOllamaDriver(options: OllamaDriverOptions): ProviderDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? randomUUID;
  const endpoint = makeOllamaEndpoint({
    baseUrl: options.configuration.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const transcripts = options.transcripts ?? new MemoryNativeHarnessTranscriptStore();
  const transport = ollamaTransport(options, endpoint, clock);
  options.harness?.endpoints?.register(options.instanceId, {
    open: transport.open,
    admitTurn: (turn, modelId) => admitTurn(options, turn, modelId),
  });

  return {
    kind: "ollama",
    probe: ({ instanceId }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      return Effect.tryPromise({
        try: async () => {
          const observed = await probeOllama(endpoint);
          const observedAt = clock() as UtcTimestamp;
          // A person's tool verification outlives routine probes, which run
          // no generating request of their own.
          const priorVerified =
            options.runtimeRegistry.observedState(instanceId)?.verifiedToolModelIds;
          const result = decodeProviderProbeResult({
            instanceId,
            readiness: observed.readiness,
            processState: "stopped",
            detectedVersion: observed.version,
            models: observed.models,
            capabilities: observed.capabilities,
            ...(priorVerified === undefined ? {} : { verifiedToolModelIds: priorVerified }),
            ...(observed.models.length === 0
              ? { message: "Ollama is reachable but has no installed models." }
              : {}),
            lastSuccessfulProbeAt: observedAt,
            observedAt,
          });
          options.runtimeRegistry.setObservedState(result);
          return result;
        },
        catch: sanitizeFailure,
      });
    },
    verifyToolCapability: ({ instanceId, modelId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              // Ollama refuses a request with tools for a model it says takes
              // none, so that answer needs no generating request.
              if (!(await ollamaModelTakesTools(endpoint, String(modelId)))) {
                return { instanceId, modelId, appManagedTools: "unsupported" as const };
              }
              // One tool call proves the model answers with a tool use.
              // Transport failures propagate so the person sees the real
              // error instead of a false "unsupported".
              const result = await sendOllamaChat(endpoint, {
                modelId: String(modelId),
                history: [{ role: "user", text: TOOL_CHECK_PROMPT }],
                tools: [capabilityEchoToolDefinition()],
              });
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
    acquire: ({ instanceId, projectRoot, mode }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      if (mode === undefined) {
        return Effect.fail(
          failure("invalid-configuration", "Ollama requires an explicit product mode."),
        );
      }
      if (!isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot) {
        return Effect.fail(
          failure(
            "invalid-configuration",
            "Provider Project root must be an absolute normalized path.",
          ),
        );
      }
      return makeConnection(options, transport, clock, makeCorrelation, transcripts, {
        projectRoot,
        mode,
      });
    },
  };
}

function makeConnection(
  options: OllamaDriverOptions,
  transport: NativeHarnessTransport,
  clock: () => string,
  makeCorrelation: () => string,
  transcripts: NativeHarnessTranscriptStore,
  input: { readonly projectRoot: string; readonly mode: OctantMode },
): Effect.Effect<ProviderConnection, never, import("effect").Scope.Scope> {
  return createNativeHarnessConnection({
    instanceId: options.instanceId,
    driverKind: "ollama",
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

/**
 * Whether Ollama accepts this turn's input for the session's model. Image
 * attachments follow the model's own vision report; Octant's tools follow
 * the per-model Verify tools result, so one verified model never unlocks
 * tools for its siblings, and the echo Verify tools sends is the only tool an
 * unverified model is admitted with.
 */
function admitTurn(
  options: OllamaDriverOptions,
  turn: ProviderTurnInput,
  modelId: ProviderModelId,
): ProviderFailure | undefined {
  const observed = options.runtimeRegistry.observedState(options.instanceId);
  const model = observed?.models.find((candidate) => String(candidate.id) === String(modelId));
  const isCapabilityEchoProbe =
    turn.tools.length > 0 && turn.tools.every((tool) => isCapabilityEchoToolCall(tool.name));
  const isVerifiedModel =
    observed?.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) ?? false;
  return validateChatTurnInput(
    turn,
    {
      nativeAttachments: observed?.capabilities.nativeAttachments ?? "unsupported",
      appManagedTools: isCapabilityEchoProbe || isVerifiedModel ? "supported" : "unsupported",
    },
    model,
  );
}

/** Ollama as the harness loop sees it: one `/api/chat` request per step. */
function ollamaTransport(
  options: OllamaDriverOptions,
  endpoint: OllamaEndpoint,
  clock: () => string,
): NativeHarnessTransport {
  return {
    open: async () => {
      let active: OllamaEndpoint | undefined = endpoint;
      return {
        fits: (request) => active !== undefined && requestFits(options, active, request),
        send: async (request, stream) => {
          const current = active;
          if (current === undefined) throw failure("protocol", "Provider session is not active.");
          return sendWithEndpointRetry({
            signal: stream.signal,
            onEvent: stream.onEvent,
            options: options.harness?.retry,
            attempt: async (attempt) => {
              let result: OllamaChatResult;
              try {
                result = await sendOllamaChat(current, {
                  modelId: String(request.modelId),
                  system: request.system,
                  history: request.history,
                  tools: request.tools,
                  signal: attempt.signal,
                  onEvent: attempt.onEvent,
                });
              } catch (error) {
                if (attempt.signal.aborted) {
                  throw failure("interrupted", "The provider request was cancelled.");
                }
                throw sanitizeFailure(error);
              }
              recordObservedTurn(options, result, clock);
              const stop = outputStopReason(result.doneReason);
              return {
                text: result.text,
                toolCalls: result.toolCalls,
                ...(result.usage === undefined ? {} : { usage: result.usage }),
                ...(stop === undefined || result.toolCalls.length > 0
                  ? {}
                  : { outputStopReason: stop }),
              };
            },
          });
        },
        release: () => {
          active = undefined;
        },
      };
    },
  };
}

/** Whether a request fits the endpoint and the model's reported window, measured as it would be sent. */
function requestFits(
  options: OllamaDriverOptions,
  endpoint: OllamaEndpoint,
  request: NativeHarnessRequest,
): boolean {
  const input = {
    modelId: String(request.modelId),
    system: request.system,
    history: request.history,
    tools: request.tools,
  };
  if (!ollamaChatInputFits(endpoint, input)) return false;
  const model = options.runtimeRegistry
    .observedState(options.instanceId)
    ?.models.find((candidate) => String(candidate.id) === String(request.modelId));
  const contextLimit =
    model === undefined ? undefined : resolveModelContextWindow(model)?.contextWindow;
  if (contextLimit === undefined) return true;
  // Roughly four bytes per token of the body as sent, less its images: Ollama
  // reads an image as a fixed embedding, not as base64 text, and measuring a
  // raw byte array serialized as JSON refused a 300 KB photo against a 128K
  // window. The body size limit above still bounds every image.
  const withoutImages = request.history.map(({ attachments: _attachments, ...message }) =>
    message.toolResults === undefined
      ? message
      : {
          ...message,
          toolResults: message.toolResults.map(({ images: _images, ...result }) => result),
        },
  );
  const text = JSON.stringify(buildOllamaChatBody({ ...input, history: withoutImages }));
  return text.length / 4 <= contextLimit;
}

/**
 * What a reply proves about the endpoint. One reply without counts or
 * thinking says nothing about the next, so neither is ever declared
 * unsupported from it: that would leave every unreported turn of this
 * endpoint out of a spend ceiling.
 */
function recordObservedTurn(
  options: OllamaDriverOptions,
  result: OllamaChatResult,
  clock: () => string,
): void {
  const observed = options.runtimeRegistry.observedState(options.instanceId);
  if (observed === undefined) return;
  options.runtimeRegistry.setObservedState(
    decodeProviderProbeResult({
      ...observed,
      capabilities: {
        ...observed.capabilities,
        streaming: "supported",
        usage: result.usage === undefined ? observed.capabilities.usage : "supported",
        reasoning: result.reasoning.length > 0 ? "supported" : observed.capabilities.reasoning,
      },
      observedAt: clock() as UtcTimestamp,
    }),
  );
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
    return failure("provider-failed", "The Ollama request failed.");
  }
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}
