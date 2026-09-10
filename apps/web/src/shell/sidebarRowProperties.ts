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
 * Only properties the row already has data for appear here. Environment is not
 * one: the host attributes an environment to a Project, not to a thread, so a
 * row could only guess at one.
 */
export const SIDEBAR_ROW_PROPERTIES_STORAGE_KEY = "octant.sidebar.row-properties.v1";

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

export type SidebarRowPropertyVisibility = Readonly<Record<SidebarRowProperty, boolean>>;

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

/** Each view's defaults are exactly what it showed before it could be told otherwise. */
const DEFAULTS: Readonly<Record<SidebarRowPropertyView, SidebarRowPropertyVisibility>> = {
  projects: { project: false, branch: true, pullRequest: true, lastUpdated: true, status: true },
  activity: { project: true, branch: false, pullRequest: false, lastUpdated: false, status: true },
};

export function defaultSidebarRowProperties(
  view: SidebarRowPropertyView,
): SidebarRowPropertyVisibility {
  return DEFAULTS[view];
}

/** Every property this view can render, shown or hidden together. */
export function sidebarRowPropertiesAll(
  view: SidebarRowPropertyView,
  visible: boolean,
): SidebarRowPropertyVisibility {
  const supported = SIDEBAR_ROW_PROPERTIES_FOR_VIEW[view];
  const next: Record<SidebarRowProperty, boolean> = { ...DEFAULTS[view] };
  for (const property of supported) next[property] = visible;
  return next;
}

function storageKey(view: SidebarRowPropertyView): string {
  return `${SIDEBAR_ROW_PROPERTIES_STORAGE_KEY}.${view}`;
}

function resolveStorage(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  storageHolder: { readonly localStorage?: Storage },
): Pick<Storage, "getItem" | "setItem"> | undefined {
  return storage ?? storageHolder.localStorage;
}

/**
 * Reads a saved choice back onto the view's defaults. A property the saved
 * record does not mention — because it did not exist when the record was
 * written — keeps the default rather than disappearing from the row.
 */
export function normalizeSidebarRowProperties(
  view: SidebarRowPropertyView,
  value: unknown,
): SidebarRowPropertyVisibility {
  if (value === null || typeof value !== "object") return DEFAULTS[view];
  const record = value as Record<string, unknown>;
  const next: Record<SidebarRowProperty, boolean> = { ...DEFAULTS[view] };
  for (const property of SIDEBAR_ROW_PROPERTIES_FOR_VIEW[view]) {
    const saved = record[property];
    if (typeof saved === "boolean") next[property] = saved;
  }
  return next;
}

export function readSidebarRowProperties(
  view: SidebarRowPropertyView,
  storage?: Pick<Storage, "getItem" | "setItem">,
  storageHolder: { readonly localStorage?: Storage } = globalThis,
): SidebarRowPropertyVisibility {
  try {
    const resolved = resolveStorage(storage, storageHolder);
    if (resolved === undefined) return DEFAULTS[view];
    const raw = resolved.getItem(storageKey(view));
    if (raw === null || raw.trim() === "") return DEFAULTS[view];
    return normalizeSidebarRowProperties(view, JSON.parse(raw));
  } catch {
    return DEFAULTS[view];
  }
}

export function writeSidebarRowProperties(
  view: SidebarRowPropertyView,
  visibility: SidebarRowPropertyVisibility,
  storage?: Pick<Storage, "getItem" | "setItem">,
  storageHolder: { readonly localStorage?: Storage } = globalThis,
): void {
  try {
    const resolved = resolveStorage(storage, storageHolder);
    if (resolved === undefined) return;
    const record: Record<string, boolean> = {};
    for (const property of SIDEBAR_ROW_PROPERTIES_FOR_VIEW[view]) {
      record[property] = visibility[property];
    }
    resolved.setItem(storageKey(view), JSON.stringify(record));
  } catch {
    // Presentation persistence is best-effort; the current session still applies.
  }
}

/**
 * Rows read their properties from context rather than a prop threaded through
 * every group, shelf, and fold, so the two views can sit in one tree with
 * different answers and a memoized row still re-renders when its view's
 * choice changes.
 */
export const SidebarRowPropertiesContext = createContext<SidebarRowPropertyVisibility>(
  DEFAULTS.projects,
);

export function useSidebarRowProperties(): SidebarRowPropertyVisibility {
  return useContext(SidebarRowPropertiesContext);
}
