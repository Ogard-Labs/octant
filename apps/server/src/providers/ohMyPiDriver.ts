import { join } from "node:path";
import {
  decodeProviderFailure,
  decodeProviderModelId,
  decodeProviderProbeResult,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import {
  textOnlyInputModalities,
  unsupportedChatCapabilities,
} from "@octant/provider-sdk/chat-conformance";
import { Effect } from "effect";
import type { OhMyPiProcessPort } from "./ohMyPiProcess";
import type { PiRpcResponse } from "./piRpcClient";
import { trackProviderProcess, type ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface OhMyPiDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly managedHome: string;
  readonly supportedVersion: string;
  readonly process: OhMyPiProcessPort;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly clock?: () => string;
}

const capabilities = {
  streaming: "supported",
  resume: "unsupported",
  interruption: "supported",
  approvals: "unsupported",
  userQuestions: "unsupported",
  reasoning: "supported",
  usage: "unavailable",
  toolActivity: "unsupported",
  fileChanges: "unavailable",
  diffs: "unavailable",
  taskProgress: "unavailable",
  nativeChildAgents: "unsupported",
  ...unsupportedChatCapabilities,
} as const;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function providerFailure(error: unknown): ProviderFailure {
  try {
    return decodeProviderFailure(error);
  } catch {
    // Provider boundaries expose only normalized failures.
  }
  return failure("provider-failed", "Oh My Pi request failed.");
}

function request<A>(operation: () => Promise<A>): Effect.Effect<A, ProviderFailure> {
  return Effect.tryPromise({ try: operation, catch: providerFailure });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function bounded(value: unknown, maximum = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).slice(0, maximum).join("");
}

function normalizeModels(response: PiRpcResponse) {
  const data = record(response.data);
  const models = Array.isArray(data?.models) ? data.models : [];
  return models.flatMap((candidate) => {
    const model = record(candidate);
    const provider = bounded(model?.provider, 128);
    const id = bounded(model?.id, 256);
    if (provider === undefined || id === undefined) return [];
    const context = model?.contextWindow;
    return [
      {
        id: decodeProviderModelId(`${provider}/${id}`),
        displayName: bounded(model?.name, 256) ?? id,
        source: "discovered" as const,
        verification: "verified" as const,
        ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0
          ? { contextLimit: context }
          : {}),
        reasoning: model?.reasoning === false ? ("unsupported" as const) : ("supported" as const),
        inputModalities: textOnlyInputModalities,
        options: [],
      },
    ];
  });
}

/**
 * Probe-first Oh My Pi driver. Full turn execution remains fail-closed until
 * authority/tool mapping is complete; this slice owns identity, version pin,
 * ready framing, model discovery, and clean shutdown evidence.
 */
export function makeOhMyPiDriver(options: OhMyPiDriverOptions): ProviderDriver {
  const clock = options.clock ?? (() => new Date().toISOString());

  return {
    kind: "oh-my-pi",
    probe: ({ instanceId }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      return Effect.gen(function* () {
        let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
        const connection = yield* options.process.startProbe({
          binaryPath: options.binaryPath,
          managedHome: options.managedHome,
          supportedVersion: options.supportedVersion,
          onProcessStarted: async (process) => {
            receipt = await options.runtimeRegistry.trackProcess(instanceId, process);
            return receipt;
          },
        });
        if (receipt === undefined) {
          yield* trackProviderProcess(options.runtimeRegistry, instanceId, connection);
        }
        const modelResponse = yield* request(() => connection.rpc.request("get_available_models"));
        yield* request(() => connection.rpc.request("get_state"));
        const models = normalizeModels(modelResponse);
        const observedAt = clock();
        const result = decodeProviderProbeResult({
          instanceId,
          readiness: models.length === 0 ? "degraded" : "ready",
          processState: "stopped",
          detectedVersion: connection.version,
          models,
          capabilities,
          ...(models.length === 0
            ? { message: "Oh My Pi did not report an authenticated selectable model." }
            : {}),
          lastSuccessfulProbeAt: observedAt,
          observedAt,
        });
        options.runtimeRegistry.setObservedState(result);
        return result;
      });
    },
    acquire: () =>
      Effect.fail(
        failure(
          "unsupported",
          "Oh My Pi turn execution remains unavailable until authority mapping is complete.",
        ),
      ),
  };
}

export function ohMyPiHomeForInstance(dataDirectory: string, instanceId: string): string {
  return join(dataDirectory, "providers", "oh-my-pi", instanceId);
}
