import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "./utils";
import type { ShadcnMenuItem } from "./dropdown-menu";

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

export function ContextMenuItem({
  className,
  closeOnClick = true,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "window-no-drag relative flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className,
      )}
      closeOnClick={closeOnClick}
      {...props}
    />
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

export interface ShadcnContextMenuProps {
  readonly items: ReadonlyArray<ShadcnMenuItem>;
  readonly onValueChange: (value: string) => void;
  readonly children: ReactNode;
  readonly triggerClassName?: string;
}

/**
 * Owned context-menu recipe: the same items a dropdown action menu offers,
 * opened from the pointer's context-menu gesture rather than a trigger button.
 */
export function ShadcnContextMenu(props: ShadcnContextMenuProps) {
  // The recipe owns its own root, so it is the only place that can see this
  // menu open and say so. Base UI does not set `aria-expanded` for a context
  // menu, and the trigger the recipe renders reaches every caller of it.
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger
        aria-expanded={open}
        className={cn(props.triggerClassName, "window-no-drag")}
      >
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {props.items.map((item) => (
          <ContextMenuItem
            className={cn(
              "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag",
            )}
            closeOnClick
            key={item.value}
            label={item.label}
            {...(item.disabled === true ? { disabled: true } : {})}
            onClick={() => {
              if (item.disabled === true) return;
              props.onValueChange(item.value);
            }}
          >
            {item.icon === undefined ? null : (
              <span aria-hidden="true" className="flex size-4 items-center justify-center">
                {item.icon}
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{item.label}</span>
              {item.description === undefined ? null : (
                <span className="truncate text-xs text-muted-foreground">{item.description}</span>
              )}
            </span>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
