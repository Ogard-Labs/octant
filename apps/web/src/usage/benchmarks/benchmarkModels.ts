import type { OctantMode, ProviderInstance } from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import { buildModelPickerGroups } from "@octant/domain";
import { contenderKey, type ContenderNames } from "./benchmarkPresentation";

/** One model a contender or the judge can be, with the account that serves it. */
export interface ModelChoice {
  readonly key: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly instanceName: string;
  readonly label: string;
}

/**
 * The enabled, ready provider accounts and the models each offers, from the
 * same picker policy the composer reads, so a benchmark never offers a model a
 * thread could not use.
 */
export function modelChoices(
  snapshot: ProviderRegistrySnapshot | undefined,
  mode: OctantMode = "chat",
): ReadonlyArray<ModelChoice> {
  if (snapshot === undefined) return [];
  const groups = buildModelPickerGroups({
    instances: snapshot.instances,
    observedByInstance: new Map(snapshot.observedStates.map((state) => [state.instanceId, state])),
    providerOrder: snapshot.defaults.providerOrder,
    hiddenModels: snapshot.defaults.hiddenModels,
    mode,
  });
  const choices: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const section of group.sections) {
      for (const picker of section.models) {
        if (picker.unavailableReason !== undefined) continue;
        const key = contenderKey(String(group.instance.id), String(picker.model.id));
        if (seen.has(key)) continue;
        seen.add(key);
        choices.push({
          key,
          providerInstanceId: String(group.instance.id),
          modelId: String(picker.model.id),
          instanceName: group.instance.displayName,
          label: `${group.instance.displayName} · ${picker.model.displayName}`,
        });
      }
    }
  }
  return choices;
}

/** Names for the accounts and models a run names, falling back to the raw ids. */
export function contenderNames(
  providers: ReadonlyArray<ProviderInstance> | undefined,
  snapshot: ProviderRegistrySnapshot | undefined,
): ContenderNames {
  const instances = providers ?? snapshot?.instances ?? [];
  return {
    instanceName: (instanceId) =>
      instances.find((instance) => String(instance.id) === instanceId)?.displayName ?? instanceId,
    modelName: (instanceId, modelId) =>
      snapshot?.observedStates
        .find((state) => String(state.instanceId) === instanceId)
        ?.models.find((model) => String(model.id) === modelId)?.displayName ?? modelId,
  };
}
