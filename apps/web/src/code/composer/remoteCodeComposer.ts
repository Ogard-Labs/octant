import type { PickerGroup } from "@octant/domain";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE } from "@octant/domain/ssh-target-recovery";

/**
 * The provider menu for a thread on an SSH target. The host runs only its own
 * harness's turns there and refuses every other provider before anything
 * launches, so every other provider's models stay listed, unavailable with
 * that reason, rather than disappearing from a menu that otherwise shows
 * what cannot be chosen.
 */
export function remoteCodeThreadProviderGroups(
  groups: ReadonlyArray<PickerGroup>,
): ReadonlyArray<PickerGroup> {
  return groups.map((group) =>
    group.runtime === "octant-harness"
      ? group
      : {
          ...group,
          sections: group.sections.map((section) => ({
            ...section,
            models: section.models.map((picker) => ({
              ...picker,
              unavailableReason: REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE,
            })),
          })),
        },
  );
}

/** Whether the chosen model is one Octant's harness runs, the only kind a target runs. */
export function harnessRunsSelection(
  groups: ReadonlyArray<PickerGroup>,
  selection:
    | {
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
      }
    | undefined,
): boolean {
  if (selection === undefined) return false;
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(selection.providerInstanceId),
  );
  return (
    group?.runtime === "octant-harness" &&
    group.sections.some((section) =>
      section.models.some(
        (picker) =>
          String(picker.model.id) === String(selection.modelId) &&
          picker.unavailableReason === undefined,
      ),
    )
  );
}
