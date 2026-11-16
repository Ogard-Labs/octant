import {
  buildModelPickerGroups,
  isImageProfileDriverKind,
  type PickerGroup,
  type RoleSuggestionModel,
} from "@octant/domain";
import type { ProviderReadiness } from "@octant/contracts";
import { isComposerReasoningOption } from "../providers/ComposerModelPicker";
import type { ProviderController } from "../providers/useProviderController";
import type { NativeHarnessProviderOption } from "./NativeHarnessRoutingPanel";

/** Every enabled provider a role may name, with the models each reports. */
export function modelRoleProviderOptions(
  controller: ProviderController | undefined,
): ReadonlyArray<NativeHarnessProviderOption> {
  if (controller === undefined) return [];
  return controller.instances
    .filter((instance) => instance.enabled && !isImageProfileDriverKind(instance.driverKind))
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
 * Every enabled provider's models as the compact chooser lists them, grouped by
 * provider. A role holds any connected provider's model, because coordinator
 * workers run as ordinary Code threads; the harness itself steps past the ones
 * it cannot run. Chat's grouping lists every model, Chat-only ones included,
 * because a role may answer without tools and the panel says so beside the choice.
 */
export function modelRolePickerGroups(
  controller: ProviderController | undefined,
): ReadonlyArray<PickerGroup> {
  if (controller === undefined) return [];
  return buildModelPickerGroups({
    instances: controller.instances,
    observedByInstance: controller.observedByInstance,
    providerOrder: controller.defaults.providerOrder,
    hiddenModels: controller.defaults.hiddenModels,
    mode: "chat",
  });
}

/**
 * The facts a suggestion may use, one per listed model. A group is present
 * only when the provider is signed in and ready, so a role never starts from a
 * model that cannot answer. `atUsageLimit` comes from the usage the window has.
 */
export function roleSuggestionModels(
  groups: ReadonlyArray<PickerGroup>,
  atUsageLimit: (providerInstanceId: string) => boolean,
): ReadonlyArray<RoleSuggestionModel> {
  return groups.flatMap((group) =>
    group.sections.flatMap((section) =>
      section.models.map((picker) => {
        const levels = picker.model.options.flatMap((option) =>
          option.kind === "selection" && isComposerReasoningOption(option) ? option.values : [],
        );
        return {
          providerInstanceId: String(group.instance.id),
          providerKind: group.instance.driverKind,
          providerLabel: group.instance.displayName,
          modelId: String(picker.model.id),
          displayName: picker.model.displayName,
          readsImages: picker.model.inputModalities.includes("image"),
          toolsReady: picker.toolCapable,
          ready: group.readiness === "ready",
          atUsageLimit: atUsageLimit(String(group.instance.id)),
          ...(levels.length === 0 ? {} : { reasoningLevels: levels }),
        };
      }),
    ),
  );
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
