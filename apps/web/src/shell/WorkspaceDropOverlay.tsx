import type { WorkspaceTabDragState } from "./useWorkspaceTabDrag";
import type { WorkspaceTabDropDestination } from "./workspaceTabDragGeometry";

export function WorkspaceDropOverlay(props: {
  readonly destination: WorkspaceTabDropDestination | null;
  readonly targetGroupId: string;
}) {
  const destination = props.destination;
  if (destination === null || destination.targetGroupId !== props.targetGroupId) return null;
  if (destination.kind === "reorder") return null;
  const label =
    destination.kind === "edge" ? `Split ${destination.edge}` : "Move to this tab group";
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

export function WorkspaceDragStatus(props: { readonly drag: WorkspaceTabDragState }) {
  const destination = props.drag.destination;
  const message =
    destination === null
      ? `Dragging ${props.drag.source.title}. No drop target.`
      : destination.kind === "edge"
        ? `Dock ${props.drag.source.title} ${destination.edge}.`
        : destination.kind === "reorder"
          ? `Move ${props.drag.source.title} to tab position ${destination.index + 1}.`
          : `Move ${props.drag.source.title} to another tab group.`;
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
