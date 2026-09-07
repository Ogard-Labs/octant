import { useId, useState, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../shadcn/context-menu";
import { cn } from "../shadcn/utils";
import type { OctantMenuItem } from "./OctantMenu";

export interface OctantContextMenuProps {
  readonly items: ReadonlyArray<OctantMenuItem>;
  readonly onValueChange: (value: string) => void;
  readonly children: ReactNode;
  readonly triggerClassName?: string;
}

/**
 * Octant context-menu adapter: the same items a dropdown action menu offers,
 * opened from the pointer's context-menu gesture rather than a trigger button.
 */
export function OctantContextMenu(props: OctantContextMenuProps) {
  // The adapter owns its own root, so it is the only place that can see this
  // menu open and say so. Base UI does not set `aria-expanded` for a context
  // menu, and the trigger rendered here reaches every caller of it.
  const [open, setOpen] = useState(false);
  // An item's accessible name is its label alone. Base UI names an item from
  // its content, so a described item read as "Rename Change the thread's
  // title" — the same defect the dropdown adapter already names its parts to
  // avoid. `label` only steers typeahead; it does not name the item.
  const menuId = useId();
  const labelId = (index: number) => `${menuId}-item-${index}-label`;
  const descriptionId = (index: number) => `${menuId}-item-${index}-description`;
  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger
        aria-expanded={open}
        className={cn(props.triggerClassName, "window-no-drag")}
      >
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {props.items.map((item, index) => (
          <ContextMenuItem
            aria-labelledby={labelId(index)}
            {...(item.description === undefined
              ? {}
              : { "aria-describedby": descriptionId(index) })}
            className="gap-2"
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
              <span className="truncate font-medium" id={labelId(index)}>
                {item.label}
              </span>
              {item.description === undefined ? null : (
                <span className="truncate text-xs text-muted-foreground" id={descriptionId(index)}>
                  {item.description}
                </span>
              )}
            </span>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const OctantContextMenuRoot = ContextMenu;
export const OctantContextMenuTrigger = ContextMenuTrigger;
export const OctantContextMenuContent = ContextMenuContent;
export const OctantContextMenuGroup = ContextMenuGroup;
export const OctantContextMenuLabel = ContextMenuLabel;
export const OctantContextMenuItem = ContextMenuItem;
export const OctantContextMenuSeparator = ContextMenuSeparator;
export const OctantContextMenuSub = ContextMenuSub;
export const OctantContextMenuSubTrigger = ContextMenuSubTrigger;
export const OctantContextMenuSubContent = ContextMenuSubContent;
