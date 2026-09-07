import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
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
      <ContextMenuPrimitive.Positioner className="outline-none window-no-drag">
        <ContextMenuPrimitive.Popup
          className={cn(
            "window-no-drag min-w-48 rounded-xl bg-popover p-1 text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none",
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
      className={cn("truncate px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

const contextMenuItemClassName =
  "window-no-drag relative flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground";

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
      <ChevronRight aria-hidden="true" className="ml-auto" size={14} strokeWidth={1.8} />
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
        className="outline-none window-no-drag"
        side="right"
        sideOffset={0}
      >
        <ContextMenuPrimitive.Popup
          className={cn(
            "window-no-drag min-w-48 rounded-xl bg-popover p-1 text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none",
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
  return (
    <ContextMenuPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />
  );
}
