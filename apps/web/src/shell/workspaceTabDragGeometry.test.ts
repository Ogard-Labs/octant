import { decodePaneId, decodeWorkspaceTabId, type WorkspaceTab } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import {
  hasCrossedWorkspaceSurfaceDragThreshold,
  resolveWorkspaceSurfaceDropDestination,
  type WorkspaceDragPaneGeometry,
  type WorkspaceDragRect,
  type WorkspaceSurfaceDragSource,
} from "./workspaceTabDragGeometry";

const sourcePaneId = decodePaneId("00000000-0000-4000-8000-000000001101");
const targetPaneId = decodePaneId("00000000-0000-4000-8000-000000001102");
const workspaceRect: WorkspaceDragRect = { left: 0, top: 0, width: 800, height: 600 };

const draggedSurface: WorkspaceTab = {
  kind: "welcome",
  id: decodeWorkspaceTabId("00000000-0000-4000-8000-000000001103"),
  mode: "chat",
  title: "Chat",
};

function paneGeometry(
  paneId: typeof sourcePaneId,
  left: number,
  overrides?: Partial<WorkspaceDragPaneGeometry>,
): WorkspaceDragPaneGeometry {
  return { paneId, rect: { left, top: 0, width: 400, height: 600 }, ...overrides };
}

function paneSource(): WorkspaceSurfaceDragSource {
  return {
    dragKey: `pane:${String(sourcePaneId)}`,
    paneId: sourcePaneId,
    surface: draggedSurface,
    title: draggedSurface.title,
  };
}

function sidebarSource(): WorkspaceSurfaceDragSource {
  return { dragKey: "thread:row-1", surface: draggedSurface, title: draggedSurface.title };
}

describe("workspace surface drag geometry", () => {
  it("starts only after the pointer crosses the movement threshold", () => {
    expect(hasCrossedWorkspaceSurfaceDragThreshold({ x: 10, y: 10 }, { x: 14, y: 13 })).toBe(false);
    expect(hasCrossedWorkspaceSurfaceDragThreshold({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(true);
  });

  it("resolves another pane's center as a replace destination", () => {
    const destination = resolveWorkspaceSurfaceDropDestination({
      panes: [paneGeometry(sourcePaneId, 0), paneGeometry(targetPaneId, 400)],
      point: { x: 600, y: 300 },
      source: paneSource(),
      workspaceRect,
    });

    expect(destination).toEqual({ kind: "center", targetPaneId });
  });

  it("refuses to drop a pane's surface back onto its own center", () => {
    expect(
      resolveWorkspaceSurfaceDropDestination({
        panes: [paneGeometry(sourcePaneId, 0), paneGeometry(targetPaneId, 400)],
        point: { x: 200, y: 300 },
        source: paneSource(),
        workspaceRect,
      }),
    ).toBeNull();
  });

  it("lets a sidebar row land on any pane's center, including the active one", () => {
    expect(
      resolveWorkspaceSurfaceDropDestination({
        panes: [paneGeometry(sourcePaneId, 0)],
        point: { x: 200, y: 300 },
        source: sidebarSource(),
        workspaceRect,
      }),
    ).toEqual({ kind: "center", targetPaneId: sourcePaneId });
  });

  it.each([
    ["left", { x: 410, y: 300 }],
    ["right", { x: 790, y: 300 }],
    ["top", { x: 600, y: 40 }],
    ["bottom", { x: 600, y: 590 }],
  ] as const)("resolves the %s edge as a split destination", (edge, point) => {
    const destination = resolveWorkspaceSurfaceDropDestination({
      panes: [paneGeometry(sourcePaneId, 0), paneGeometry(targetPaneId, 400)],
      point,
      source: paneSource(),
      workspaceRect,
    });

    expect(destination).toEqual({ kind: "edge", targetPaneId, edge });
  });

  it("blocks edges on the source pane, focused layouts, and panes too small to split", () => {
    // The source pane's own edges: the split would leave the surface where it was.
    expect(
      resolveWorkspaceSurfaceDropDestination({
        panes: [paneGeometry(sourcePaneId, 0), paneGeometry(targetPaneId, 400)],
        point: { x: 10, y: 300 },
        source: paneSource(),
        workspaceRect,
      }),
    ).toBeNull();
    // A focused pane is presented alone, so a split created now would land hidden.
    expect(
      resolveWorkspaceSurfaceDropDestination({
        focusedPaneId: targetPaneId,
        panes: [paneGeometry(targetPaneId, 400)],
        point: { x: 410, y: 300 },
        source: sidebarSource(),
        workspaceRect,
      }),
    ).toBeNull();
    // A pane below twice the minimum docked size cannot host a new sibling.
    expect(
      resolveWorkspaceSurfaceDropDestination({
        panes: [
          paneGeometry(targetPaneId, 400, { rect: { left: 400, top: 0, width: 300, height: 300 } }),
        ],
        point: { x: 410, y: 150 },
        source: paneSource(),
        workspaceRect,
      }),
    ).toBeNull();
  });

  it("hides non-focused panes from a drag while the layout is focused", () => {
    expect(
      resolveWorkspaceSurfaceDropDestination({
        focusedPaneId: targetPaneId,
        panes: [paneGeometry(sourcePaneId, 0), paneGeometry(targetPaneId, 400)],
        point: { x: 200, y: 300 },
        source: sidebarSource(),
        workspaceRect,
      }),
    ).toBeNull();
  });

  it("rejects release geometry outside the workspace and edge drops on unsplittable panes", () => {
    expect(
      resolveWorkspaceSurfaceDropDestination({
        panes: [paneGeometry(targetPaneId, 400)],
        point: { x: 810, y: 300 },
        source: paneSource(),
        workspaceRect,
      }),
    ).toBeNull();
    expect(
      resolveWorkspaceSurfaceDropDestination({
        panes: [paneGeometry(targetPaneId, 400, { canSplit: false })],
        point: { x: 410, y: 300 },
        source: paneSource(),
        workspaceRect,
      }),
    ).toBeNull();
  });
});
