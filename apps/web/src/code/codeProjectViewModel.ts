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

/** The lifecycle scope used by a Project View. */
export const PROJECT_VIEW_LIFECYCLES = ["active", "archived", "all"] as const;
export type ProjectViewLifecycle = (typeof PROJECT_VIEW_LIFECYCLES)[number];

/** Grouping choices intentionally stay at the Project-list seam. */
export const PROJECT_VIEW_GROUPINGS = ["project", "environment", "status", "none"] as const;
export type ProjectViewGrouping = (typeof PROJECT_VIEW_GROUPINGS)[number];

export const PROJECT_VIEW_SORTS = ["recency", "alphabetical", "created"] as const;
export type ProjectViewSort = (typeof PROJECT_VIEW_SORTS)[number];

export const PROJECT_VIEW_ACTIVITY_PERIODS = [
  "all",
  "today",
  "3-days",
  "7-days",
  "14-days",
  "30-days",
  "custom",
] as const;
export type ProjectViewActivityPeriod = (typeof PROJECT_VIEW_ACTIVITY_PERIODS)[number];

export interface ProjectViewActivityRange {
  readonly from?: string;
  readonly to?: string;
}

export interface ProjectViewFilters {
  readonly lifecycle: ProjectViewLifecycle;
  /** Empty means every environment. `local` is the only implicit environment. */
  readonly environmentIds: ReadonlyArray<string>;
  readonly showEmptyProjects: boolean;
  readonly grouping: ProjectViewGrouping;
  readonly sorting: ProjectViewSort;
  readonly activity: ProjectViewActivityPeriod;
  readonly activityRange?: ProjectViewActivityRange;
}

export interface ProjectViewEnvironment {
  readonly id: string;
  readonly name: string;
}

export const DEFAULT_PROJECT_VIEW_FILTERS: ProjectViewFilters = {
  lifecycle: "active",
  environmentIds: [],
  showEmptyProjects: true,
  grouping: "project",
  sorting: "recency",
  activity: "all",
};

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

export interface ProjectViewProjectLike {
  readonly id: string;
  readonly lifecycle?: ProjectViewLifecycle;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ProjectViewThreadLike {
  readonly projectId?: string;
  readonly updatedAt?: string;
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
  const filters = projectViewFiltersFor(state, state.activeViewId, preferences);
  const selected = visibleCodeProjects(projects, state);
  return selected.filter((project) => {
    const lifecycle = project.lifecycle ?? "active";
    if (filters.lifecycle !== "all" && lifecycle !== filters.lifecycle) return false;
    if (filters.environmentIds.length === 0) return true;
    const environment = environmentByProjectId.get(String(project.id));
    const environmentId = environment?.id ?? "local";
    return filters.environmentIds.includes(environmentId);
  });
}

/** Returns only server-authored thread activity in the requested inclusive window. */
export function filterProjectViewThreads<T extends ProjectViewThreadLike>(
  threads: ReadonlyArray<T>,
  filters: ProjectViewFilters,
  now: Date = new Date(),
): ReadonlyArray<T> {
  if (filters.activity === "all") return threads;
  const range = projectViewActivityRange(filters, now);
  if (range === undefined) return threads;
  return threads.filter((thread) => {
    if (thread.updatedAt === undefined) return false;
    const timestamp = Date.parse(thread.updatedAt);
    if (Number.isNaN(timestamp)) return false;
    return timestamp >= range.from.getTime() && timestamp <= range.to.getTime();
  });
}

export function projectViewActivityRange(
  filters: ProjectViewFilters,
  now: Date = new Date(),
): { readonly from: Date; readonly to: Date } | undefined {
  if (filters.activity === "all") return undefined;
  if (filters.activity === "custom") {
    const from = parseLocalDateStart(filters.activityRange?.from);
    const to = parseLocalDateEnd(filters.activityRange?.to);
    if (from === undefined && to === undefined) return undefined;
    return {
      from: from ?? new Date(0),
      to: to ?? new Date(8640000000000000),
    };
  }
  const days =
    filters.activity === "today"
      ? 1
      : filters.activity === "3-days"
        ? 3
        : filters.activity === "7-days"
          ? 7
          : filters.activity === "14-days"
            ? 14
            : 30;
  const today = localDayStart(now);
  return {
    from: new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1),
    to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 0, 0, 0, -1),
  };
}

function parseLocalDateStart(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseLocalDateEnd(value: string | undefined): Date | undefined {
  const start = parseLocalDateStart(value);
  if (start === undefined) return undefined;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  end.setMilliseconds(-1);
  return end;
}

function localDayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
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

export function normalizeProjectViewFilters(value: unknown): ProjectViewFilters {
  if (value === null || typeof value !== "object") return DEFAULT_PROJECT_VIEW_FILTERS;
  const record = value as {
    readonly lifecycle?: unknown;
    readonly environmentIds?: unknown;
    readonly environments?: unknown;
    readonly showEmptyProjects?: unknown;
    readonly grouping?: unknown;
    readonly sorting?: unknown;
    readonly activity?: unknown;
    readonly activityRange?: unknown;
  };
  const lifecycle = PROJECT_VIEW_LIFECYCLES.find((candidate) => candidate === record.lifecycle);
  const grouping = PROJECT_VIEW_GROUPINGS.find((candidate) => candidate === record.grouping);
  const sorting = PROJECT_VIEW_SORTS.find((candidate) => candidate === record.sorting);
  const activity = PROJECT_VIEW_ACTIVITY_PERIODS.find((candidate) => candidate === record.activity);
  const environmentValue = record.environmentIds ?? record.environments;
  const environmentIds = Array.isArray(environmentValue)
    ? [
        ...new Set(
          environmentValue.filter(
            (environment): environment is string =>
              typeof environment === "string" && environment.trim() !== "",
          ),
        ),
      ]
    : [];
  const range = normalizeActivityRange(record.activityRange);
  return {
    lifecycle: lifecycle ?? DEFAULT_PROJECT_VIEW_FILTERS.lifecycle,
    environmentIds,
    showEmptyProjects:
      typeof record.showEmptyProjects === "boolean"
        ? record.showEmptyProjects
        : DEFAULT_PROJECT_VIEW_FILTERS.showEmptyProjects,
    grouping: grouping ?? DEFAULT_PROJECT_VIEW_FILTERS.grouping,
    sorting: sorting ?? DEFAULT_PROJECT_VIEW_FILTERS.sorting,
    activity: activity ?? DEFAULT_PROJECT_VIEW_FILTERS.activity,
    ...(range === undefined ? {} : { activityRange: range }),
  };
}

function normalizeActivityRange(value: unknown): ProjectViewActivityRange | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as { readonly from?: unknown; readonly to?: unknown };
  const from = normalizeDateOnly(record.from);
  const to = normalizeDateOnly(record.to);
  if (from === undefined && to === undefined) return undefined;
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function normalizeDateOnly(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : value;
}
