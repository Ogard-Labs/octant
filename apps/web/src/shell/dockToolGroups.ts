import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/**
 * `columns` is how the overview lays the group's tiles out: the thread's own
 * tools are the ones most often reached for and get two wide tiles a row, the
 * rest fit as many narrow tiles as the dock is wide.
 */
type DockToolColumns = "two" | "fit";

const TOOL_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly columns: DockToolColumns;
  readonly ids: ReadonlyArray<RightUtilityDockSurfaceId>;
}> = [
  {
    label: "Thread tools",
    columns: "two",
    ids: ["environment", "side-chat", "plan", "delivery", "agents", "document", "canvas", "review"],
  },
  {
    label: "Workspace",
    columns: "fit",
    ids: ["files", "terminal", "browser", "tests", "pull-requests"],
  },
  { label: "Devices", columns: "fit", ids: ["ios-simulator", "android-emulator"] },
];

export function groupDockTools<T extends { readonly id: RightUtilityDockSurfaceId }>(
  surfaces: ReadonlyArray<T>,
): ReadonlyArray<{
  readonly label: string;
  readonly columns: DockToolColumns;
  readonly surfaces: ReadonlyArray<T>;
}> {
  const grouped = new Set<RightUtilityDockSurfaceId>(TOOL_GROUPS.flatMap((group) => group.ids));
  return [
    ...TOOL_GROUPS.map((group) => ({
      label: group.label,
      columns: group.columns,
      surfaces: surfaces.filter((surface) => group.ids.includes(surface.id)),
    })),
    {
      label: "More tools",
      columns: "fit" as const,
      surfaces: surfaces.filter((surface) => !grouped.has(surface.id)),
    },
  ].filter((group) => group.surfaces.length > 0);
}
