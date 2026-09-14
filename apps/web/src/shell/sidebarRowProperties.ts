import type { SidebarRowPropertyVisibility } from "@octant/contracts/shell";
import { DEFAULT_SIDEBAR_ROW_PROPERTIES } from "@octant/contracts/shell";
import { createContext, useContext } from "react";

/**
 * Which properties a sidebar thread row carries, chosen separately for each
 * sidebar view.
 *
 * The Projects tree and the Activity feed answer different questions — where a
 * thread lives versus what happened lately — so a person reading one of them
 * wants a different amount on each row. One shared choice would make quieting
 * the Activity feed also strip the Project tree, which is why the stored
 * choice is keyed by view rather than by mode or by saved Project view.
 *
 * The host-backed shell settings own the choice; this module only names the
 * views, their supported properties, and the context that carries the resolved
 * record to the rows several groups, shelves and folds below the sidebar.
 */

export const ALL_SIDEBAR_ROW_PROPERTY_VIEWS = ["projects", "activity"] as const;
export type SidebarRowPropertyView = (typeof ALL_SIDEBAR_ROW_PROPERTY_VIEWS)[number];

export const ALL_SIDEBAR_ROW_PROPERTIES = [
  "project",
  "branch",
  "pullRequest",
  "lastUpdated",
  "status",
] as const;
export type SidebarRowProperty = (typeof ALL_SIDEBAR_ROW_PROPERTIES)[number];

export const SIDEBAR_ROW_PROPERTY_LABELS: Readonly<Record<SidebarRowProperty, string>> = {
  project: "Project",
  branch: "Branch",
  pullRequest: "Pull request",
  lastUpdated: "Last updated",
  status: "Status",
};

/**
 * The properties each view can actually put on a row. A Projects row already
 * sits under its Project heading, so it offers no Project property rather than
 * a toggle that changes nothing.
 */
export const SIDEBAR_ROW_PROPERTIES_FOR_VIEW: Readonly<
  Record<SidebarRowPropertyView, ReadonlyArray<SidebarRowProperty>>
> = {
  projects: ["branch", "pullRequest", "lastUpdated", "status"],
  activity: ["project", "branch", "pullRequest", "lastUpdated", "status"],
};

/** Every property this view can render, shown or hidden together. */
export function sidebarRowPropertiesAll(
  view: SidebarRowPropertyView,
  visible: boolean,
): SidebarRowPropertyVisibility {
  const supported = SIDEBAR_ROW_PROPERTIES_FOR_VIEW[view];
  const next: Record<SidebarRowProperty, boolean> = { ...DEFAULT_SIDEBAR_ROW_PROPERTIES[view] };
  for (const property of supported) next[property] = visible;
  return next;
}

export const SidebarRowPropertiesContext = createContext<SidebarRowPropertyVisibility>(
  DEFAULT_SIDEBAR_ROW_PROPERTIES.projects,
);

export function useSidebarRowProperties(): SidebarRowPropertyVisibility {
  return useContext(SidebarRowPropertiesContext);
}
