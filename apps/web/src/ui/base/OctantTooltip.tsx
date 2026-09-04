import type { ReactElement, ReactNode } from "react";
import {
  Tooltip,
  TooltipPopup,
  TooltipPortal,
  TooltipPositioner,
  TooltipTrigger,
} from "../shadcn/tooltip";

export interface OctantTooltipProps {
  readonly children: ReactElement;
  readonly label: ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "right" | "bottom" | "left";
  /**
   * `"inverted"` is the compact label chip. `"card"` puts structured content
   * on the ordinary raised surface instead: content that paints its own
   * `--oct-fg` text disappears against the inverted ground.
   */
  readonly surface?: "inverted" | "card";
}

/** Opaque, collision-aware tooltip for compact shell controls. */
export function OctantTooltip(props: OctantTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger closeOnClick delay={350} render={props.children} />
      <TooltipPortal>
        <TooltipPositioner
          align={props.align ?? "center"}
          className="octant-tooltip__positioner"
          side={props.side ?? "bottom"}
          sideOffset={8}
        >
          <TooltipPopup
            className={
              props.surface === "card" ? "octant-tooltip octant-tooltip--card" : "octant-tooltip"
            }
            role="tooltip"
          >
            {props.label}
          </TooltipPopup>
        </TooltipPositioner>
      </TooltipPortal>
    </Tooltip>
  );
}
