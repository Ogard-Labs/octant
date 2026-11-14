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
  /**
   * A one-word chip for the rail: it opens beside the control, centred on it,
   * and stays small so it covers as little of the sidebar as it must.
   */
  readonly compact?: boolean;
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
          sideOffset={props.compact === true ? 6 : 8}
        >
          <TooltipPopup
            className={[
              "octant-tooltip",
              props.surface === "card" ? "octant-tooltip--card" : "",
              props.compact === true ? "octant-tooltip--compact" : "",
            ]
              .filter((name) => name !== "")
              .join(" ")}
            role="tooltip"
          >
            {props.label}
          </TooltipPopup>
        </TooltipPositioner>
      </TooltipPortal>
    </Tooltip>
  );
}
