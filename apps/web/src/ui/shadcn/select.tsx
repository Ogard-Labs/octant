import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { fieldPaint } from "./field-paint";
import { menuGroupLabel, menuRow } from "./menu-row";
import { cn } from "./utils";

export function Select(props: ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        fieldPaint,
        "flex h-8 w-full items-center justify-between gap-2 px-2.5 py-1 text-sm text-foreground whitespace-nowrap outline-none transition-colors disabled:pointer-events-none disabled:cursor-default disabled:opacity-(--oct-disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--oct-icon-md) [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      data-slot="select-trigger"
      {...props}
    >
      {children ?? <SelectPrimitive.Value />}
      <SelectPrimitive.Icon className="shrink-0 text-muted-foreground">
        <ChevronDown aria-hidden="true" className="size-(--oct-icon-xs)" data-icon="inline-end" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectPopup({ className, ...props }: ComponentProps<typeof SelectPrimitive.Popup>) {
  return (
    <SelectPrimitive.Popup
      className={cn(
        "z-[var(--oct-z-popup)] max-h-72 min-w-[var(--anchor-width)] overflow-auto rounded-xl bg-popover p-(--oct-menu-inset) text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none",
        className,
      )}
      data-slot="select-content"
      {...props}
    />
  );
}

export function SelectGroup(props: ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectGroupLabel({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn(menuGroupLabel, className)}
      data-slot="select-group-label"
      {...props}
    />
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      // The trailing inset is the check mark's column.
      className={cn(menuRow, "w-full pr-8", className)}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-(--oct-menu-row-inset) flex size-(--oct-icon-sm) items-center justify-center">
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectPortal(props: ComponentProps<typeof SelectPrimitive.Portal>) {
  return <SelectPrimitive.Portal {...props} />;
}

export function SelectPositioner(props: ComponentProps<typeof SelectPrimitive.Positioner>) {
  return <SelectPrimitive.Positioner {...props} />;
}

export function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value {...props} />;
}
