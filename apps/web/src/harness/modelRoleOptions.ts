import { buildModelPickerGroups, isNativeHarnessDriverKind } from "@octant/domain";
import type { PickerGroup } from "@octant/domain";
import type { ProviderReadiness } from "@octant/contracts";
import type { ProviderController } from "../providers/useProviderController";
import type { NativeHarnessProviderOption } from "./NativeHarnessRoutingPanel";

/** The direct-endpoint providers a slot may name, with the models each reports. */
export function nativeHarnessProviderOptions(
  controller: ProviderController | undefined,
): ReadonlyArray<NativeHarnessProviderOption> {
  if (controller === undefined) return [];
  return controller.instances
    .filter((instance) => instance.enabled && isNativeHarnessDriverKind(instance.driverKind))
    .map((instance) => {
      const observed = controller.observedByInstance.get(instance.id);
      return {
        instanceId: String(instance.id),
        label: instance.displayName,
        modelCount: observed?.models.length ?? 0,
        ...(observed === undefined ? {} : { readiness: observed.readiness }),
      };
    });
}

/**
 * The harness endpoints' models as the compact chooser lists them. Chat's
 * grouping lists every model, Chat-only ones included, because a role may
 * answer without tools and the panel says so beside the choice.
 */
export function nativeHarnessPickerGroups(
  controller: ProviderController | undefined,
): ReadonlyArray<PickerGroup> {
  if (controller === undefined) return [];
  return buildModelPickerGroups({
    instances: controller.instances,
    observedByInstance: controller.observedByInstance,
    providerOrder: controller.defaults.providerOrder,
    hiddenModels: controller.defaults.hiddenModels,
    mode: "chat",
  }).filter((group) => group.runtime === "octant-harness");
}

/** What each endpoint last reported, by instance id, for the tags on a role's models. */
export function nativeHarnessReadinessById(
  providers: ReadonlyArray<NativeHarnessProviderOption>,
): ReadonlyMap<string, ProviderReadiness> {
  return new Map(
    providers.flatMap((option) =>
      option.readiness === undefined ? [] : ([[option.instanceId, option.readiness]] as const),
    ),
  );
}
