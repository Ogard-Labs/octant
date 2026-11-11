import {
  ArrowUpRight,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { MARKUP_INKS, type MarkupInkId } from "../theme/markupInk";
import { OctantButton } from "../ui/base/OctantButton";

export type MarkupTool = "select" | "pen" | "box" | "arrow" | "text";

export type MarkupStroke = "thin" | "thick";

const TOOLS: ReadonlyArray<{
  readonly id: MarkupTool;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { id: "select", label: "Select", icon: <MousePointer2 aria-hidden="true" size={16} /> },
  { id: "pen", label: "Pen", icon: <Pencil aria-hidden="true" size={16} /> },
  { id: "box", label: "Box", icon: <Square aria-hidden="true" size={16} /> },
  { id: "arrow", label: "Arrow", icon: <ArrowUpRight aria-hidden="true" size={16} /> },
  { id: "text", label: "Text", icon: <Type aria-hidden="true" size={16} /> },
];

export interface BrowserMarkupBarProps {
  readonly tool: MarkupTool;
  readonly onTool: (tool: MarkupTool) => void;
  readonly ink: MarkupInkId;
  readonly onInk: (ink: MarkupInkId) => void;
  readonly stroke: MarkupStroke;
  readonly onStroke: (stroke: MarkupStroke) => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canDelete: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onDelete: () => void;
  readonly busy: boolean;
  readonly onAddToChat: () => void;
  readonly onClose: () => void;
}

/**
 * The drawing tools, floating over the bottom of the picture. Ink colours are
 * drawn into the picture, so each swatch shows the ink's own colour from the
 * ink table rather than an interface token.
 */
export function BrowserMarkupBar(props: BrowserMarkupBarProps) {
  return (
    <div aria-label="Drawing tools" className="browser-markup__bar" role="toolbar">
      <div className="browser-markup__group" role="group" aria-label="Tool">
        {TOOLS.map((tool) => (
          <OctantButton
            key={tool.id}
            aria-label={tool.label}
            aria-pressed={props.tool === tool.id}
            onClick={() => props.onTool(tool.id)}
            size="icon"
            title={tool.label}
            type="button"
            variant={props.tool === tool.id ? "secondary" : "ghost"}
          >
            {tool.icon}
          </OctantButton>
        ))}
      </div>
      <div className="browser-markup__group" role="group" aria-label="Ink colour">
        {MARKUP_INKS.map((ink) => (
          <OctantButton
            key={ink.id}
            aria-label={ink.label}
            aria-pressed={props.ink === ink.id}
            className="browser-markup__swatch-button"
            onClick={() => props.onInk(ink.id)}
            size="icon"
            title={ink.label}
            type="button"
            variant="bare"
          >
            <span
              aria-hidden="true"
              className={`browser-markup__swatch${props.ink === ink.id ? " browser-markup__swatch--chosen" : ""}`}
              style={{ background: ink.value }}
            />
          </OctantButton>
        ))}
      </div>
      <div className="browser-markup__group" role="group" aria-label="Stroke width">
        {(["thin", "thick"] as const).map((stroke) => (
          <OctantButton
            key={stroke}
            aria-label={stroke === "thin" ? "Thin stroke" : "Thick stroke"}
            aria-pressed={props.stroke === stroke}
            onClick={() => props.onStroke(stroke)}
            size="icon"
            title={stroke === "thin" ? "Thin stroke" : "Thick stroke"}
            type="button"
            variant={props.stroke === stroke ? "secondary" : "ghost"}
          >
            <span
              aria-hidden="true"
              className={`browser-markup__stroke browser-markup__stroke--${stroke}`}
            />
          </OctantButton>
        ))}
      </div>
      <div className="browser-markup__group">
        <OctantButton
          aria-label="Undo"
          disabled={!props.canUndo}
          onClick={props.onUndo}
          size="icon"
          title="Undo"
          type="button"
          variant="ghost"
        >
          <Undo2 aria-hidden="true" size={16} />
        </OctantButton>
        <OctantButton
          aria-label="Redo"
          disabled={!props.canRedo}
          onClick={props.onRedo}
          size="icon"
          title="Redo"
          type="button"
          variant="ghost"
        >
          <Redo2 aria-hidden="true" size={16} />
        </OctantButton>
        <OctantButton
          aria-label="Delete"
          disabled={!props.canDelete}
          onClick={props.onDelete}
          size="icon"
          title="Delete the selected mark"
          type="button"
          variant="ghost"
        >
          <Trash2 aria-hidden="true" size={16} />
        </OctantButton>
      </div>
      <OctantButton
        disabled={props.busy}
        onClick={props.onAddToChat}
        size="sm"
        title="Put the marked-up picture in this thread's message"
        type="button"
      >
        Add to chat
      </OctantButton>
      <OctantButton
        aria-label="Discard drawing"
        onClick={props.onClose}
        size="icon"
        title="Discard drawing"
        type="button"
        variant="ghost"
      >
        <X aria-hidden="true" size={16} />
      </OctantButton>
    </div>
  );
}
