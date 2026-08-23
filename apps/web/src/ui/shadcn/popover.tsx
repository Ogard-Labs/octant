import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger({
  className,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return (
    <PopoverPrimitive.Trigger
      className={cn(
        "inline-flex cursor-pointer items-center justify-center rounded-md outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      data-slot="popover-trigger"
      {...props}
    />
  );
}

export function PopoverPortal(props: ComponentProps<typeof PopoverPrimitive.Portal>) {
  return <PopoverPrimitive.Portal {...props} />;
}

export function PopoverPositioner(props: ComponentProps<typeof PopoverPrimitive.Positioner>) {
  return <PopoverPrimitive.Positioner {...props} />;
}

export function PopoverPopup({
  className,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Popup>) {
  return (
    <PopoverPrimitive.Popup
      className={cn(
        "z-50 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none",
        className,
      )}
      data-slot="popover-content"
      {...props}
    />
  );
}

export function PopoverTitle({
  className,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Title>) {
  return (
    <PopoverPrimitive.Title
      className={cn("text-sm font-semibold text-foreground", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export function PopoverDescription({
  className,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Description>) {
  return (
    <PopoverPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      data-slot="popover-description"
      {...props}
    />
  );
}
