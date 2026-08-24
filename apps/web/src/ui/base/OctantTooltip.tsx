import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

export interface OctantTooltipProps {
  readonly children: ReactElement;
  readonly label: ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "right" | "bottom" | "left";
}

/** Opaque, collision-aware tooltip for compact shell controls. */
export function OctantTooltip(props: OctantTooltipProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger closeOnClick delay={350} render={props.children} />
      <Tooltip.Portal>
        <Tooltip.Positioner
          align={props.align ?? "center"}
          className="octant-tooltip__positioner"
          side={props.side ?? "bottom"}
          sideOffset={8}
        >
          <Tooltip.Popup className="octant-tooltip" role="tooltip">
            {props.label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
