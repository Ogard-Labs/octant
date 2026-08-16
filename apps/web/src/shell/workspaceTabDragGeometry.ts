import type { TabGroupId, WorkspaceTabId } from "@octant/contracts/shell";

export interface WorkspaceDragPoint {
  readonly x: number;
  readonly y: number;
}

export interface WorkspaceDragRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkspaceDragTabGeometry {
  readonly tabId: WorkspaceTabId;
  readonly rect: WorkspaceDragRect;
}

export interface WorkspaceDragGroupGeometry {
  readonly groupId: TabGroupId;
  readonly rect: WorkspaceDragRect;
  readonly tabCount: number;
  readonly tabStrip: {
    readonly rect: WorkspaceDragRect;
    readonly tabs: ReadonlyArray<WorkspaceDragTabGeometry>;
  };
  readonly canSplit?: boolean;
}

export type WorkspaceTabDropEdge = "left" | "right" | "top" | "bottom";

interface WorkspaceTabDropBase {
  readonly sourceGroupId: TabGroupId;
  readonly targetGroupId: TabGroupId;
  readonly tabId: WorkspaceTabId;
}

export type WorkspaceTabDropDestination =
  | (WorkspaceTabDropBase & { readonly kind: "reorder"; readonly index: number })
  | (WorkspaceTabDropBase & { readonly kind: "center"; readonly index: number })
  | (WorkspaceTabDropBase & { readonly kind: "edge"; readonly edge: WorkspaceTabDropEdge });

export interface ResolveWorkspaceTabDropInput {
  readonly point: WorkspaceDragPoint;
  readonly workspaceRect: WorkspaceDragRect;
  readonly groups: ReadonlyArray<WorkspaceDragGroupGeometry>;
  readonly source: {
    readonly groupId: TabGroupId;
    readonly tabId: WorkspaceTabId;
    readonly index: number;
  };
  readonly focusedGroupId?: TabGroupId;
}

export const WORKSPACE_TAB_DRAG_THRESHOLD = 6;
export const MIN_WORKSPACE_DOCKED_PANE_WIDTH = 180;
export const MIN_WORKSPACE_DOCKED_PANE_HEIGHT = 160;

export function hasCrossedWorkspaceTabDragThreshold(
  origin: WorkspaceDragPoint,
  current: WorkspaceDragPoint,
  threshold = WORKSPACE_TAB_DRAG_THRESHOLD,
): boolean {
  const horizontalDistance = current.x - origin.x;
  const verticalDistance = current.y - origin.y;
  return horizontalDistance ** 2 + verticalDistance ** 2 >= threshold ** 2;
}

export function resolveWorkspaceTabDropDestination(
  input: ResolveWorkspaceTabDropInput,
): WorkspaceTabDropDestination | null {
  if (!containsPoint(input.workspaceRect, input.point)) return null;
  const visibleGroups =
    input.focusedGroupId === undefined
      ? input.groups
      : input.groups.filter((group) => group.groupId === input.focusedGroupId);
  const stripTarget = visibleGroups.find((group) =>
    containsPoint(group.tabStrip.rect, input.point),
  );
  if (stripTarget !== undefined) {
    const rawIndex = stripTarget.tabStrip.tabs.findIndex(
      (tab) => input.point.x < tab.rect.left + tab.rect.width / 2,
    );
    const insertionIndex = rawIndex < 0 ? stripTarget.tabStrip.tabs.length : rawIndex;
    if (stripTarget.groupId === input.source.groupId) {
      const index = insertionIndex > input.source.index ? insertionIndex - 1 : insertionIndex;
      if (index === input.source.index) return null;
      return {
        kind: "reorder",
        sourceGroupId: input.source.groupId,
        targetGroupId: stripTarget.groupId,
        tabId: input.source.tabId,
        index,
      };
    }
    return {
      kind: "center",
      sourceGroupId: input.source.groupId,
      targetGroupId: stripTarget.groupId,
      tabId: input.source.tabId,
      index: insertionIndex,
    };
  }

  const groupTarget = visibleGroups.find((group) => containsPoint(group.rect, input.point));
  if (groupTarget === undefined) return null;
  if (isCenter(groupTarget.rect, input.point)) {
    if (groupTarget.groupId === input.source.groupId) return null;
    return {
      kind: "center",
      sourceGroupId: input.source.groupId,
      targetGroupId: groupTarget.groupId,
      tabId: input.source.tabId,
      index: groupTarget.tabCount,
    };
  }

  const edge = nearestEdge(groupTarget.rect, input.point);
  if (!canUseEdge(groupTarget, edge, input)) return null;
  return {
    kind: "edge",
    sourceGroupId: input.source.groupId,
    targetGroupId: groupTarget.groupId,
    tabId: input.source.tabId,
    edge,
  };
}

function containsPoint(rect: WorkspaceDragRect, point: WorkspaceDragPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

function isCenter(rect: WorkspaceDragRect, point: WorkspaceDragPoint): boolean {
  return (
    point.x >= rect.left + rect.width * 0.25 &&
    point.x <= rect.left + rect.width * 0.75 &&
    point.y >= rect.top + rect.height * 0.25 &&
    point.y <= rect.top + rect.height * 0.75
  );
}

function nearestEdge(rect: WorkspaceDragRect, point: WorkspaceDragPoint): WorkspaceTabDropEdge {
  const distances: ReadonlyArray<readonly [WorkspaceTabDropEdge, number]> = [
    ["left", (point.x - rect.left) / rect.width],
    ["right", (rect.left + rect.width - point.x) / rect.width],
    ["top", (point.y - rect.top) / rect.height],
    ["bottom", (rect.top + rect.height - point.y) / rect.height],
  ];
  return distances.reduce((nearest, candidate) =>
    candidate[1] < nearest[1] ? candidate : nearest,
  )[0];
}

function canUseEdge(
  target: WorkspaceDragGroupGeometry,
  edge: WorkspaceTabDropEdge,
  input: ResolveWorkspaceTabDropInput,
): boolean {
  if (target.canSplit === false || input.focusedGroupId !== undefined) return false;
  if (target.groupId === input.source.groupId && target.tabCount < 2) return false;
  return edge === "left" || edge === "right"
    ? target.rect.width >= MIN_WORKSPACE_DOCKED_PANE_WIDTH * 2
    : target.rect.height >= MIN_WORKSPACE_DOCKED_PANE_HEIGHT * 2;
}
