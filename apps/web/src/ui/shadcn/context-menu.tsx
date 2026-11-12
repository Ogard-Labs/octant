import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { menuGroupLabel, menuRow, menuSeparator } from "./menu-row";
import { cn } from "./utils";

export function ContextMenu(props: ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root {...props} />;
}

export function ContextMenuTrigger({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  // `aria-haspopup` is a fact about the trigger, so it belongs here. The
  // expanded state is not: a trigger that always reports `false` tells a screen
  // reader the menu is closed while it is open, which reads worse than saying
  // nothing at all. Each call site owns `aria-expanded` and passes its own
  // menu state.
  return <ContextMenuPrimitive.Trigger aria-haspopup="menu" className={cn(className)} {...props} />;
}

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Popup>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-[var(--oct-z-popup)] outline-none window-no-drag">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "window-no-drag min-w-[12rem] rounded-xl bg-popover p-(--oct-menu-inset) text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuGroup(props: ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group {...props} />;
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.GroupLabel>) {
  return (
    <ContextMenuPrimitive.GroupLabel
      className={cn(menuGroupLabel, "truncate", className)}
      {...props}
    />
  );
}

const contextMenuItemClassName = cn(menuRow, "window-no-drag");

export function ContextMenuItem({
  className,
  closeOnClick = true,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(contextMenuItemClassName, className)}
      closeOnClick={closeOnClick}
      {...props}
    />
  );
}

export function ContextMenuCheckboxItem({
  className,
  children,
  closeOnClick = true,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      className={cn(contextMenuItemClassName, className)}
      closeOnClick={closeOnClick}
      {...props}
    >
      {children}
      <ContextMenuPrimitive.CheckboxItemIndicator className="ml-auto pl-2 text-foreground">
        <Check aria-hidden="true" size={14} />
      </ContextMenuPrimitive.CheckboxItemIndicator>
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export function ContextMenuSub(props: ComponentProps<typeof ContextMenuPrimitive.SubmenuRoot>) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />;
}

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.SubmenuTrigger>) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      className={cn(contextMenuItemClassName, className)}
      data-slot="context-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="ml-auto size-(--oct-icon-sm)" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Popup>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        align="start"
        className="z-[var(--oct-z-popup)] outline-none window-no-drag"
        side="right"
        sideOffset={0}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "window-no-drag min-w-[12rem] rounded-xl bg-popover p-(--oct-menu-inset) text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}
