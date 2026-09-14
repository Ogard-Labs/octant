import type { SidebarRowProperties, SidebarRowPropertyVisibility } from "@octant/contracts/shell";
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
 * views, their supported properties, the context that carries the resolved
 * record to the rows several groups, shelves and folds below the sidebar, and
 * the one-time adoption of a choice a renderer persisted before the move.
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

/**
 * Where a renderer older than the host-backed setting stored each view's
 * choice. The host record is authoritative; this prefix exists only so a
 * choice made before the move can survive it, and is read once per renderer.
 */
export const LEGACY_SIDEBAR_ROW_PROPERTIES_STORAGE_KEY = "octant.sidebar.row-properties.v1";

type LegacySidebarRowPropertiesStorage = Pick<Storage, "getItem" | "removeItem">;

function legacyStorageKey(view: SidebarRowPropertyView): string {
  return `${LEGACY_SIDEBAR_ROW_PROPERTIES_STORAGE_KEY}.${view}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLegacyStorage(
  storage: LegacySidebarRowPropertiesStorage | undefined,
  storageHolder: { readonly localStorage?: Storage },
): LegacySidebarRowPropertiesStorage | undefined {
  return storage ?? storageHolder.localStorage;
}

/**
 * Normalizes one view's pre-host record onto that view's defaults, or answers
 * `undefined` when the stored value is not a record. A malformed record is
 * absent, not a choice.
 */
function normalizeLegacySidebarRowProperties(
  view: SidebarRowPropertyView,
  raw: string,
): SidebarRowPropertyVisibility | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const next: Record<SidebarRowProperty, boolean> = { ...DEFAULT_SIDEBAR_ROW_PROPERTIES[view] };
    for (const property of SIDEBAR_ROW_PROPERTIES_FOR_VIEW[view]) {
      const saved = parsed[property];
      if (typeof saved === "boolean") next[property] = saved;
    }
    return next;
  } catch {
    return undefined;
  }
}

function sameSidebarRowPropertyVisibility(
  left: SidebarRowPropertyVisibility,
  right: SidebarRowPropertyVisibility,
): boolean {
  return ALL_SIDEBAR_ROW_PROPERTIES.every((property) => left[property] === right[property]);
}

function forgetLegacySidebarRowProperties(storage: LegacySidebarRowPropertiesStorage): void {
  try {
    for (const view of ALL_SIDEBAR_ROW_PROPERTY_VIEWS) storage.removeItem(legacyStorageKey(view));
  } catch {
    // Best-effort; a key left behind is inert once the host owns the choice.
  }
}

/**
 * Moves the choices a renderer persisted before the host owned this setting
 * onto the host record.
 *
 * The first settings read after boot is the only moment the host record can be
 * trusted untouched: afterwards a person may have changed it. For every legacy
 * key that exists:
 *
 * - when the host record for a view still equals its defaults and the legacy
 *   record differs, the legacy choice is written through `updateSettings`, and
 *   the keys are cleared once the host accepts it, so a write that never lands
 *   can be retried;
 * - when the host record was already changed, it stays authoritative and the
 *   keys are cleared without seeding anything.
 *
 * A renderer that never wrote a legacy key does nothing.
 */
export function adoptLegacySidebarRowProperties(input: {
  readonly current: SidebarRowProperties;
  readonly updateSettings: (next: SidebarRowProperties) => Promise<boolean>;
  readonly storage?: LegacySidebarRowPropertiesStorage;
  readonly storageHolder?: { readonly localStorage?: Storage };
}): void {
  const storage = resolveLegacyStorage(input.storage, input.storageHolder ?? globalThis);
  if (storage === undefined) return;
  let hasLegacyRecord = false;
  let seeded = false;
  const next: Record<SidebarRowPropertyView, SidebarRowPropertyVisibility> = {
    projects: input.current.projects,
    activity: input.current.activity,
  };
  for (const view of ALL_SIDEBAR_ROW_PROPERTY_VIEWS) {
    let raw: string | null;
    try {
      raw = storage.getItem(legacyStorageKey(view));
    } catch {
      continue;
    }
    if (raw === null || raw.trim() === "") continue;
    hasLegacyRecord = true;
    const legacy = normalizeLegacySidebarRowProperties(view, raw);
    if (
      legacy !== undefined &&
      sameSidebarRowPropertyVisibility(input.current[view], DEFAULT_SIDEBAR_ROW_PROPERTIES[view]) &&
      !sameSidebarRowPropertyVisibility(legacy, DEFAULT_SIDEBAR_ROW_PROPERTIES[view])
    ) {
      next[view] = legacy;
      seeded = true;
    }
  }
  if (!hasLegacyRecord) return;
  if (!seeded) {
    forgetLegacySidebarRowProperties(storage);
    return;
  }
  void input
    .updateSettings({ projects: next.projects, activity: next.activity })
    .then((committed) => {
      if (committed) forgetLegacySidebarRowProperties(storage);
    })
    .catch(() => undefined);
}
