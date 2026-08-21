import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./utils";
import type { ShadcnMenuItem } from "./dropdown-menu";

export function ContextMenu(props: ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root {...props} />;
}

export function ContextMenuTrigger({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger className={cn(className)} {...props} />;
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
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className={cn(props.triggerClassName, "window-no-drag")} />}>
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner className="z-50 outline-none window-no-drag">
          <ContextMenuPrimitive.Popup className="octant-glass octant-glass--overlay window-no-drag z-50 min-w-48 rounded-md p-1 text-popover-foreground outline-none">
            {props.items.map((item) => (
              <ContextMenuPrimitive.Item
                className={cn(
                  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag",
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
                    <span className="truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </span>
              </ContextMenuPrimitive.Item>
            ))}
          </ContextMenuPrimitive.Popup>
        </ContextMenuPrimitive.Positioner>
      </ContextMenuPrimitive.Portal>
    </ContextMenu>
  );
}
