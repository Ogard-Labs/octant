import type { CanvasVersionId } from "@octant/contracts/canvas";
import type {
  CanvasContextSelection,
  CanvasContextSelectionId,
} from "@octant/contracts/canvasContext";
import type { WorkspaceTab } from "@octant/contracts/shell";
import { LayoutGrid, Pin, Paperclip } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface CanvasWorkspaceTabActionsProps {
  readonly currentSequence: number;
  readonly currentVersionId: CanvasVersionId;
  readonly displayName: string;
  readonly onAttachContext: (selection: CanvasContextSelection) => void;
  readonly onTogglePin: () => void;
  /**
   * Pin this canvas as a card in the focus zone. Absent when this window has
   * no zone to pin into. The card reads the same document by id, so pinning
   * moves where it is shown and changes nothing about what may reach it.
   */
  readonly onPinInFocusZone?: () => void;
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
      {props.onPinInFocusZone === undefined ? null : (
        <OctantButton
          aria-label={`Pin ${props.tab.title} in the focus zone`}
          onClick={props.onPinInFocusZone}
          size="sm"
          type="button"
          variant="ghost"
        >
          <LayoutGrid aria-hidden="true" size={14} strokeWidth={1.8} />
          Pin in Zen
        </OctantButton>
      )}
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
