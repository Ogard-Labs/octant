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
          <TooltipPopup className="octant-tooltip" role="tooltip">
            {props.label}
          </TooltipPopup>
        </TooltipPositioner>
      </TooltipPortal>
    </Tooltip>
  );
}
