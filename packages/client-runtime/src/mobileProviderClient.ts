import {
  ProviderRegistrySnapshot,
  decodeHostAnswer,
  type ProviderInputModality,
  type ProviderModelOption,
  type ProviderModelOptionValues,
  type ProviderSlashCommand,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

export interface MobileModelOption {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly label: string;
  readonly detail: string;
  readonly driverKind?: string;
  /**
   * What the model takes as a native attachment: its declared input
   * modalities when its provider takes native attachments, and none otherwise.
   */
  readonly attachmentModalities: ReadonlyArray<ProviderInputModality>;
  /** The options the model declares, such as reasoning effort; absent when it declares none. */
  readonly settings?: ReadonlyArray<ProviderModelOption>;
  /**
   * The provider's own slash commands its account last listed. They belong to
   * the account, so every model of one account carries the same list; absent
   * when it lists none.
   */
  readonly commands?: ReadonlyArray<ProviderSlashCommand>;
}

/**
 * The chosen option values the model still declares. The host takes a value
 * only for a selection option and one of its listed values (a boolean option
 * has no value it accepts), and refuses the whole change otherwise, so the
 * phone drops what a model does not offer before it sends anything.
 */
export function keepDeclaredModelOptionValues(
  settings: ReadonlyArray<ProviderModelOption> | undefined,
  values: ProviderModelOptionValues | undefined,
): ProviderModelOptionValues {
  const kept: Record<string, string> = {};
  for (const [optionId, value] of Object.entries(values ?? {})) {
    const option = settings?.find((candidate) => candidate.id === optionId);
    if (option?.kind === "selection" && option.values.includes(value)) kept[optionId] = value;
  }
  return kept;
}

/**
 * Every configured provider account the host knows, enabled or not, so
 * historical transcript handoffs keep human account and model names after an
 * account is disabled or goes unready.
 */
export interface MobileProviderDirectoryEntry {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly driverKind: string;
  readonly models: ReadonlyArray<{ readonly modelId: string; readonly displayName: string }>;
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
        driverKind: instance.driverKind,
        attachmentModalities:
          observation.capabilities.nativeAttachments === "supported" ? model.inputModalities : [],
        ...(model.options.length === 0 ? {} : { settings: model.options }),
        ...(observation.commands === undefined || observation.commands.length === 0
          ? {}
          : { commands: observation.commands }),
      });
    }
  }
  return options;
}

/**
 * Full provider directory for display attribution (handoff dividers and
 * disclosures), including disabled and unready instances that pickers omit.
 * Falls back to persisted catalog snapshots when a runtime probe clears an
 * account's observed model list.
 */
export function normalizeMobileProviderDirectory(
  snapshot: ProviderRegistrySnapshot,
): ReadonlyArray<MobileProviderDirectoryEntry> {
  return snapshot.instances.map((instance) => {
    const observation = snapshot.observedStates.find(
      (candidate) => candidate.instanceId === instance.id,
    );
    const catalog = snapshot.catalogs?.find((candidate) => candidate.instanceId === instance.id);
    const modelsById = new Map<string, string>();
    for (const model of observation?.models ?? []) {
      modelsById.set(String(model.id), model.displayName);
    }
    for (const model of catalog?.models ?? []) {
      const modelId = String(model.id);
      if (!modelsById.has(modelId)) {
        modelsById.set(modelId, model.displayName);
      }
    }
    return {
      providerInstanceId: String(instance.id),
      displayName: instance.displayName,
      driverKind: instance.driverKind,
      models: Array.from(modelsById, ([modelId, displayName]) => ({ modelId, displayName })),
    };
  });
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
    return decodeHostAnswer(ProviderRegistrySnapshot)(await response.json());
  } catch {
    throw new MobileInboxFailure("unavailable", "Host returned an invalid provider catalog.");
  }
}

export async function fetchMobileModelOptions(
  transport: MobileRemoteTransport,
): Promise<ReadonlyArray<MobileModelOption>> {
  return normalizeMobileModelOptions(await fetchMobileProviderCatalog(transport));
}
