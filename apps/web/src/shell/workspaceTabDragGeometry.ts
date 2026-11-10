import type { PaneId, WorkspaceTab } from "@octant/contracts/shell";

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

export interface WorkspaceDragPaneGeometry {
  readonly paneId: PaneId;
  readonly rect: WorkspaceDragRect;
  readonly canSplit?: boolean;
}

export type WorkspaceSurfaceDropEdge = "left" | "right" | "top" | "bottom";

/**
 * Where a dragged surface lands. A center drop replaces the target pane's
 * surface; an edge drop splits the target pane and the surface takes the new
 * pane. The surface itself travels with the drag source, not the destination.
 */
export type WorkspaceSurfaceDropDestination =
  | { readonly kind: "center"; readonly targetPaneId: PaneId }
  | {
      readonly kind: "edge";
      readonly targetPaneId: PaneId;
      readonly edge: WorkspaceSurfaceDropEdge;
    }
  | { readonly kind: "composer"; readonly composerKey: string };

export interface ComposerThreadDropZone {
  readonly key: string;
  readonly rect: WorkspaceDragRect;
}

/**
 * What is being dragged: a surface value, plus the pane it is leaving when the
 * drag started on a pane grip rather than a sidebar row. `dragKey` names the
 * originating control so its click can be suppressed after a completed drag.
 */
export interface WorkspaceSurfaceDragSource {
  readonly dragKey: string;
  readonly paneId?: PaneId;
  readonly surface: WorkspaceTab;
  readonly title: string;
  /** A tab leaving its pane's row once placed: any tab but the only one a pane holds. */
  readonly fromTab?: { readonly paneId: PaneId; readonly tabId: WorkspaceTab["id"] };
  /**
   * Set when the dragged tab is its pane's open one and the pane holds other
   * tabs. The pane shows `neighborTabId` before the tab is placed, so the tab
   * leaves like any other and the pane keeps the rest of its row.
   */
  readonly openTab?: { readonly paneId: PaneId; readonly neighborTabId: WorkspaceTab["id"] };
  /** Two to four selected tabs dragged together; they lay out side by side where dropped. */
  readonly surfaces?: ReadonlyArray<WorkspaceTab>;
}

export interface ResolveWorkspaceSurfaceDropInput {
  readonly point: WorkspaceDragPoint;
  readonly workspaceRect: WorkspaceDragRect;
  readonly panes: ReadonlyArray<WorkspaceDragPaneGeometry>;
  readonly source: WorkspaceSurfaceDragSource;
  readonly focusedPaneId?: PaneId;
}

export const WORKSPACE_SURFACE_DRAG_THRESHOLD = 6;
export const MIN_WORKSPACE_DOCKED_PANE_WIDTH = 180;
export const MIN_WORKSPACE_DOCKED_PANE_HEIGHT = 160;

export function hasCrossedWorkspaceSurfaceDragThreshold(
  origin: WorkspaceDragPoint,
  current: WorkspaceDragPoint,
  threshold = WORKSPACE_SURFACE_DRAG_THRESHOLD,
): boolean {
  const horizontalDistance = current.x - origin.x;
  const verticalDistance = current.y - origin.y;
  return horizontalDistance ** 2 + verticalDistance ** 2 >= threshold ** 2;
}

export function resolveWorkspaceSurfaceDropDestination(
  input: ResolveWorkspaceSurfaceDropInput,
): WorkspaceSurfaceDropDestination | null {
  if (!containsPoint(input.workspaceRect, input.point)) return null;
  const visiblePanes =
    input.focusedPaneId === undefined
      ? input.panes
      : input.panes.filter((pane) => String(pane.paneId) === String(input.focusedPaneId));
  const target = visiblePanes.find((pane) => containsPoint(pane.rect, input.point));
  if (target === undefined) return null;
  const sourcePaneId = input.source.paneId;
  if (isCenter(target.rect, input.point)) {
    // Dropping a pane's surface back onto its own pane changes nothing, and
    // neither does dropping a pane's open tab on the pane that already shows it.
    if (sourcePaneId !== undefined && String(sourcePaneId) === String(target.paneId)) return null;
    const openIn = input.source.openTab?.paneId;
    if (openIn !== undefined && String(openIn) === String(target.paneId)) return null;
    return { kind: "center", targetPaneId: target.paneId };
  }
  const edge = nearestEdge(target.rect, input.point);
  if (!canUseEdge(target, edge, input)) return null;
  return { kind: "edge", targetPaneId: target.paneId, edge };
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

function nearestEdge(rect: WorkspaceDragRect, point: WorkspaceDragPoint): WorkspaceSurfaceDropEdge {
  const distances: ReadonlyArray<readonly [WorkspaceSurfaceDropEdge, number]> = [
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
  target: WorkspaceDragPaneGeometry,
  edge: WorkspaceSurfaceDropEdge,
  input: ResolveWorkspaceSurfaceDropInput,
): boolean {
  // A focused pane is presented alone; a split created now would land hidden.
  if (target.canSplit === false || input.focusedPaneId !== undefined) return false;
  // Splitting a pane off itself would leave the same surface where it was.
  if (input.source.paneId !== undefined && String(input.source.paneId) === String(target.paneId)) {
    return false;
  }
  return edge === "left" || edge === "right"
    ? target.rect.width >= MIN_WORKSPACE_DOCKED_PANE_WIDTH * 2
    : target.rect.height >= MIN_WORKSPACE_DOCKED_PANE_HEIGHT * 2;
}

/**
 * A sidebar thread dropped on a composer attaches context instead of opening
 * a pane. A pane grip or a tab keeps the pane destination even when the
 * pointer is over a composer, so moving a pane or a tab is unchanged: a tab
 * names no sidebar row, and resolved to a composer it attached nothing.
 */
export function resolveSidebarComposerDrop(input: {
  readonly point: WorkspaceDragPoint;
  readonly source: WorkspaceSurfaceDragSource;
  readonly composerZones: ReadonlyArray<ComposerThreadDropZone>;
}): WorkspaceSurfaceDropDestination | null {
  if (input.source.paneId !== undefined || input.source.fromTab !== undefined) return null;
  const zone = input.composerZones.find((candidate) => containsPoint(candidate.rect, input.point));
  return zone === undefined ? null : { kind: "composer", composerKey: zone.key };
}
