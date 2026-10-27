import {
  decodeProviderFailure,
  decodeProviderObservedState,
  type AmazonBedrockProviderConfiguration,
  type ProviderCapabilities,
  type ProviderCredentialStatus,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderObservedState,
  type ProviderTurnInput,
  type ProviderUnauthenticatedReason,
  type UtcTimestamp,
} from "@octant/contracts";
import { amazonBedrockRuntimeHost, amazonBedrockSigningScope } from "@octant/domain";
import { resolveModelInputModalities } from "@octant/domain/model-context-window";
import {
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import {
  cloudIamFailure,
  readCloudIamCredential,
  resolveCloudIamSignature,
  withCloudIamSignature,
  type CloudIamAttempt,
  type CloudIamCredential,
  type CloudIamEndpoint,
  type CloudIamHost,
  type CloudIamRefusal,
} from "@octant/provider-sdk/cloud-iam";
import type {
  HarnessEndpointDriver,
  HarnessEndpointSession,
} from "@octant/provider-sdk/harness-endpoint";
import { Effect } from "effect";
import {
  DEFAULT_BEDROCK_CONVERSE_LIMITS,
  bedrockConversePath,
  buildBedrockConverseBody,
  errorType,
  sendBedrockConverse,
  type BedrockConverseEndpoint,
  type BedrockConverseLimits,
  type BedrockConverseResult,
  type BedrockFetch,
  type BedrockRequestAuthorization,
} from "./bedrockConverse";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { honestDirectEndpointCapabilities } from "./directEndpointSubscriptionOAuth";
import { carryModelContextWindowFacts } from "./modelContextWindowFacts";
import { capabilityEchoToolDefinition, isCapabilityEchoToolCall } from "./openAiToolEncoding";
import type { ProviderDriverRuntimeRegistry } from "./providerRuntimeRegistry";

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
  // Tools follow a person's per-model Verify tools result, as on every other
  // direct endpoint: one model's tool call proves only that model.
  sessionCompaction: { chat: "unsupported", work: "unsupported", code: "supported" },
  ...unsupportedChatCapabilities,
};

// The error types Bedrock answers credentials it will not accept with: an
// expired or unknown session, or a signature it could not match. Renewing the
// role's credentials once can change that answer; a missing permission
// (AccessDeniedException) cannot.
const REFUSED_CREDENTIAL_TYPES: ReadonlySet<string> = new Set([
  "ExpiredTokenException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "IncompleteSignatureException",
  "MissingAuthenticationTokenException",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
]);

export interface AmazonBedrockDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: AmazonBedrockProviderConfiguration;
  readonly runtimeRegistry: ProviderDriverRuntimeRegistry;
  /** Where the instance's pointer to its broker grant is kept. */
  readonly credentialResolver?: ProviderCredentialResolver;
  /**
   * The broker's signer. Absent means the instance reads `unavailable`;
   * nothing stored is ever sent in a signature's place.
   */
  readonly cloudIam?: CloudIamHost;
  readonly fetch?: BedrockFetch;
  readonly clock?: () => string;
  readonly limits?: Partial<BedrockConverseLimits>;
}

/**
 * Amazon Bedrock's Converse API as an Octant Harness endpoint, signed per
 * request by the host credential broker. The host's harness loop owns the
 * conversation, every tool call, and retries; this driver supplies one
 * request attempt, its signing gate, and the per-model Verify tools check.
 * The server never holds a key: each request is described to the broker by
 * its fields and goes out with the one signature the broker returns.
 */
