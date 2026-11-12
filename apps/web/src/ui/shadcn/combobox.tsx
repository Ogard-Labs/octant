import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { ComponentProps } from "react";
import { menuRow } from "./menu-row";
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
        "relative flex h-[round(2.154rem,2px)] w-full min-w-0 items-center rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] outline-none window-no-drag",
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
        "h-full min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-(--oct-disabled-opacity)",
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
        "mr-1 inline-flex size-[round(1.846rem,2px)] cursor-default items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-(--oct-icon-md)",
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
      className={cn(
        "z-[var(--oct-z-popup)] w-[var(--anchor-width)] outline-none window-no-drag",
        className,
      )}
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
        "max-h-[min(320px,var(--available-height))] overflow-auto rounded-xl bg-popover p-(--oct-menu-inset) text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none",
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
      // The library keeps this element in the list while there are matches, so
      // its padding is only for when it has words: empty, it stood as a 20px gap
      // above the first row.
      className={cn("px-2 py-2 text-center text-sm text-muted-foreground empty:p-0", className)}
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
      className={cn(menuRow, className)}
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
        "ml-auto inline-flex size-(--oct-icon-md) shrink-0 items-center justify-center text-foreground [&_svg]:size-(--oct-icon-md)",
        className,
      )}
      data-slot="combobox-item-indicator"
      {...props}
    />
  );
}
