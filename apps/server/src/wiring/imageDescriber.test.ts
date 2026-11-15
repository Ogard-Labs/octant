import { describe, expect, it } from "vitest";
import type { Project, ProjectId, WindowId } from "@octant/contracts";
import { defaultWindowWorkspace } from "@octant/domain/shell-policy";
import { windowSeesProject } from "./imageDescriber";

const windowId = "00000000-0000-4000-8000-000000000611" as WindowId;
const held = "00000000-0000-4000-8000-0000000000c1" as ProjectId;
const other = "00000000-0000-4000-8000-0000000000c2" as ProjectId;

describe("who may ask whether Sees images works for a Project", () => {
  it("admits a window that holds the Chat Project as its Chat context and refuses one that does not", () => {
    const base = defaultWindowWorkspace(windowId);
    const workspace = {
      ...base,
      contextByMode: {
        ...base.contextByMode,
        chat: { ...base.contextByMode.chat, projectId: held },
      },
    };
    const sources = {
      readProject: (id: ProjectId) =>
        ({ id, type: "chat", lifecycle: "active" }) as unknown as Project,
      readWorkspace: () => workspace,
    };
    expect(windowSeesProject(sources, windowId, held)).toBe(true);
    expect(windowSeesProject(sources, windowId, other)).toBe(false);
    expect(windowSeesProject({ ...sources, readWorkspace: () => undefined }, windowId, held)).toBe(
      false,
    );
  });
});
