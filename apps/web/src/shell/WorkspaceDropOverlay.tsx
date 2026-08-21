import type { WorkspaceSurfaceDragState } from "./useWorkspaceTabDrag";
import type { WorkspaceSurfaceDropDestination } from "./workspaceTabDragGeometry";

export function WorkspaceDropOverlay(props: {
  readonly destination: WorkspaceSurfaceDropDestination | null;
  readonly targetPaneId: string;
}) {
  const destination = props.destination;
  if (destination === null || String(destination.targetPaneId) !== props.targetPaneId) return null;
  const label = destination.kind === "edge" ? `Split ${destination.edge}` : "Open in this pane";
  return (
    <div
      aria-hidden="true"
      className="workspace-drop-overlay"
      data-drop-edge={destination.kind === "edge" ? destination.edge : undefined}
      data-drop-kind={destination.kind}
    >
      <span>{label}</span>
    </div>
  );
}

export function WorkspaceDragStatus(props: { readonly drag: WorkspaceSurfaceDragState }) {
  const destination = props.drag.destination;
  const message =
    destination === null
      ? `Dragging ${props.drag.source.title}. No drop target.`
      : destination.kind === "edge"
        ? `Split ${destination.edge} and open ${props.drag.source.title}.`
        : `Open ${props.drag.source.title} in this pane.`;
  return (
    <>
      <div aria-live="polite" className="sr-only" role="status">
        {message}
      </div>
      <div
        aria-hidden="true"
        className="workspace-drag-preview"
        style={{ left: props.drag.point.x + 12, top: props.drag.point.y + 12 }}
      >
        {props.drag.source.title}
      </div>
    </>
  );
}
