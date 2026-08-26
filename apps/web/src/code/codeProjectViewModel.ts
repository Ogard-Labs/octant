import {
  DEFAULT_PROJECT_VIEW_FILTERS,
  filterProjectViewThreads,
  filterProjectsForView as filterProjectsByViewFilters,
  normalizeProjectViewFilters,
  projectViewActivityRange,
  projectViewActivityRangeError,
  type ProjectViewActivityPeriod,
  type ProjectViewActivityRange,
  type ProjectViewEnvironment,
  type ProjectViewFilters,
  type ProjectViewGrouping,
  type ProjectViewLifecycle,
  type ProjectViewProjectLike,
  type ProjectViewSort,
  type ProjectViewThreadLike,
} from "@octant/domain";

export {
  DEFAULT_PROJECT_VIEW_FILTERS,
  filterProjectViewThreads,
  normalizeProjectViewFilters,
  projectViewActivityRange,
  projectViewActivityRangeError,
};
export type {
  ProjectViewActivityPeriod,
  ProjectViewActivityRange,
  ProjectViewEnvironment,
  ProjectViewFilters,
  ProjectViewGrouping,
  ProjectViewLifecycle,
  ProjectViewProjectLike,
  ProjectViewSort,
  ProjectViewThreadLike,
};

export const CODE_PROJECT_VIEWS_STORAGE_KEY = "octant.code.project-views.v1";
export const WORK_PROJECT_VIEWS_STORAGE_KEY = "octant.work.project-views.v1";
export const ALL_CODE_PROJECTS_VIEW_ID = "all";
export const ALL_CODE_PROJECTS_VIEW_NAME = "All Projects";

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export const CODE_PROJECT_VIEW_ICONS = [
  "folder",
  "folder-git",
  "code",
  "terminal",
  "box",
  "layers",
  "rocket",
  "star",
  "flag",
  "bug",
  "briefcase",
  "sparkles",
] as const;
export type CodeProjectViewIcon = (typeof CODE_PROJECT_VIEW_ICONS)[number];
export const DEFAULT_CODE_PROJECT_VIEW_ICON: CodeProjectViewIcon = "folder";

export const CODE_PROJECT_VIEW_COLORS = [
  "neutral",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
export type CodeProjectViewColor = (typeof CODE_PROJECT_VIEW_COLORS)[number];
export const DEFAULT_CODE_PROJECT_VIEW_COLOR: CodeProjectViewColor = "neutral";

export const CODE_PROJECT_VIEW_PREFERENCES_STORAGE_KEY = "octant.code.project-view-preferences.v1";
export const WORK_PROJECT_VIEW_PREFERENCES_STORAGE_KEY = "octant.work.project-view-preferences.v1";

export interface CodeProjectView {
  readonly id: string;
  readonly name: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly icon: CodeProjectViewIcon;
  readonly color: CodeProjectViewColor;
  /** Omitted on legacy views; readers apply DEFAULT_PROJECT_VIEW_FILTERS. */
  readonly filters?: ProjectViewFilters;
}

export interface CodeProjectViewInput {
  readonly id: string;
  readonly name: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly icon?: CodeProjectViewIcon;
  readonly color?: CodeProjectViewColor;
  readonly filters?: ProjectViewFilters;
}

export interface CodeProjectViewState {
  readonly activeViewId: string;
  readonly views: ReadonlyArray<CodeProjectView>;
}

export interface CodeProjectViewCandidate {
  readonly id: string;
  readonly name: string;
}

export interface ProjectViewPreferences {
  readonly filters: ProjectViewFilters;
}

export type ProjectViewMode = "code" | "work";

function projectViewStorageKey(mode: ProjectViewMode): string {
  return mode === "code" ? CODE_PROJECT_VIEWS_STORAGE_KEY : WORK_PROJECT_VIEWS_STORAGE_KEY;
}

function projectViewPreferencesStorageKey(mode: ProjectViewMode): string {
  return mode === "code"
    ? CODE_PROJECT_VIEW_PREFERENCES_STORAGE_KEY
    : WORK_PROJECT_VIEW_PREFERENCES_STORAGE_KEY;
}

export function defaultCodeProjectViewState(): CodeProjectViewState {
  return { activeViewId: ALL_CODE_PROJECTS_VIEW_ID, views: [] };
}

export function readCodeProjectViewState(
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): CodeProjectViewState {
  return readProjectViewState("code", storage);
}

export function readProjectViewState(
  mode: ProjectViewMode,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): CodeProjectViewState {
  if (storage === undefined) return defaultCodeProjectViewState();
  try {
    const raw = storage.getItem(projectViewStorageKey(mode));
    if (raw === null || raw.trim() === "") return defaultCodeProjectViewState();
    return normalizeCodeProjectViewState(JSON.parse(raw));
  } catch {
    return defaultCodeProjectViewState();
  }
}

export function writeCodeProjectViewState(
  state: CodeProjectViewState,
  storage: Pick<Storage, "setItem"> | undefined = defaultStorage(),
): void {
  writeProjectViewState("code", state, storage);
}

export function writeProjectViewState(
  mode: ProjectViewMode,
  state: CodeProjectViewState,
  storage: Pick<Storage, "setItem"> | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(
      projectViewStorageKey(mode),
      JSON.stringify(normalizeCodeProjectViewState(state)),
    );
  } catch {
    // Presentation persistence is best-effort; the current session still switches.
  }
}

