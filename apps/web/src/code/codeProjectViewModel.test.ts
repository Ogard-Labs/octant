import { describe, expect, it } from "vitest";
import {
  ALL_CODE_PROJECTS_VIEW_ID,
  CODE_PROJECT_VIEWS_STORAGE_KEY,
  WORK_PROJECT_VIEWS_STORAGE_KEY,
  createCodeProjectView,
  defaultProjectViewPreferences,
  deleteCodeProjectView,
  filterProjectViewThreads,
  filterProjectsForView,
  projectViewActivityRangeError,
  projectViewActivityRange,
  projectViewEnvironmentOptionsFromHosts,
  readCodeProjectViewState,
  readProjectViewPreferences,
  readProjectViewState,
  selectCodeProjectView,
  updateCodeProjectViewFilters,
  visibleCodeProjects,
  writeCodeProjectViewState,
  writeProjectViewState,
} from "./codeProjectViewModel";

const alpha = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "octant",
};
const beta = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "auroradocs",
};

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    key() {
      return null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

describe("codeProjectViewModel", () => {
  it("defaults to every Code Project and persists a named subset", () => {
    const storage = memoryStorage();
    expect(readCodeProjectViewState(storage)).toEqual({
      activeViewId: ALL_CODE_PROJECTS_VIEW_ID,
      views: [],
    });
    expect(visibleCodeProjects([alpha, beta], readCodeProjectViewState(storage))).toEqual([
      alpha,
      beta,
    ]);

    const created = createCodeProjectView(readCodeProjectViewState(storage), {
      id: "view-main",
      name: "  Main  ",
      projectIds: [alpha.id, alpha.id, "missing"],
    });
    writeCodeProjectViewState(created, storage);

    expect(storage.getItem(CODE_PROJECT_VIEWS_STORAGE_KEY)).toContain("Main");
    const restored = readCodeProjectViewState(storage);
    expect(restored.activeViewId).toBe("view-main");
    expect(restored.views).toEqual([
      {
        id: "view-main",
        name: "Main",
        projectIds: [alpha.id, "missing"],
        icon: "folder",
        color: "neutral",
      },
    ]);
    expect(visibleCodeProjects([alpha, beta], restored)).toEqual([alpha]);
  });

  it("falls back to all Projects when the saved view is missing or corrupt", () => {
    const storage = memoryStorage({
      [CODE_PROJECT_VIEWS_STORAGE_KEY]: "{not-json",
    });
    expect(readCodeProjectViewState(storage).activeViewId).toBe(ALL_CODE_PROJECTS_VIEW_ID);

    const selected = selectCodeProjectView(
      {
        activeViewId: "view-main",
        views: [
          {
            id: "view-main",
            name: "Main",
            projectIds: [alpha.id],
            icon: "folder",
            color: "neutral",
          },
        ],
      },
      "missing",
    );
    expect(selected.activeViewId).toBe(ALL_CODE_PROJECTS_VIEW_ID);
    expect(visibleCodeProjects([alpha, beta], selected)).toEqual([alpha, beta]);
  });

  it("persists a view icon and color and normalizes unknown values to defaults", () => {
    const storage = memoryStorage();
    writeCodeProjectViewState(
      createCodeProjectView(readCodeProjectViewState(storage), {
        id: "view-main",
        name: "Main",
        projectIds: [alpha.id],
        icon: "rocket",
        color: "purple",
      }),
      storage,
    );
    expect(readCodeProjectViewState(storage).views[0]).toMatchObject({
      icon: "rocket",
      color: "purple",
    });

    storage.setItem(
      CODE_PROJECT_VIEWS_STORAGE_KEY,
      JSON.stringify({
        activeViewId: "view-main",
        views: [{ id: "view-main", name: "Main", projectIds: [alpha.id], icon: "nope", color: 42 }],
      }),
    );
    expect(readCodeProjectViewState(storage).views[0]).toMatchObject({
      icon: "folder",
      color: "neutral",
    });
  });

  it("rejects the reserved All Projects label", () => {
    const next = createCodeProjectView(readCodeProjectViewState(), {
      id: "view-all",
      name: "All Projects",
      projectIds: [alpha.id],
    });
    expect(next).toEqual({
      activeViewId: ALL_CODE_PROJECTS_VIEW_ID,
      views: [],
    });
  });

  it("deletes a custom view and returns to all Projects", () => {
    const next = deleteCodeProjectView(
      {
        activeViewId: "view-main",
        views: [
          {
            id: "view-main",
            name: "Main",
            projectIds: [alpha.id],
            icon: "folder",
            color: "neutral",
          },
        ],
      },
      "view-main",
    );
    expect(next).toEqual({
      activeViewId: ALL_CODE_PROJECTS_VIEW_ID,
      views: [],
    });
  });

  it("keeps Work and Code Project View sets separate", () => {
    const storage = memoryStorage();
    const workView = createCodeProjectView(readProjectViewState("work", storage), {
      id: "view-work",
      name: "Writing",
      projectIds: [alpha.id],
    });
    writeProjectViewState("work", workView, storage);

    expect(storage.getItem(WORK_PROJECT_VIEWS_STORAGE_KEY)).toContain("Writing");
    expect(storage.getItem(CODE_PROJECT_VIEWS_STORAGE_KEY)).toBeNull();
    expect(readProjectViewState("work", storage).activeViewId).toBe("view-work");
    expect(readProjectViewState("code", storage).activeViewId).toBe(ALL_CODE_PROJECTS_VIEW_ID);
  });

  it("migrates filters and keeps All Projects preferences separate from saved views", () => {
    const storage = memoryStorage({
      [CODE_PROJECT_VIEWS_STORAGE_KEY]: JSON.stringify({
        activeViewId: "view-main",
        views: [
          {
            id: "view-main",
            name: "Main",
            projectIds: [alpha.id],
            filters: {
              lifecycle: "all",
              environmentIds: ["local", "devbox", "local"],
              showEmptyProjects: false,
              grouping: "environment",
              sorting: "created",
              activity: "3-days",
            },
          },
        ],
      }),
    });

    const state = readCodeProjectViewState(storage);
    expect(state.views[0]?.filters).toEqual({
      lifecycle: "all",
      environmentIds: ["local", "devbox"],
      showEmptyProjects: false,
      grouping: "environment",
      sorting: "created",
      activity: "3-days",
    });
    expect(readProjectViewPreferences("code", storage)).toEqual(defaultProjectViewPreferences());
  });

  it("keeps the saved Project set when filter JSON is malformed", () => {
    const storage = memoryStorage({
      [CODE_PROJECT_VIEWS_STORAGE_KEY]: JSON.stringify({
        activeViewId: "view-main",
        views: [
          {
            id: "view-main",
            name: "Main",
            projectIds: [alpha.id, beta.id],
            icon: "rocket",
            color: "purple",
            filters: {
              lifecycle: "nope",
              environmentIds: 12,
              grouping: "provider",
              activity: "unread",
            },
          },
        ],
      }),
    });
    const restored = readCodeProjectViewState(storage);
    expect(restored.views[0]).toMatchObject({
      id: "view-main",
      name: "Main",
      projectIds: [alpha.id, beta.id],
      icon: "rocket",
      color: "purple",
      filters: defaultProjectViewPreferences().filters,
    });
    expect(visibleCodeProjects([alpha, beta], restored)).toEqual([alpha, beta]);
  });

  it("offers Local plus named connected hosts and never a host the window did not report", () => {
    expect(projectViewEnvironmentOptionsFromHosts([])).toEqual([{ id: "local", name: "Local" }]);
    expect(
      projectViewEnvironmentOptionsFromHosts([
        { hostId: "local", displayName: "This Mac" },
        { hostId: "devbox", displayName: "Devbox" },
        { hostId: "gone", displayName: "   " },
      ]),
    ).toEqual([
      { id: "local", name: "Local" },
      { id: "devbox", name: "Devbox" },
    ]);
  });

  it("filters Projects by lifecycle and only passed environment metadata", () => {
    const state = updateCodeProjectViewFilters(
      createCodeProjectView(readCodeProjectViewState(), {
        id: "view-main",
        name: "Main",
        projectIds: [alpha.id, beta.id],
      }),
      "view-main",
      {
        ...defaultProjectViewPreferences().filters,
        lifecycle: "archived",
        environmentIds: ["devbox"],
      },
    );
    const projects = [
      { ...alpha, lifecycle: "active" as const },
      { ...beta, lifecycle: "archived" as const },
      { id: "33333333-3333-4333-8333-333333333333", lifecycle: "archived" as const },
    ];
    expect(
      filterProjectsForView(
        projects,
        state,
        defaultProjectViewPreferences(),
        new Map([[beta.id, { id: "devbox", name: "Devbox" }]]),
      ),
    ).toEqual([projects[1]]);
  });

  it("uses inclusive server updatedAt windows for activity filters", () => {
    const now = new Date("2026-08-23T15:00:00.000Z");
    const filters = {
      ...defaultProjectViewPreferences().filters,
      activity: "3-days" as const,
    };
    expect(
      filterProjectViewThreads(
        [
          { id: "today", updatedAt: "2026-08-23T00:00:00.000Z" },
          { id: "boundary", updatedAt: "2026-08-21T00:00:00.000Z" },
          { id: "old", updatedAt: "2026-08-20T21:59:59.000Z" },
          { id: "unknown" },
        ],
        filters,
        now,
      ),
    ).toEqual([
      { id: "today", updatedAt: "2026-08-23T00:00:00.000Z" },
      { id: "boundary", updatedAt: "2026-08-21T00:00:00.000Z" },
    ]);
    expect(
      projectViewActivityRange(
        { ...filters, activity: "custom", activityRange: { from: "2026-08-22", to: "2026-08-23" } },
        now,
      ),
    ).toMatchObject({
      from: new Date("2026-08-22T00:00:00"),
    });
  });

  it("refuses rollover dates and reversed custom activity ranges", () => {
    const defaults = defaultProjectViewPreferences().filters;
    const rollover = {
      ...defaults,
      activity: "custom" as const,
      activityRange: { from: "2026-02-31", to: "2026-03-03" },
    };
    const reversed = {
      ...defaults,
      activity: "custom" as const,
      activityRange: { from: "2026-08-23", to: "2026-08-22" },
    };

    expect(projectViewActivityRangeError(rollover)).toBe("Choose a valid start date.");
    expect(projectViewActivityRange(rollover)).toBeUndefined();
    expect(
      readProjectViewPreferences(
        "code",
        memoryStorage({
          "octant.code.project-view-preferences.v1": JSON.stringify({ filters: rollover }),
        }),
      ).filters.activityRange,
    ).toEqual({ to: "2026-03-03" });
    expect(projectViewActivityRangeError(reversed)).toBe(
      "Start date must be on or before end date.",
    );
    expect(projectViewActivityRange(reversed)).toBeUndefined();
    expect(
      filterProjectViewThreads([{ id: "kept", updatedAt: "2026-08-22T10:00:00.000Z" }], reversed),
    ).toEqual([{ id: "kept", updatedAt: "2026-08-22T10:00:00.000Z" }]);
  });
});
