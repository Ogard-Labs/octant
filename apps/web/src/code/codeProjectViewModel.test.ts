import { describe, expect, it } from "vitest";
import {
  ALL_CODE_PROJECTS_VIEW_ID,
  CODE_PROJECT_VIEWS_STORAGE_KEY,
  WORK_PROJECT_VIEWS_STORAGE_KEY,
  createCodeProjectView,
  deleteCodeProjectView,
  readCodeProjectViewState,
  readProjectViewState,
  selectCodeProjectView,
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
});
