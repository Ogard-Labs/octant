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
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { MARKUP_INKS, markupInk, type MarkupInkId } from "../theme/markupInk";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";

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
 * ink table rather than an interface token. The six inks sit behind one control
 * and the two widths behind another, so the bar stays one row at an ordinary
 * dock width; Add to chat and Discard are the trailing pair and wrap together.
 */
export function BrowserMarkupBar(props: BrowserMarkupBarProps) {
  const [inkOpen, setInkOpen] = useState(false);
  const chosen = markupInk(props.ink);
  return (
    <div aria-label="Drawing tools" className="browser-markup__bar" role="toolbar">
      <div className="browser-markup__group" role="group" aria-label="Tool">
        {TOOLS.map((tool) => (
          <OctantButton
            key={tool.id}
            aria-label={tool.label}
            aria-pressed={props.tool === tool.id}
            className="browser-markup__button"
            onClick={() => props.onTool(tool.id)}
            size="icon"
            title={tool.label}
            type="button"
            variant="bare"
          >
            {tool.icon}
          </OctantButton>
        ))}
      </div>
      <div className="browser-markup__group">
        <OctantPopover
          className="browser-markup__ink-popup"
          onOpenChange={setInkOpen}
          open={inkOpen}
          side="top"
          title="Ink colour"
          trigger={<InkDot value={chosen.value} />}
          triggerClassName="browser-markup__button"
          triggerLabel={`Ink colour: ${chosen.label}`}
          triggerVariant="ghost-icon"
        >
          <div
            aria-label="Ink colour"
            className="browser-markup__inks"
            onKeyDown={moveBetweenInks}
            role="radiogroup"
          >
            {MARKUP_INKS.map((ink) => (
              <OctantButton
                key={ink.id}
                aria-checked={props.ink === ink.id}
                aria-label={ink.label}
                className="browser-markup__button"
                onClick={() => {
                  props.onInk(ink.id);
                  setInkOpen(false);
                }}
                role="radio"
                size="icon"
                tabIndex={props.ink === ink.id ? 0 : -1}
                title={ink.label}
                type="button"
                variant="bare"
              >
                <InkDot value={ink.value} />
              </OctantButton>
            ))}
          </div>
        </OctantPopover>
        <OctantButton
          aria-label="Thick stroke"
          aria-pressed={props.stroke === "thick"}
          className="browser-markup__button"
          onClick={() => props.onStroke(props.stroke === "thick" ? "thin" : "thick")}
          size="icon"
          title={
            props.stroke === "thick"
              ? "Thick stroke (press for thin)"
              : "Thin stroke (press for thick)"
          }
          type="button"
          variant="bare"
        >
          <span
            aria-hidden="true"
            className={`browser-markup__stroke browser-markup__stroke--${props.stroke}`}
          />
        </OctantButton>
      </div>
      <div className="browser-markup__group">
        <OctantButton
          aria-label="Undo"
          className="browser-markup__button"
          disabled={!props.canUndo}
          onClick={props.onUndo}
          size="icon"
          title="Undo"
          type="button"
          variant="bare"
        >
          <Undo2 aria-hidden="true" size={16} />
        </OctantButton>
        <OctantButton
          aria-label="Redo"
          className="browser-markup__button"
          disabled={!props.canRedo}
          onClick={props.onRedo}
          size="icon"
          title="Redo"
          type="button"
          variant="bare"
        >
          <Redo2 aria-hidden="true" size={16} />
        </OctantButton>
        <OctantButton
          aria-label="Delete"
          className="browser-markup__button"
          disabled={!props.canDelete}
          onClick={props.onDelete}
          size="icon"
          title="Delete the selected mark"
          type="button"
          variant="bare"
        >
          <Trash2 aria-hidden="true" size={16} />
        </OctantButton>
      </div>
      <div className="browser-markup__group browser-markup__group--trailing">
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
          className="browser-markup__button"
          onClick={props.onClose}
          size="icon"
          title="Discard drawing"
          type="button"
          variant="bare"
        >
          <X aria-hidden="true" size={16} />
        </OctantButton>
      </div>
    </div>
  );
}

/** A dot of an ink, edged so white shows on a light bar and black on a dark one. */
function InkDot(props: { readonly value: string }) {
  return (
    <span
      aria-hidden="true"
      className="browser-markup__swatch"
      style={{ background: props.value }}
    />
  );
}

/** Arrows, Home and End move among the six inks; Enter or Space on one picks it. */
function moveBetweenInks(event: KeyboardEvent<HTMLElement>): void {
  const steps: Readonly<Record<string, number>> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const at = radios.findIndex((radio) => radio === document.activeElement);
  if (at === -1) return;
  const step = steps[event.key];
  const next =
    step !== undefined
      ? (at + step + radios.length) % radios.length
      : event.key === "Home"
        ? 0
        : event.key === "End"
          ? radios.length - 1
          : undefined;
  const radio = next === undefined ? undefined : radios[next];
  if (radio === undefined) return;
  event.preventDefault();
  radio.focus();
}
