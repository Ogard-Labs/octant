import {
  Hand,
  MessageSquarePlus,
  MousePointer2,
  SquareDashed,
  type LucideIcon,
} from "lucide-react";
import { Fragment } from "react";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import type { CanvasTool } from "./canvasTools";

interface RailTool {
  readonly id: CanvasTool;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The first tool of a group draws a divider before it. */
  readonly startsGroup?: boolean;
}

const TOOLS: ReadonlyArray<RailTool> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "hand", label: "Hand: drag to move the page", icon: Hand },
  { id: "comment", label: "Comment: click a part", icon: MessageSquarePlus, startsGroup: true },
  { id: "area", label: "Comment on an area: drag a box", icon: SquareDashed },
];

/**
 * The tools a person points at a Canvas with. One is always chosen, so a
 * press on the chosen tool keeps it rather than leaving the Canvas with none.
 */
export function CanvasToolRail(props: {
  readonly tool: CanvasTool;
  readonly onToolChange: (tool: CanvasTool) => void;
}) {
  return (
    <OctantToggleGroup<CanvasTool>
      aria-label="Canvas tools"
      className="canvas-tool-rail"
      onValueChange={(value) => {
        const next = value[0];
        if (next !== undefined) props.onToolChange(next);
      }}
      orientation="vertical"
      value={[props.tool]}
    >
      {TOOLS.map((tool) => (
        <Fragment key={tool.id}>
          {tool.startsGroup === true ? (
            <span aria-hidden="true" className="canvas-tool-rail__divider" />
          ) : null}
          <OctantTooltip label={tool.label} side="right">
            <OctantToggleGroupItem
              aria-label={tool.label}
              className="canvas-tool-rail__tool"
              value={tool.id}
            >
              <tool.icon aria-hidden="true" size={16} strokeWidth={1.8} />
            </OctantToggleGroupItem>
          </OctantTooltip>
        </Fragment>
      ))}
    </OctantToggleGroup>
  );
}