export function makeAmazonBedrockDriver(
  options: AmazonBedrockDriverOptions,
): HarnessEndpointDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    kind: "amazon-bedrock",
    harnessEndpoint: {
      open: async () => sessionOver(options, await endpointFor(options), clock),
      admitTurn: (turn, modelId) => admitTurn(options, turn, modelId),
    },
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: () => probe(options, clock() as UtcTimestamp),
            catch: sanitizeFailure,
          }),
    verifyToolCapability: ({ instanceId, modelId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              // One forced tool call proves the model answers with a tool use.
              // A refused signature or request propagates so the person sees
              // why, instead of a false "unsupported".
              const result = await sendBedrockConverse({
                endpoint: await endpointFor(options),
                request: {
                  modelId: String(modelId),
                  system: undefined,
                  history: [{ role: "user", text: "echo ready" }],
                  tools: [capabilityEchoToolDefinition()],
                  toolChoice: "required",
                  maxTokens: 256,
                },
                signal: new AbortController().signal,
                onEvent: () => undefined,
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

/** What the instance's configuration says its grant must be. */
function cloudIamEndpointOf(configuration: AmazonBedrockProviderConfiguration): CloudIamEndpoint {
  return { source: configuration.cloudIam, scope: amazonBedrockSigningScope(configuration.region) };
}

/**
 * The endpoint for one session: the pointer is read once, and every request
 * asks the broker for its own signature. A missing or unreadable pointer, or
 * a store that cannot be reached, refuses before any request.
 */
async function endpointFor(options: AmazonBedrockDriverOptions): Promise<BedrockConverseEndpoint> {
  const pointer = await readPointer(options);
  if (pointer.kind === "refused") throw refusedFailure(pointer.refusal);
  return {
    host: amazonBedrockRuntimeHost(options.configuration.region),
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    authorize: signedAuthorization(options, pointer.credential),
    limits: { ...DEFAULT_BEDROCK_CONVERSE_LIMITS, ...options.limits },
  };
}

type PointerRead =
  | { readonly kind: "pointer"; readonly credential: CloudIamCredential }
  | { readonly kind: "refused"; readonly refusal: CloudIamRefusal };

/**
 * The instance's stored pointer. A value that is not one, such as an API key
 * or another kind's pointer, is never sent: it reads as no sign-in.
 */
async function readPointer(options: AmazonBedrockDriverOptions): Promise<PointerRead> {
  const missing = {
    kind: "refused",
    refusal: { kind: "unauthenticated", reason: "missing" },
  } as const;
  if (options.credentialResolver === undefined) return missing;
  let raw: string;
  try {
    raw = await options.credentialResolver.resolve(options.instanceId);
  } catch (error) {
    return isRecord(error) && error.category === "unauthenticated"
      ? missing
      : { kind: "refused", refusal: { kind: "unavailable" } };
  }
  const credential = readCloudIamCredential(raw);
  return credential === undefined ? missing : { kind: "pointer", credential };
}

/**
 * Each request signed by the broker for exactly its fields. Credentials the
 * endpoint refuses are renewed once and the request sent once more; a
 * refusal rejects with a fixed Octant sentence.
 */
function signedAuthorization(
  options: AmazonBedrockDriverOptions,
  credential: CloudIamCredential,
): BedrockRequestAuthorization {
  return async (request, send) => {
    const outcome = await withCloudIamSignature(
      {
        credential,
        endpoint: cloudIamEndpointOf(options.configuration),
        host: options.cloudIam,
        request,
      },
      async (headers) => classify(await send(headers)),
    );
    if (outcome.kind === "answered") return outcome.value;
    throw refusedFailure(outcome);
  };
}

/** What one signed send answered; the body is the caller's to read unless refused. */
function classify(response: Response): CloudIamAttempt<Response> {
  if (response.status !== 400 && response.status !== 401 && response.status !== 403) {
    return { kind: "answered", value: response };
  }
  const type = errorType(response.headers.get("x-amzn-errortype"));
  if (type === "AccessDeniedException") {
    void response.body?.cancel().catch(() => undefined);
    return { kind: "forbidden" };
  }
  if (type !== undefined && REFUSED_CREDENTIAL_TYPES.has(type)) {
    void response.body?.cancel().catch(() => undefined);
    return { kind: "unauthorized" };
  }
  return { kind: "answered", value: response };
}

const refusals = new WeakMap<object, CloudIamRefusal>();

function refusedFailure(refusal: CloudIamRefusal): ProviderFailure {
  const failure = cloudIamFailure(refusal);
  refusals.set(failure, refusal);
  return failure;
}

/**
 * The probe asks the broker to sign a model request for the first
 * configured model and sends nothing. Bedrock has no free call that needs
 * only the permission a turn needs, so this proves the sign-in, the role the
 * portal gives, and the scope; a model the role may not invoke reads
 * not-authorized on its first request.
 */
async function probe(
  options: AmazonBedrockDriverOptions,
  observedAt: UtcTimestamp,
): Promise<ProviderObservedState> {
  const refuse = (refusal: CloudIamRefusal) => {
    const report = refusalReport(refusal);
    const refused = decodeProviderObservedState({
      instanceId: options.instanceId,
      readiness: report.readiness,
      processState: "stopped",
      credentialStatus: report.credentialStatus,
      ...(report.unauthenticatedReason === undefined
        ? {}
        : { unauthenticatedReason: report.unauthenticatedReason }),
      models: [],
      capabilities: honestDirectEndpointCapabilities,
      message: report.message,
      observedAt,
    });
    options.runtimeRegistry.setObservedState(refused);
    return refused;
  };
  const pointer = await readPointer(options);
  if (pointer.kind === "refused") return refuse(pointer.refusal);
  const [firstModel] = options.configuration.manualModelIds;
  const host = amazonBedrockRuntimeHost(options.configuration.region);
  const signed = await resolveCloudIamSignature({
    credential: pointer.credential,
    endpoint: cloudIamEndpointOf(options.configuration),
    host: options.cloudIam,
    request: {
      method: "POST",
      host,
      path: bedrockConversePath(String(firstModel ?? "")),
      query: [],
      headers: { "content-type": "application/json" },
      payloadHash: EMPTY_PAYLOAD_HASH,
    },
  });
  if (signed.kind !== "signature") return refuse(signed);
  const prior = options.runtimeRegistry.observedState(options.instanceId);
  const observed = decodeProviderObservedState({
    instanceId: options.instanceId,
    readiness: "ready",
    processState: "stopped",
    credentialStatus: "stored",
    // What requests taught about each model's window, and a person's
    // override, outlive the probe.
    models: carryModelContextWindowFacts(
      manualModels(options.configuration.manualModelIds, prior?.models),
      prior?.models,
    ),
    capabilities: initialCapabilities,
    lastSuccessfulProbeAt: observedAt,
    observedAt,
  });
  options.runtimeRegistry.setObservedState(observed);
  return observed;
}

const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function refusalReport(refusal: CloudIamRefusal): {
  readonly readiness: "unauthenticated" | "unavailable" | "incompatible";
  readonly credentialStatus: ProviderCredentialStatus;
  readonly unauthenticatedReason?: ProviderUnauthenticatedReason;
  readonly message: string;
} {
  const { message } = cloudIamFailure(refusal);
  if (refusal.kind === "unavailable") {
    return { readiness: "unavailable", credentialStatus: "unavailable", message };
  }
  if (refusal.kind === "incompatible") {
    return { readiness: "incompatible", credentialStatus: "stored", message };
  }
  return {
    readiness: "unauthenticated",
    // A role the portal no longer gives keeps its grant; an ended or absent
    // sign-in has none left.
    credentialStatus: refusal.reason === "not-authorized" ? "stored" : "missing",
    unauthenticatedReason: refusal.reason,
    message,
  };
}

/**
 * The instance's own models, text only: this transport sends no file
 * attachments, so a model never reads as taking images it would not be sent.
 * A model a request already verified stays verified.
 */
function manualModels(
  modelIds: ReadonlyArray<ProviderModelId>,
  prior: ProviderObservedState["models"] | undefined,
) {
  return modelIds.map((id) => ({
    id,
    displayName: String(id),
    source: "manual" as const,
    verification:
      prior?.find((model) => String(model.id) === String(id))?.verification === "verified"
        ? ("verified" as const)
        : ("unverified" as const),
    reasoning: "unavailable" as const,
    ...resolveModelInputModalities({ id: String(id), reportedInputModalities: ["text"] }),
    options: [],
  }));
}

/** Whether the endpoint accepts this turn's input for the session's model. */
function admitTurn(
  options: AmazonBedrockDriverOptions,
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
      ...(observed?.capabilities ?? initialCapabilities),
      appManagedTools: isVerifiedModel ? "supported" : "unsupported",
    },
    model,
  );
}

/** One harness session over an endpoint whose pointer is already read. */
function sessionOver(
  options: AmazonBedrockDriverOptions,
  opened: BedrockConverseEndpoint,
  clock: () => string,
): HarnessEndpointSession {
  let endpoint: BedrockConverseEndpoint | undefined = opened;
  return {
    fits: (request) => {
      if (endpoint === undefined) return false;
      const body = JSON.stringify(
        buildBedrockConverseBody({
          modelId: String(request.modelId),
          system: request.system,
          history: request.history,
          tools: request.tools,
        }),
      );
      return Buffer.byteLength(body, "utf8") <= endpoint.limits.requestBodyBytes;
    },
    send: async (request, stream) => {
      const active = endpoint;
      if (active === undefined) throw failure("protocol", "Provider session is not active.");
      const result = await sendBedrockConverse({
        endpoint: active,
        request: {
          modelId: String(request.modelId),
          system: request.system,
          history: request.history,
          tools: request.tools,
        },
        signal: stream.signal,
        onEvent: stream.onEvent,
      });
      recordObservedTurn(options, String(request.modelId), result, clock);
      return {
        text: result.text,
        toolCalls: result.toolCalls,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.outputStopReason === undefined
          ? {}
          : { outputStopReason: result.outputStopReason }),
      };
    },
    release: () => {
      endpoint = undefined;
    },
  };
}

/** What a successful response proves about the endpoint and its model. */
function recordObservedTurn(
  options: AmazonBedrockDriverOptions,
  modelId: string,
  result: BedrockConverseResult,
  clock: () => string,
): void {
  const current = options.runtimeRegistry.observedState(options.instanceId);
  const models = (
    current?.models ?? manualModels(options.configuration.manualModelIds, undefined)
  ).map((model) =>
    String(model.id) === modelId && model.source === "manual"
      ? { ...model, verification: "verified" as const }
      : model,
  );
  options.runtimeRegistry.setObservedState({
    instanceId: options.instanceId,
    readiness: current?.readiness ?? "degraded",
    processState: "stopped",
    credentialStatus: "stored",
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

function sanitizeFailure(error: unknown): ProviderFailure {
  const refusal = isRecord(error) ? refusals.get(error) : undefined;
  if (refusal !== undefined) return cloudIamFailure(refusal);
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.reason === undefined ? {} : { reason: decoded.reason }),
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return failure("provider-failed", "The provider request failed.");
  }
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
