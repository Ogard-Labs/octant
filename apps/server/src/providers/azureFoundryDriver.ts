import type {
  AzureFoundryProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
  ProviderInstanceId,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import { Effect } from "effect";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  makeOpenAiCompatibleDriver,
  type OpenAiCompatibleDriverProfile,
} from "./openAiCompatibleDriver";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface AzureFoundryDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: AzureFoundryProviderConfiguration;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: CompatibleFetch;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly onConnectionReleased?: () => void;
}

const FOUNDRY_PROFILE: OpenAiCompatibleDriverProfile = {
  driverKind: "azure-foundry",
  authStrategy: "api-key",
};

/**
 * Azure AI Foundry reuses the OpenAI-compatible v1 transport and Keychain
 * boundary. The Foundry profile keeps a distinct `azure-foundry` diagnostic/UI
 * identity while routing requests through the shared OpenAI adapter with the
 * documented `api-key` header. Foundry deployments are exposed as manual model
 * IDs so the catalog orders them exactly as configured.
 */
export function makeAzureFoundryDriver(options: AzureFoundryDriverOptions): ProviderDriver {
  const compatibleConfiguration: OpenAiCompatibleProviderConfiguration = {
    kind: "openai-compatible-http",
    baseUrl: options.configuration.baseUrl,
    // The shared adapter reads the auth strategy from the profile, not from
    // this placeholder. "bearer" keeps the OpenAI-compatible shape valid while
    // the Foundry profile overrides credential handling with `api-key`.
    authentication: "bearer",
    protocol: options.configuration.protocol,
    manualModelIds: options.configuration.manualModelIds as readonly ProviderModelId[],
  };
  const base = makeOpenAiCompatibleDriver({
    instanceId: options.instanceId,
    configuration: compatibleConfiguration,
    runtimeRegistry: options.runtimeRegistry,
    ...(options.credentialResolver === undefined
      ? {}
      : { credentialResolver: options.credentialResolver }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    ...(options.onConnectionReleased === undefined
      ? {}
      : { onConnectionReleased: options.onConnectionReleased }),
    profile: FOUNDRY_PROFILE,
  });
  // Per the approved Foundry profile design, treat missing/incomplete model discovery as
  // degraded with visible manual deployment IDs. The generic OpenAI-compatible
  // probe marks any syntactically valid 200 /models response as ready; wrap
  // the probe so a Foundry endpoint that omits all configured deployments is
  // downgraded to degraded instead of reporting a false-ready catalog.
  const configuredDeployments = new Set(
    options.configuration.manualModelIds.map((id) => String(id)),
  );
  return {
    ...base,
    probe: (input) =>
      base.probe(input).pipe(
        Effect.map((observed: ProviderObservedState) => {
          if (observed.readiness !== "ready") return observed;
          // Filter the catalog to only include configured deployment IDs so
          // /models cannot bypass the configured deployment list: a
          // non-configured discovered id would otherwise be selectable in
          // Settings/Chat and the driver would send it as the request model.
          const filteredModels = observed.models.filter((model) =>
            configuredDeployments.has(String(model.id)),
          );
          // Check discovered models from the ORIGINAL observation (before
          // filtering) to distinguish between "/models returned nothing" and
          // "/models returned models but none are configured".
          const rawDiscovered = observed.models.filter((model) => model.source === "discovered");
          // Only check configured discovered models (exclude manual entries
          // the probe appends from the configured deployment list). Require
          // EVERY configured deployment to be present in /models; if any is
          // missing, downgrade to degraded so a typo or wrong endpoint for
          // just one deployment is reported honestly instead of falsely
          // ready.
          const discovered = filteredModels.filter((model) => model.source === "discovered");
          const discoveredIds = new Set(discovered.map((model) => String(model.id)));
          const missingDeployments = [...configuredDeployments].filter(
            (id) => !discoveredIds.has(id),
          );
          const readiness = missingDeployments.length === 0 ? "ready" : "degraded";
          if (readiness === "ready" && filteredModels.length === observed.models.length) {
            return observed;
          }
          const message =
            readiness === "ready"
              ? observed.message
              : rawDiscovered.length === 0
                ? "Azure AI Foundry /models returned no deployments. Verify the endpoint and deployment IDs, then check the connection again."
                : `Azure AI Foundry /models did not return all configured deployment IDs. Missing: ${missingDeployments.join(", ")}. Manual deployment IDs are available; verify the IDs match the endpoint if this is unexpected.`;
          const adjusted = {
            ...observed,
            models: filteredModels,
            readiness: readiness as "ready" | "degraded",
            ...(message === undefined ? {} : { message }),
          };
          // Re-publish the adjusted observation to the runtime registry: the
          // base probe already saved the generic observation before this
          // wrapper runs, so without this the registry would not carry the
          // filtered catalog, degraded readiness, or warning message.
          options.runtimeRegistry.setObservedState(adjusted);
          return adjusted;
        }),
      ),
  };
}
