import type { PickerGroup } from "@octant/domain";

/**
 * A ready or degraded instance can answer even when every model is hidden.
 * Apart from the picker, so the shell can ask without loading the picker.
 */
export function pickerHasReadyInstance(groups: ReadonlyArray<PickerGroup>): boolean {
  return groups.some((group) => group.readiness === "ready" || group.readiness === "degraded");
}
