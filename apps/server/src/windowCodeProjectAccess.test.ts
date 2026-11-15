import { decodeProjectId, decodeWindowId, type ProjectId } from "@octant/contracts";
import { decodeWorkspaceTab } from "@octant/contracts/shell";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { describe, expect, it } from "vitest";
import { windowCanAccessCodeProject, windowCanAccessWorkProject } from "./windowCodeProjectAccess";

const ids = {
  window: decodeWindowId("00000000-0000-4000-8000-00000000c001"),
  bound: decodeProjectId("00000000-0000-4000-8000-00000000c010"),
  other: decodeProjectId("00000000-0000-4000-8000-00000000c011"),
};

function activeCodeProjects(...projectIds: ReadonlyArray<ProjectId>) {
  const allowed = new Set(projectIds.map(String));
  return (projectId: ProjectId) => allowed.has(String(projectId));
}

describe("windowCanAccessCodeProject", () => {
  it("refuses a window bound to one Code Project from accessing a different active Code Project", () => {
    const workspace = defaultWindowWorkspace(ids.window);
    const bound = {
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: contextKeyForProject("code", LOCAL_HOST_ID, ids.bound, "/repo"),
      },
    };

    expect(
      windowCanAccessCodeProject({
        workspace: bound,
        projectId: ids.other,
        hasActiveCodeProject: activeCodeProjects(ids.bound, ids.other),
      }),
    ).toBe(false);
  });

  it("allows a bound window to access its own active Code Project", () => {
    const workspace = defaultWindowWorkspace(ids.window);
    const bound = {
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: contextKeyForProject("code", LOCAL_HOST_ID, ids.bound, "/repo"),
      },
    };

    expect(
      windowCanAccessCodeProject({
        workspace: bound,
        projectId: ids.bound,
        hasActiveCodeProject: activeCodeProjects(ids.bound, ids.other),
      }),
    ).toBe(true);
  });

  it("refuses an unbound window access to an active Code Project until that window binds one", () => {
    expect(
      windowCanAccessCodeProject({
        workspace: defaultWindowWorkspace(ids.window),
        projectId: ids.other,
        hasActiveCodeProject: activeCodeProjects(ids.bound, ids.other),
      }),
    ).toBe(false);
    expect(
      windowCanAccessCodeProject({
        workspace: undefined,
        projectId: ids.other,
        hasActiveCodeProject: activeCodeProjects(ids.other),
      }),
    ).toBe(false);
  });

  it("never grants a bound window an inactive Code Project even when the ids match", () => {
    const workspace = defaultWindowWorkspace(ids.window);
    const bound = {
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: contextKeyForProject("code", LOCAL_HOST_ID, ids.bound, "/repo"),
      },
    };

    expect(
      windowCanAccessCodeProject({
        workspace: bound,
        projectId: ids.bound,
        hasActiveCodeProject: activeCodeProjects(),
      }),
    ).toBe(false);
  });
});

describe("a window showing panes of several Projects", () => {
  const third = decodeProjectId("00000000-0000-4000-8000-00000000c012");
  const withPane = (mode: "code" | "work", projectId: ProjectId | undefined) => {
    const workspace = defaultWindowWorkspace(ids.window);
    const pane = workspace.layouts[mode];
    if (pane.kind !== "pane") throw new Error("expected pane");
    return {
      ...workspace,
      layouts: {
        ...workspace.layouts,
        [mode]:
          projectId === undefined
            ? pane
            : {
                ...pane,
                // A pane showing that Project's own tab; a welcome reaches nothing.
                surface: decodeWorkspaceTab({
                  kind: "project",
                  id: pane.surface.id,
                  projectId,
                  mode,
                  title: "Other Project",
                }),
                context: contextKeyForProject(mode, LOCAL_HOST_ID, projectId, "/other"),
              },
      },
      contextByMode: {
        ...workspace.contextByMode,
        [mode]: contextKeyForProject(mode, LOCAL_HOST_ID, ids.bound, "/repo"),
      },
    };
  };

  it("reaches a Project shown in one of its Code panes, and no Project it does not show", () => {
    const active = activeCodeProjects(ids.bound, ids.other, third);
    const shown = withPane("code", ids.other);
    for (const [projectId, expected] of [
      [ids.bound, true],
      [ids.other, true],
      [third, false],
    ] as const) {
      expect(
        windowCanAccessCodeProject({ workspace: shown, projectId, hasActiveCodeProject: active }),
      ).toBe(expected);
    }
    // Once the pane shows the lead's Project again, the other is out of reach.
    expect(
      windowCanAccessCodeProject({
        workspace: withPane("code", undefined),
        projectId: ids.other,
        hasActiveCodeProject: active,
      }),
    ).toBe(false);
  });

  it("reaches a server Work Project shown beside a local one only while its pane shows it", () => {
    const shown = withPane("work", ids.other);
    const pane = shown.layouts.work;
    if (pane.kind !== "pane") throw new Error("expected pane");
    // A server Project holds no folder on this host: its pane's context has no bound root.
    const serverPane = {
      ...shown,
      layouts: {
        ...shown.layouts,
        work: {
          ...pane,
          context: {
            ...contextKeyForProject("work", LOCAL_HOST_ID, ids.other, "/x"),
            boundRoot: null,
          },
        },
      },
    };
    expect(windowCanAccessWorkProject({ workspace: serverPane, projectId: ids.other })).toBe(true);
    expect(windowCanAccessWorkProject({ workspace: serverPane, projectId: ids.bound })).toBe(true);
    expect(
      windowCanAccessWorkProject({ workspace: withPane("work", undefined), projectId: ids.other }),
    ).toBe(false);
  });

  it("reaches a Work Project shown in one of its Work panes only while the pane shows it", () => {
    expect(
      windowCanAccessWorkProject({ workspace: withPane("work", ids.other), projectId: ids.other }),
    ).toBe(true);
    expect(
      windowCanAccessWorkProject({ workspace: withPane("work", undefined), projectId: ids.other }),
    ).toBe(false);
  });
});
