import { decodeProviderRegistrySnapshot, type ProviderRegistrySnapshot } from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

export interface MobileModelOption {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly label: string;
  readonly detail: string;
}

const OPTION_SEPARATOR = "::";

export function encodeMobileModelOptionId(providerInstanceId: string, modelId: string): string {
  return `${providerInstanceId}${OPTION_SEPARATOR}${modelId}`;
}

export function decodeMobileModelOptionId(
  id: string,
): { readonly providerInstanceId: string; readonly modelId: string } | undefined {
  const index = id.indexOf(OPTION_SEPARATOR);
  if (index <= 0) return undefined;
  const providerInstanceId = id.slice(0, index);
  const modelId = id.slice(index + OPTION_SEPARATOR.length);
  if (providerInstanceId.length === 0 || modelId.length === 0) return undefined;
  return { providerInstanceId, modelId };
}

/**
 * Host-advertised model options for mobile pickers. Mirrors web Chat
 * `providerPresentation` readiness rules: enabled instances with ready/degraded
 * observations. Never includes credentials or probe diagnostics.
 */
export function normalizeMobileModelOptions(
  snapshot: ProviderRegistrySnapshot,
): ReadonlyArray<MobileModelOption> {
  const options: MobileModelOption[] = [];
  for (const instance of snapshot.instances) {
    if (!instance.enabled) continue;
    const observation = snapshot.observedStates.find(
      (candidate) =>
        candidate.instanceId === instance.id &&
        (candidate.readiness === "ready" || candidate.readiness === "degraded"),
    );
    if (observation === undefined) continue;
    for (const model of observation.models) {
      options.push({
        id: encodeMobileModelOptionId(String(instance.id), String(model.id)),
        providerInstanceId: String(instance.id),
        modelId: String(model.id),
        label: model.displayName,
        detail: instance.displayName,
      });
    }
  }
  return options;
}

export async function fetchMobileProviderCatalog(
  transport: MobileRemoteTransport,
): Promise<ProviderRegistrySnapshot> {
  const response = await transport.authenticatedFetch({
    method: "GET",
    path: "/api/providers/bootstrap",
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Could not load host-advertised models.",
    );
  }
  try {
    return decodeProviderRegistrySnapshot(await response.json());
  } catch {
    throw new MobileInboxFailure("unavailable", "Host returned an invalid provider catalog.");
  }
}

export async function fetchMobileModelOptions(
  transport: MobileRemoteTransport,
): Promise<ReadonlyArray<MobileModelOption>> {
  return normalizeMobileModelOptions(await fetchMobileProviderCatalog(transport));
}
