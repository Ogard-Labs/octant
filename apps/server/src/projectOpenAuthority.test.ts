import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { windowCanOpenProject } from "./projectOpenAuthority";

const projectId = decodeProjectId("a2000000-0000-4000-8000-000000000001");
const otherProjectId = decodeProjectId("a2000000-0000-4000-8000-000000000002");
const noCodeProject = () => false;

describe("windowCanOpenProject", () => {
  it("opens a Chat Project only for a window whose Chat context is that Project", () => {
    const project = { id: projectId, type: "chat", lifecycle: "active" } as const;

    expect(
      windowCanOpenProject({
        project,
        chatContext: { mode: "chat", projectId },
        canAccessCodeProject: noCodeProject,
      }),
    ).toBe(true);
    expect(
      windowCanOpenProject({
        project,
        chatContext: { mode: "chat", projectId: otherProjectId },
        canAccessCodeProject: noCodeProject,
      }),
    ).toBe(false);
    expect(
      windowCanOpenProject({
        project,
        chatContext: { mode: "chat", projectId: null },
        canAccessCodeProject: noCodeProject,
      }),
    ).toBe(false);
    expect(
      windowCanOpenProject({
        project,
        chatContext: undefined,
        canAccessCodeProject: noCodeProject,
      }),
      "a paired device holds no Chat context",
    ).toBe(false);
  });

  it("opens an active Work Project for any window, as its threads are, and no archived one", () => {
    expect(
      windowCanOpenProject({
        project: { id: projectId, type: "work", lifecycle: "active" },
        chatContext: undefined,
        canAccessCodeProject: noCodeProject,
      }),
    ).toBe(true);
    expect(
      windowCanOpenProject({
        project: { id: projectId, type: "work", lifecycle: "archived" },
        chatContext: undefined,
        canAccessCodeProject: noCodeProject,
      }),
    ).toBe(false);
  });

  it("opens a Code Project only when the Code Project access rule admits it", () => {
    const project = { id: projectId, type: "code", lifecycle: "active" } as const;
    const asked: Array<string> = [];

    expect(
      windowCanOpenProject({
        project,
        chatContext: { mode: "chat", projectId },
        canAccessCodeProject: (id) => {
          asked.push(String(id));
          return false;
        },
      }),
      "a Chat context naming the same id does not open a Code Project",
    ).toBe(false);
    expect(
      windowCanOpenProject({ project, chatContext: undefined, canAccessCodeProject: () => true }),
    ).toBe(true);
    expect(asked).toEqual([String(projectId)]);
  });

  it("opens no Project the host does not hold", () => {
    expect(
      windowCanOpenProject({
        project: undefined,
        chatContext: { mode: "chat", projectId },
        canAccessCodeProject: () => true,
      }),
    ).toBe(false);
  });
});
