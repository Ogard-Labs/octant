import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

const TOOL_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly ids: ReadonlyArray<RightUtilityDockSurfaceId>;
}> = [
  {
    label: "Thread tools",
    ids: ["environment", "side-chat", "plan", "delivery", "agents", "document", "canvas", "review"],
  },
  { label: "Workspace", ids: ["files", "terminal", "browser", "tests", "pull-requests"] },
  { label: "Devices", ids: ["ios-simulator", "android-emulator"] },
];

export function groupDockTools<T extends { readonly id: RightUtilityDockSurfaceId }>(
  surfaces: ReadonlyArray<T>,
): ReadonlyArray<{ readonly label: string; readonly surfaces: ReadonlyArray<T> }> {
  const grouped = new Set<RightUtilityDockSurfaceId>(TOOL_GROUPS.flatMap((group) => group.ids));
  return [
    ...TOOL_GROUPS.map((group) => ({
      label: group.label,
      surfaces: surfaces.filter((surface) => group.ids.includes(surface.id)),
    })),
    {
      label: "More tools",
      surfaces: surfaces.filter((surface) => !grouped.has(surface.id)),
    },
  ].filter((group) => group.surfaces.length > 0);
}
