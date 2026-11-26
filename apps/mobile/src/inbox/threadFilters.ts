import type { MobileInboxMode, MobileInboxRow } from "@octant/client-runtime";

export interface MobileThreadFilter {
  readonly mode: MobileInboxMode | "all";
  readonly hostId: string | "all";
  /** A Project belongs to the computer that holds it. */
  readonly project: { readonly hostId: string; readonly projectId: string } | "all";
}

export const NO_THREAD_FILTER: MobileThreadFilter = { mode: "all", hostId: "all", project: "all" };

export function filterThreads(
  rows: ReadonlyArray<MobileInboxRow>,
  filter: MobileThreadFilter,
): ReadonlyArray<MobileInboxRow> {
  const { mode, hostId, project } = filter;
  return rows.filter(
    (row) =>
      (mode === "all" || row.mode === mode) &&
      (hostId === "all" || row.hostId === hostId) &&
      (project === "all" || (row.hostId === project.hostId && row.projectId === project.projectId)),
  );
}
