import type {
  ProviderFailure,
  ProviderInputModality,
  ProviderInstanceId,
  ProviderProbeResult,
  ProviderCapabilities,
} from "@octant/contracts";
import { resolve } from "node:path";
import { decodeProviderModelId, decodeProviderProbeResult } from "@octant/contracts";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ModelV2Info, ProviderV2Info } from "@opencode-ai/sdk/v2/types";
import { Effect } from "effect";
import type { OpenCodeProcessPort, OpenCodeServerConnection } from "./openCodeProcess";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import { providerFailure } from "./openCodeDriver";

interface OpenCode2CatalogOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly process: OpenCodeProcessPort;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly clock?: () => string;
}

const BETA_API_TIMEOUT_MS = 5_000;

function betaRequestOptions() {
  return { throwOnError: true as const, signal: AbortSignal.timeout(BETA_API_TIMEOUT_MS) };
}

function resultData<A>(result: { readonly data: A | undefined }): A {
  if (result.data === undefined) throw new Error("OpenCode 2 returned no response data.");
  return result.data;
}

function request<A>(operation: () => Promise<A>): Effect.Effect<A, ProviderFailure> {
  return Effect.tryPromise({ try: operation, catch: providerFailure });
}

function inputModalities(model: ModelV2Info): ReadonlyArray<ProviderInputModality> {
  const modalities: ProviderInputModality[] = [];
  const input = new Set(model.capabilities.input);
  if (input.has("text")) modalities.push("text");
  if (input.has("image")) modalities.push("image");
  if (input.has("audio")) modalities.push("audio");
  if (input.has("pdf")) modalities.push("document");
  return modalities.length > 0 ? modalities : ["text"];
}

function catalogCapabilities(models: ReadonlyArray<ModelV2Info>): ProviderCapabilities {
  return {
    streaming: "supported",
    resume: "supported",
    interruption: "supported",
    approvals: "supported",
    userQuestions: "unsupported",
    reasoning: models.some((model) => model.capabilities.output.includes("reasoning"))
      ? "supported"
      : "unavailable",
    usage: "unavailable",
    toolActivity: "supported",
    fileChanges: "unavailable",
    diffs: "unavailable",
    taskProgress: "supported",
    nativeChildAgents: "unavailable",
    nativeAttachments: models.some((model) => inputModalities(model).length > 1)
      ? "supported"
      : "unsupported",
    nativeWebResearch: "unavailable",
    appManagedTools: "unsupported",
    citations: "unavailable",
  };
}

export function normalizeOpenCode2Catalog(
  instanceId: ProviderInstanceId,
  health: { readonly version: string },
  providers: ReadonlyArray<ProviderV2Info>,
  models: ReadonlyArray<ModelV2Info>,
  observedAt: string,
): ProviderProbeResult {
  const enabledProviders = new Set(
    providers.filter((provider) => provider.disabled !== true).map((provider) => provider.id),
  );
  const availableModels = models.filter(
    (model) => model.enabled && enabledProviders.has(model.providerID),
  );
  const normalizedModels = availableModels.map((model) => {
    const modalities = inputModalities(model);
    return {
      id: decodeProviderModelId(`${model.providerID}/${model.id}`),
      displayName: model.name,
      source: "discovered" as const,
      verification: "verified" as const,
      ...(model.limit.context > 0 ? { contextLimit: model.limit.context } : {}),
      ...(model.limit.output > 0 ? { maxOutputTokens: model.limit.output } : {}),
      reasoning: model.capabilities.output.includes("reasoning")
        ? ("supported" as const)
        : ("unsupported" as const),
      toolCalling: model.capabilities.tools ? ("supported" as const) : ("unsupported" as const),
      streaming: "supported" as const,
      inputModalities: modalities,
      imageInput: modalities.includes("image") ? ("supported" as const) : ("unsupported" as const),
      options: [],
    };
  });
  return decodeProviderProbeResult({
    instanceId,
    readiness: normalizedModels.length > 0 ? "ready" : "unauthenticated",
    processState: "running",
    detectedVersion: health.version,
    models: normalizedModels,
    capabilities: catalogCapabilities(availableModels),
    ...(normalizedModels.length > 0
      ? { lastSuccessfulProbeAt: observedAt }
      : { message: "Authenticate OpenCode 2 with a provider." }),
    observedAt,
  });
}

function officialClient(server: OpenCodeServerConnection, projectRoot: string) {
  return createOpencodeClient({
    baseUrl: server.url.toString(),
    directory: projectRoot,
    headers: { authorization: server.authorization },
  });
}

export function makeOpenCode2CatalogProbe(options: OpenCode2CatalogOptions) {
  const clock = options.clock ?? (() => new Date().toISOString());
  return ({ instanceId }: { readonly instanceId: ProviderInstanceId }) => {
    if (instanceId !== options.instanceId) {
      return Effect.fail<ProviderFailure>({
        category: "invalid-configuration",
        message: "Provider instance does not match driver.",
      });
    }
    return Effect.gen(function* () {
      const projectRoot = resolve(process.cwd());
      const connection = yield* options.process.start({
        binaryPath: options.binaryPath,
        cwd: projectRoot,
        onProcessStarted: (process) =>
          options.runtimeRegistry.trackProcess(options.instanceId, process),
      });
      if (connection.runtime !== "beta") {
        return yield* Effect.fail({
          category: "incompatible" as const,
          message: "OpenCode 2 binary did not report the beta runtime.",
        });
      }
      const client = officialClient(connection, projectRoot);
      yield* request(() => client.v2.health.get(betaRequestOptions()).then(resultData));
      const providers = yield* request(() =>
        client.v2.provider.list({}, betaRequestOptions()).then(resultData),
      );
      const models = yield* request(() =>
        client.v2.model.list({}, betaRequestOptions()).then(resultData),
      );
      return normalizeOpenCode2Catalog(
        instanceId,
        { version: connection.version ?? "unknown" },
        providers.data,
        models.data,
        clock(),
      );
    });
  };
}
