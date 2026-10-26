import {
  decodeProviderFailure,
  decodeProviderProbeResult,
  type OllamaProviderConfiguration,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderTurnInput,
  type UtcTimestamp,
} from "@octant/contracts";
import { validateChatTurnInput } from "@octant/provider-sdk/chat-conformance";
import type {
  HarnessEndpointDriver,
  HarnessEndpointRequest,
  HarnessEndpointTransport,
} from "@octant/provider-sdk/harness-endpoint";
import { Effect } from "effect";
import {
  buildOllamaChatBody,
  makeOllamaEndpoint,
  ollamaChatInputFits,
  ollamaModelTakesTools,
  OLLAMA_UNKNOWN_CONTEXT_WINDOW,
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
import { carryModelContextWindowFacts } from "./modelContextWindowFacts";
import { outputStopReason } from "./outputStopReason";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface OllamaDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: OllamaProviderConfiguration;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly fetch?: OllamaFetch;
  readonly limits?: Partial<OllamaHttpLimits>;
  readonly clock?: () => string;
}

/**
 * Ollama has no forced tool choice, so the check asks for the call in words.
 * A model that answers in text instead is not one Octant can hand its tools.
 */
const TOOL_CHECK_PROMPT = `Call the ${OCTANT_CAPABILITY_ECHO_TOOL_NAME} tool with echo set to "ready". Do not answer in text.`;

/**
 * The local Ollama service as an Octant Harness endpoint, through the
 * provider-sdk harness endpoint port. The host's harness loop owns the
 * conversation, every tool call, and retries; this driver supplies one
 * request attempt over Ollama's native chat API on literal loopback, and the
 * per-model Verify tools check that gates which models are offered tools.
 */
export function makeOllamaDriver(options: OllamaDriverOptions): HarnessEndpointDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  const endpoint = makeOllamaEndpoint({
    baseUrl: options.configuration.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  return {
    kind: "ollama",
    harnessEndpoint: {
      ...ollamaTransport(options, endpoint, clock),
      admitTurn: (turn, modelId) => admitTurn(options, turn, modelId),
    },
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
          const prior = options.runtimeRegistry.observedState(instanceId);
          const priorVerified = prior?.verifiedToolModelIds;
          const result = decodeProviderProbeResult({
            instanceId,
            readiness: observed.readiness,
            processState: "stopped",
            detectedVersion: observed.version,
            // A person's window for a model is the `num_ctx` each request
            // sends, so it outlives the probe every turn runs first.
            models: carryModelContextWindowFacts(observed.models, prior?.models),
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
                // The window turns use, so the check does not make Ollama
                // reload the model at another size.
                contextWindow: requestContextWindow(options, String(modelId)),
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
  };
}

/**
 * Whether Ollama accepts this turn's input for the session's model. Image
 * attachments follow the model's own vision report; Octant's tools follow
 * the per-model Verify tools result, so one verified model never unlocks
 * tools for its siblings.
 */
function admitTurn(
  options: OllamaDriverOptions,
  turn: ProviderTurnInput,
  modelId: ProviderModelId,
): ProviderFailure | undefined {
  const observed = options.runtimeRegistry.observedState(options.instanceId);
  const model = observed?.models.find((candidate) => String(candidate.id) === String(modelId));
  const isVerifiedModel =
    observed?.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) ?? false;
  return validateChatTurnInput(
    turn,
    {
      nativeAttachments: observed?.capabilities.nativeAttachments ?? "unsupported",
      appManagedTools: isVerifiedModel ? "supported" : "unsupported",
    },
    model,
  );
}

/**
 * Ollama as the harness loop sees it: one `/api/chat` request per step, sent
 * once. The host retries a failure that usually passes.
 */
function ollamaTransport(
  options: OllamaDriverOptions,
  endpoint: OllamaEndpoint,
  clock: () => string,
): HarnessEndpointTransport {
  return {
    open: async () => {
      let active: OllamaEndpoint | undefined = endpoint;
      return {
        fits: (request) => active !== undefined && requestFits(options, active, request),
        send: async (request, stream) => {
          const current = active;
          if (current === undefined) throw failure("protocol", "Provider session is not active.");
          let result: OllamaChatResult;
          try {
            result = await sendOllamaChat(current, {
              modelId: String(request.modelId),
              system: request.system,
              history: request.history,
              tools: request.tools,
              contextWindow: requestContextWindow(options, String(request.modelId)),
              signal: stream.signal,
              onEvent: stream.onEvent,
            });
          } catch (error) {
            if (stream.signal.aborted) {
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
        release: () => {
          active = undefined;
        },
      };
    },
  };
}

/**
 * The one window a request to this model is both measured against and sent
 * with as `num_ctx`. Ollama cuts a prompt longer than the window it loaded
 * without an error, which can drop the harness's instructions and tools, so
 * the two must never differ: a person's own window for the model, else the
 * one the probe settled from Ollama's report, else the small window Octant
 * assumes when Ollama reports none.
 */
function requestContextWindow(options: OllamaDriverOptions, modelId: string): number {
  const model = options.runtimeRegistry
    .observedState(options.instanceId)
    ?.models.find((candidate) => String(candidate.id) === modelId);
  return model?.contextWindowOverride ?? model?.contextLimit ?? OLLAMA_UNKNOWN_CONTEXT_WINDOW;
}

/** Whether a request fits the endpoint and the window it is sent with, measured as it would be sent. */
function requestFits(
  options: OllamaDriverOptions,
  endpoint: OllamaEndpoint,
  request: HarnessEndpointRequest,
): boolean {
  const contextWindow = requestContextWindow(options, String(request.modelId));
  const input = {
    modelId: String(request.modelId),
    system: request.system,
    history: request.history,
    tools: request.tools,
    contextWindow,
  };
  if (!ollamaChatInputFits(endpoint, input)) return false;
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
  return text.length / 4 <= contextWindow;
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
