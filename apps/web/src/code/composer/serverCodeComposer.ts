import type { PickerGroup } from "@octant/domain";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";

/** Why a runtime other than the Octant Harness is not offered in a server Project. */
export const SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE =
  "Runs on this computer's files; a Project on a server runs on the Octant Harness only.";

/**
 * The provider menu for a thread in a server Project. The host runs the Octant
 * Harness there, whose hands are on the server, and refuses every other
 * runtime before it launches. Each one stays listed, unavailable with the
 * reason, rather than disappearing from a menu that otherwise shows what
 * cannot be chosen.
 */
export function serverCodeThreadProviderGroups(
  groups: ReadonlyArray<PickerGroup>,
): ReadonlyArray<PickerGroup> {
  return groups.map((group) =>
    group.runtime === "octant-harness"
      ? group
      : {
          ...group,
          unavailableNote: SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE,
          sections: group.sections.map((section) => ({
            ...section,
            models: section.models.map((picker) => ({
              ...picker,
              unavailableReason: SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE,
            })),
          })),
        },
  );
}

/**
 * Why the chosen model cannot start a thread in a server Project, or
 * undefined when it can. A model the menu lists unavailable carries its own
 * reason.
 */
export function serverCodeSelectionRefusal(
  groups: ReadonlyArray<PickerGroup>,
  selection:
    | {
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
      }
    | undefined,
): string | undefined {
  if (selection === undefined) return SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE;
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(selection.providerInstanceId),
  );
  const picker = group?.sections
    .flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(selection.modelId));
  if (group === undefined || picker === undefined) return SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE;
  if (picker.unavailableReason !== undefined) return picker.unavailableReason;
  return group.runtime === "octant-harness" ? undefined : SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE;
}
