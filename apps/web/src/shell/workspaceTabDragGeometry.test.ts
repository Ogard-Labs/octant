import { describe, expect, it } from "vitest";
import {
  hasCrossedWorkspaceTabDragThreshold,
  resolveWorkspaceTabDropDestination,
  type WorkspaceDragGroupGeometry,
  type WorkspaceDragRect,
} from "./workspaceTabDragGeometry";

const sourceGroupId = "00000000-0000-4000-8000-000000001101" as never;
const targetGroupId = "00000000-0000-4000-8000-000000001102" as never;
const sourceTabId = "00000000-0000-4000-8000-000000001103" as never;
const workspaceRect: WorkspaceDragRect = { left: 0, top: 0, width: 800, height: 600 };

function groupGeometry(
  groupId: typeof sourceGroupId,
  left: number,
  tabCount = 2,
): WorkspaceDragGroupGeometry {
  return {
    groupId,
    rect: { left, top: 0, width: 400, height: 600 },
    tabCount,
    tabStrip: {
      rect: { left, top: 0, width: 400, height: 34 },
      tabs: Array.from({ length: tabCount }, (_, index) => ({
        tabId: `${groupId}-${index}` as never,
        rect: { left: left + index * 100, top: 0, width: 100, height: 34 },
      })),
    },
  };
}

describe("workspace tab drag geometry", () => {
  it("starts only after the pointer crosses the movement threshold", () => {
    expect(hasCrossedWorkspaceTabDragThreshold({ x: 10, y: 10 }, { x: 14, y: 13 })).toBe(false);
    expect(hasCrossedWorkspaceTabDragThreshold({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(true);
  });

  it("resolves an exact insertion index in another group's tab strip", () => {
    const destination = resolveWorkspaceTabDropDestination({
      groups: [groupGeometry(sourceGroupId, 0), groupGeometry(targetGroupId, 400)],
      point: { x: 525, y: 16 },
      source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
      workspaceRect,
    });

    expect(destination).toEqual({
      kind: "center",
      sourceGroupId,
      targetGroupId,
      tabId: sourceTabId,
      index: 1,
    });
  });

  it("adjusts source-strip insertion indices after removing the dragged tab", () => {
    const destination = resolveWorkspaceTabDropDestination({
      groups: [groupGeometry(sourceGroupId, 0)],
      point: { x: 250, y: 16 },
      source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
      workspaceRect,
    });

    expect(destination).toEqual({
      kind: "reorder",
      sourceGroupId,
      targetGroupId: sourceGroupId,
      tabId: sourceTabId,
      index: 1,
    });
    expect(
      resolveWorkspaceTabDropDestination({
        groups: [groupGeometry(sourceGroupId, 0)],
        point: { x: 25, y: 16 },
        source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
        workspaceRect,
      }),
    ).toBeNull();
  });

  it("gives the center of another group precedence over directional edges", () => {
    const destination = resolveWorkspaceTabDropDestination({
      groups: [groupGeometry(sourceGroupId, 0), groupGeometry(targetGroupId, 400)],
      point: { x: 600, y: 300 },
      source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
      workspaceRect,
    });

    expect(destination).toEqual({
      kind: "center",
      sourceGroupId,
      targetGroupId,
      tabId: sourceTabId,
      index: 2,
    });
  });

  it.each([
    ["left", { x: 410, y: 300 }],
    ["right", { x: 790, y: 300 }],
    ["top", { x: 600, y: 40 }],
    ["bottom", { x: 600, y: 590 }],
  ] as const)("resolves the %s directional zone", (edge, point) => {
    const destination = resolveWorkspaceTabDropDestination({
      groups: [groupGeometry(sourceGroupId, 0), groupGeometry(targetGroupId, 400)],
      point,
      source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
      workspaceRect,
    });

    expect(destination).toEqual({
      kind: "edge",
      sourceGroupId,
      targetGroupId,
      tabId: sourceTabId,
      edge,
    });
  });

  it("disables unusable, focused, and redundant split targets", () => {
    const narrowTarget = {
      ...groupGeometry(targetGroupId, 400),
      rect: { left: 400, top: 0, width: 300, height: 300 },
    };
    const resolve = (
      groups: ReadonlyArray<WorkspaceDragGroupGeometry>,
      point: { readonly x: number; readonly y: number },
      focusedGroupId?: typeof sourceGroupId,
    ) =>
      resolveWorkspaceTabDropDestination({
        groups,
        point,
        source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
        workspaceRect,
        ...(focusedGroupId === undefined ? {} : { focusedGroupId }),
      });

    expect(resolve([narrowTarget], { x: 410, y: 150 })).toBeNull();
    expect(
      resolve([groupGeometry(targetGroupId, 400)], { x: 410, y: 300 }, sourceGroupId),
    ).toBeNull();
    expect(
      resolve([groupGeometry(targetGroupId, 400)], { x: 525, y: 16 }, sourceGroupId),
    ).toBeNull();
    expect(resolve([groupGeometry(sourceGroupId, 0, 1)], { x: 10, y: 300 })).toBeNull();
  });

  it("rejects release geometry outside the central workspace and disabled groups", () => {
    expect(
      resolveWorkspaceTabDropDestination({
        groups: [groupGeometry(targetGroupId, 400)],
        point: { x: 810, y: 300 },
        source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
        workspaceRect,
      }),
    ).toBeNull();
    expect(
      resolveWorkspaceTabDropDestination({
        groups: [{ ...groupGeometry(targetGroupId, 400), canSplit: false }],
        point: { x: 410, y: 300 },
        source: { groupId: sourceGroupId, index: 0, tabId: sourceTabId },
        workspaceRect,
      }),
    ).toBeNull();
  });
});
