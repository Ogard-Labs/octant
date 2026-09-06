import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export const Combobox = ComboboxPrimitive.Root;
export const ComboboxPortal = ComboboxPrimitive.Portal;

export function ComboboxInputGroup({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.InputGroup>) {
  return (
    <ComboboxPrimitive.InputGroup
      className={cn(
        "relative flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] outline-none focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 window-no-drag",
        className,
      )}
      data-slot="combobox-input-group"
      {...props}
    />
  );
}

export function ComboboxInput({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Input>) {
  return (
    <ComboboxPrimitive.Input
      className={cn(
        "h-full min-w-0 flex-1 bg-transparent px-3 py-1 text-sm text-foreground outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      data-slot="combobox-input"
      {...props}
    />
  );
}

export function ComboboxTrigger({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Trigger>) {
  return (
    <ComboboxPrimitive.Trigger
      className={cn(
        "mr-1 inline-flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4",
        className,
      )}
      data-slot="combobox-trigger"
      {...props}
    />
  );
}

export function ComboboxPositioner({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Positioner>) {
  return (
    <ComboboxPrimitive.Positioner
      className={cn("z-50 w-[var(--anchor-width)] outline-none window-no-drag", className)}
      data-slot="combobox-positioner"
      {...props}
    />
  );
}

export function ComboboxPopup({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Popup>) {
  return (
    <ComboboxPrimitive.Popup
      className={cn(
        "max-h-[min(320px,var(--available-height))] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="combobox-content"
      {...props}
    />
  );
}

export function ComboboxEmpty({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Empty>) {
  return (
    <ComboboxPrimitive.Empty
      className={cn("px-2 py-3 text-center text-sm text-muted-foreground", className)}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

export const ComboboxList = ComboboxPrimitive.List;

export function ComboboxItem({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Item>) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "relative flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    />
  );
}

export function ComboboxItemIndicator({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.ItemIndicator>) {
  return (
    <ComboboxPrimitive.ItemIndicator
      className={cn(
        "ml-auto inline-flex size-4 shrink-0 items-center justify-center text-foreground [&_svg]:size-4",
        className,
      )}
      data-slot="combobox-item-indicator"
      {...props}
    />
  );
}