export function defaultProjectViewPreferences(): ProjectViewPreferences {
  return { filters: DEFAULT_PROJECT_VIEW_FILTERS };
}

export function readProjectViewPreferences(
  mode: ProjectViewMode,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): ProjectViewPreferences {
  if (storage === undefined) return defaultProjectViewPreferences();
  try {
    const raw = storage.getItem(projectViewPreferencesStorageKey(mode));
    if (raw === null || raw.trim() === "") return defaultProjectViewPreferences();
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return defaultProjectViewPreferences();
    const record = value as { readonly filters?: unknown };
    return { filters: normalizeProjectViewFilters(record.filters) };
  } catch {
    return defaultProjectViewPreferences();
  }
}

export function writeProjectViewPreferences(
  mode: ProjectViewMode,
  preferences: ProjectViewPreferences,
  storage: Pick<Storage, "setItem"> | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(
      projectViewPreferencesStorageKey(mode),
      JSON.stringify({ filters: normalizeProjectViewFilters(preferences.filters) }),
    );
  } catch {
    // Presentation persistence is best-effort; the current session still filters.
  }
}

export function projectViewFiltersFor(
  state: CodeProjectViewState,
  viewId: string,
  allProjects: ProjectViewPreferences = defaultProjectViewPreferences(),
): ProjectViewFilters {
  if (viewId === ALL_CODE_PROJECTS_VIEW_ID) return normalizeProjectViewFilters(allProjects.filters);
  return normalizeProjectViewFilters(state.views.find((view) => view.id === viewId)?.filters);
}

export function updateCodeProjectViewFilters(
  state: CodeProjectViewState,
  viewId: string,
  filters: ProjectViewFilters,
): CodeProjectViewState {
  if (viewId === ALL_CODE_PROJECTS_VIEW_ID) return normalizeCodeProjectViewState(state);
  return normalizeCodeProjectViewState({
    ...state,
    views: state.views.map((view) =>
      view.id === viewId ? { ...view, filters: normalizeProjectViewFilters(filters) } : view,
    ),
  });
}

export function createCodeProjectView(
  state: CodeProjectViewState,
  input: CodeProjectViewInput,
): CodeProjectViewState {
  const view = normalizeView(input);
  if (view === undefined) return normalizeCodeProjectViewState(state);
  const views = [...state.views.filter((candidate) => candidate.id !== view.id), view];
  return normalizeCodeProjectViewState({ activeViewId: view.id, views });
}

export function updateCodeProjectView(
  state: CodeProjectViewState,
  input: CodeProjectViewInput,
): CodeProjectViewState {
  const view = normalizeView(input);
  if (view === undefined) return normalizeCodeProjectViewState(state);
  const views = state.views.map((candidate) =>
    candidate.id === view.id && view.filters === undefined && candidate.filters !== undefined
      ? { ...view, filters: candidate.filters }
      : candidate.id === view.id
        ? view
        : candidate,
  );
  if (!views.some((candidate) => candidate.id === view.id)) {
    return createCodeProjectView(state, view);
  }
  return normalizeCodeProjectViewState({
    activeViewId: view.id,
    views,
  });
}

export function deleteCodeProjectView(
  state: CodeProjectViewState,
  viewId: string,
): CodeProjectViewState {
  return normalizeCodeProjectViewState({
    activeViewId: state.activeViewId === viewId ? ALL_CODE_PROJECTS_VIEW_ID : state.activeViewId,
    views: state.views.filter((view) => view.id !== viewId),
  });
}

export function selectCodeProjectView(
  state: CodeProjectViewState,
  viewId: string,
): CodeProjectViewState {
  return normalizeCodeProjectViewState({
    ...state,
    activeViewId: viewId,
  });
}

export function visibleCodeProjects<T extends { readonly id: string }>(
  projects: ReadonlyArray<T>,
  state: CodeProjectViewState,
): ReadonlyArray<T> {
  const normalized = normalizeCodeProjectViewState(state);
  if (normalized.activeViewId === ALL_CODE_PROJECTS_VIEW_ID) return projects;
  const active = normalized.views.find((view) => view.id === normalized.activeViewId);
  if (active === undefined) return projects;
  const allowed = new Set(active.projectIds);
  return projects.filter((project) => allowed.has(String(project.id)));
}

/**
 * Applies the saved Project View membership and its normalized filters to the
 * server-authored Project summaries. Projects without an explicit environment
 * projection are local by definition; no remote host is inferred.
 */
