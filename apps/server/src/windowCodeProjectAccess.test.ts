import { decodeProjectId, decodeWindowId, type ProjectId } from "@octant/contracts";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { describe, expect, it } from "vitest";
import { windowCanAccessCodeProject } from "./windowCodeProjectAccess";

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

  it("still lists active Code Projects for an unbound window so first-run can bootstrap", () => {
    expect(
      windowCanAccessCodeProject({
        workspace: defaultWindowWorkspace(ids.window),
        projectId: ids.other,
        hasActiveCodeProject: activeCodeProjects(ids.bound, ids.other),
      }),
    ).toBe(true);
    expect(
      windowCanAccessCodeProject({
        workspace: undefined,
        projectId: ids.other,
        hasActiveCodeProject: activeCodeProjects(ids.other),
      }),
    ).toBe(true);
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
