export const CODE_PROJECT_VIEWS_STORAGE_KEY = "octant.code.project-views.v1";
export const ALL_CODE_PROJECTS_VIEW_ID = "all";
export const ALL_CODE_PROJECTS_VIEW_NAME = "All Projects";

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export interface CodeProjectView {
  readonly id: string;
  readonly name: string;
  readonly projectIds: ReadonlyArray<string>;
}

export interface CodeProjectViewState {
  readonly activeViewId: string;
  readonly views: ReadonlyArray<CodeProjectView>;
}

export interface CodeProjectViewCandidate {
  readonly id: string;
  readonly name: string;
}

export function defaultCodeProjectViewState(): CodeProjectViewState {
  return { activeViewId: ALL_CODE_PROJECTS_VIEW_ID, views: [] };
}

export function readCodeProjectViewState(
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): CodeProjectViewState {
  if (storage === undefined) return defaultCodeProjectViewState();
  try {
    const raw = storage.getItem(CODE_PROJECT_VIEWS_STORAGE_KEY);
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
  if (storage === undefined) return;
  try {
    storage.setItem(
      CODE_PROJECT_VIEWS_STORAGE_KEY,
      JSON.stringify(normalizeCodeProjectViewState(state)),
    );
  } catch {
    // Presentation persistence is best-effort; the current session still switches.
  }
}

export function createCodeProjectView(
  state: CodeProjectViewState,
  input: {
    readonly id: string;
    readonly name: string;
    readonly projectIds: ReadonlyArray<string>;
  },
): CodeProjectViewState {
  const view = normalizeView(input);
  if (view === undefined) return normalizeCodeProjectViewState(state);
  const views = [...state.views.filter((candidate) => candidate.id !== view.id), view];
  return normalizeCodeProjectViewState({ activeViewId: view.id, views });
}

export function updateCodeProjectView(
  state: CodeProjectViewState,
  input: {
    readonly id: string;
    readonly name: string;
    readonly projectIds: ReadonlyArray<string>;
  },
): CodeProjectViewState {
  const view = normalizeView(input);
  if (view === undefined) return normalizeCodeProjectViewState(state);
  const views = state.views.map((candidate) => (candidate.id === view.id ? view : candidate));
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
  return { id: record.id, name, projectIds };
}