export function filterProjectsForView<T extends ProjectViewProjectLike>(
  projects: ReadonlyArray<T>,
  state: CodeProjectViewState,
  preferences: ProjectViewPreferences = defaultProjectViewPreferences(),
  environmentByProjectId: ReadonlyMap<string, ProjectViewEnvironment> = new Map(),
): ReadonlyArray<T> {
  return filterProjectsByViewFilters(
    visibleCodeProjects(projects, state),
    projectViewFiltersFor(state, state.activeViewId, preferences),
    environmentByProjectId,
  );
}

/**
 * The menu lists Local plus named connected hosts the window actually reported.
 * A host that is not in that catalog is a dead choice, not an environment.
 */
export function projectViewEnvironmentOptionsFromHosts(
  hosts: ReadonlyArray<{ readonly hostId: string; readonly displayName: string }>,
): ReadonlyArray<ProjectViewEnvironment> {
  const local = { id: "local", name: "Local" };
  const seen = new Set<string>([local.id]);
  const remotes: ProjectViewEnvironment[] = [];
  for (const host of hosts) {
    const id = String(host.hostId).trim();
    if (id === "" || seen.has(id)) continue;
    const name = host.displayName.trim();
    if (name === "") continue;
    seen.add(id);
    remotes.push({ id, name });
  }
  return [local, ...remotes];
}

export function createCodeProjectViewId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `view-${globalThis.crypto.randomUUID()}`;
  }
  return `view-${Date.now().toString(36)}`;
}

function normalizeCodeProjectViewState(value: unknown): CodeProjectViewState {
  if (value === null || typeof value !== "object") return defaultCodeProjectViewState();
  const record = value as {
    readonly activeViewId?: unknown;
    readonly views?: unknown;
  };
  const views = Array.isArray(record.views)
    ? record.views.flatMap((view) => {
        const normalized = normalizeView(view);
        return normalized === undefined ? [] : [normalized];
      })
    : [];
  const seen = new Set<string>();
  const uniqueViews = views.filter((view) => {
    if (seen.has(view.id)) return false;
    seen.add(view.id);
    return true;
  });
  const requested =
    typeof record.activeViewId === "string" && record.activeViewId.trim() !== ""
      ? record.activeViewId
      : ALL_CODE_PROJECTS_VIEW_ID;
  const activeViewId =
    requested === ALL_CODE_PROJECTS_VIEW_ID || uniqueViews.some((view) => view.id === requested)
      ? requested
      : ALL_CODE_PROJECTS_VIEW_ID;
  return { activeViewId, views: uniqueViews };
}

function normalizeView(value: unknown): CodeProjectView | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly projectIds?: unknown;
    readonly icon?: unknown;
    readonly color?: unknown;
    readonly filters?: unknown;
    readonly filter?: unknown;
    readonly lifecycle?: unknown;
    readonly environmentIds?: unknown;
    readonly showEmptyProjects?: unknown;
    readonly grouping?: unknown;
    readonly sorting?: unknown;
    readonly activity?: unknown;
    readonly activityRange?: unknown;
  };
  if (
    typeof record.id !== "string" ||
    record.id.trim() === "" ||
    record.id === ALL_CODE_PROJECTS_VIEW_ID
  ) {
    return undefined;
  }
  if (typeof record.name !== "string") return undefined;
  const name = record.name.trim();
  if (name === "" || name.toLowerCase() === ALL_CODE_PROJECTS_VIEW_NAME.toLowerCase()) {
    return undefined;
  }
  if (!Array.isArray(record.projectIds)) return undefined;
  const projectIds = [
    ...new Set(
      record.projectIds.filter(
        (projectId): projectId is string =>
          typeof projectId === "string" && projectId.trim() !== "",
      ),
    ),
  ];
  const icon = CODE_PROJECT_VIEW_ICONS.find((candidate) => candidate === record.icon);
  const color = CODE_PROJECT_VIEW_COLORS.find((candidate) => candidate === record.color);
  const legacyFilters =
    record.filters ??
    record.filter ??
    (record.lifecycle === undefined &&
    record.environmentIds === undefined &&
    record.showEmptyProjects === undefined &&
    record.grouping === undefined &&
    record.sorting === undefined &&
    record.activity === undefined &&
    record.activityRange === undefined
      ? undefined
      : {
          lifecycle: record.lifecycle,
          environmentIds: record.environmentIds,
          showEmptyProjects: record.showEmptyProjects,
          grouping: record.grouping,
          sorting: record.sorting,
          activity: record.activity,
          activityRange: record.activityRange,
        });
  const filters = normalizeProjectViewFilters(legacyFilters);
  return {
    id: record.id,
    name,
    projectIds,
    icon: icon ?? DEFAULT_CODE_PROJECT_VIEW_ICON,
    color: color ?? DEFAULT_CODE_PROJECT_VIEW_COLOR,
    ...(legacyFilters === undefined ? {} : { filters }),
  };
}
