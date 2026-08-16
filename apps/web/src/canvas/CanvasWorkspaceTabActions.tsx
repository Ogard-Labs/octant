import type { CanvasVersionId } from "@octant/contracts/canvas";
import type {
  CanvasContextSelection,
  CanvasContextSelectionId,
} from "@octant/contracts/canvasContext";
import type { WorkspaceTab } from "@octant/contracts/shell";
import { Pin, Paperclip } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface CanvasWorkspaceTabActionsProps {
  readonly currentSequence: number;
  readonly currentVersionId: CanvasVersionId;
  readonly displayName: string;
  readonly onAttachContext: (selection: CanvasContextSelection) => void;
  readonly onTogglePin: () => void;
  readonly pinned: boolean;
  readonly tab: Extract<WorkspaceTab, { readonly kind: "canvas" }>;
}

export function CanvasWorkspaceTabActions(props: CanvasWorkspaceTabActionsProps) {
  return (
    <div className="canvas-workspace-tab__actions">
      <OctantButton
        aria-label={props.pinned ? `Unpin ${props.tab.title}` : `Pin ${props.tab.title}`}
        aria-pressed={props.pinned}
        onClick={props.onTogglePin}
        size="sm"
        type="button"
        variant={props.pinned ? "secondary" : "ghost"}
      >
        <Pin aria-hidden="true" size={14} strokeWidth={1.8} />
        {props.pinned ? "Pinned" : "Pin"}
      </OctantButton>
      <OctantButton
        aria-label={`Attach ${props.displayName} to thread context`}
        onClick={() =>
          props.onAttachContext({
            id: crypto.randomUUID() as CanvasContextSelectionId,
            canvasId: props.tab.canvasId,
            versionId: props.currentVersionId,
            sequence: props.currentSequence,
            displayName: props.displayName,
            scope: "whole-canvas",
          })
        }
        size="sm"
        type="button"
        variant="ghost"
      >
        <Paperclip aria-hidden="true" size={14} strokeWidth={1.8} />
        Attach context
      </OctantButton>
    </div>
  );
}
