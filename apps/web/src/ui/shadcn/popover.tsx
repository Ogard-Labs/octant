import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * The popup is a floating overlay, so it keeps a shadow — 0086 reserves those
 * for things that genuinely float. `--octant-shadow-overlay` already carries a
 * 1px hairline inside the token, so it needs no separate border or ring; the
 * style adds one because its own shadow does not.
 */

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
        "inline-flex cursor-pointer items-center justify-center rounded-lg outline-none",
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
        "z-50 rounded-xl bg-popover p-2.5 text-sm text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none",
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
