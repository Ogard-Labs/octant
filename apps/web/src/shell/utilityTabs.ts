import {
  RIGHT_UTILITY_DOCK_SURFACES,
  type RightUtilityDockSurfaceId,
  type RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";
import type { ThreadUtilityDockTab } from "./rightUtilityDockSelection";

export function describeUtilityTabs(
  tabs: ReadonlyArray<ThreadUtilityDockTab>,
): ReadonlyArray<RightUtilityDockTabDescriptor> {
  const totals = new Map<RightUtilityDockSurfaceId, number>();
  for (const tab of tabs) totals.set(tab.surface, (totals.get(tab.surface) ?? 0) + 1);
  const seen = new Map<RightUtilityDockSurfaceId, number>();
  return tabs.flatMap((tab) => {
    const surface = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === tab.surface);
    if (surface === undefined) return [];
    const index = (seen.get(tab.surface) ?? 0) + 1;
    seen.set(tab.surface, index);
    return [
      {
        id: tab.id,
        label: (totals.get(tab.surface) ?? 0) > 1 ? `${surface.label} ${index}` : surface.label,
        surface,
      },
    ];
  });
}
