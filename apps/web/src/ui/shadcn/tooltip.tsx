import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentProps } from "react";

export function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipPortal(props: ComponentProps<typeof TooltipPrimitive.Portal>) {
  return <TooltipPrimitive.Portal {...props} />;
}

export function TooltipPositioner(props: ComponentProps<typeof TooltipPrimitive.Positioner>) {
  return <TooltipPrimitive.Positioner data-slot="tooltip-positioner" {...props} />;
}

export function TooltipPopup(props: ComponentProps<typeof TooltipPrimitive.Popup>) {
  return <TooltipPrimitive.Popup data-slot="tooltip-content" {...props} />;
}
