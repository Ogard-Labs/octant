import type { ModelPickerSelection, PickerGroup } from "@octant/domain";

export function firstSelectableProviderSelection(
  groups: ReadonlyArray<PickerGroup>,
): ModelPickerSelection | undefined {
  for (const group of groups) {
    for (const section of group.sections) {
      for (const picker of section.models) {
        if (picker.unavailableReason === undefined) {
          return { providerInstanceId: group.instance.id, modelId: picker.model.id };
        }
      }
    }
  }
  return undefined;
}
