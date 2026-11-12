import type { ReactNode } from "react";
import { useId, useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuPortal,
  DropdownMenuPositioner,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./NativeDropdownMenu";
import {
  DropdownMenu as OctantMenuRoot,
  DropdownMenuCheckboxItem as OctantMenuCheckboxItem,
  DropdownMenuGroup as OctantMenuGroup,
  DropdownMenuGroupLabel as OctantMenuGroupLabel,
  DropdownMenuItem as OctantMenuItem,
  DropdownMenuPopup as OctantMenuPopup,
  DropdownMenuPortal as OctantMenuPortal,
  DropdownMenuPositioner as OctantMenuPositioner,
  DropdownMenuRadioGroup as OctantMenuRadioGroup,
  DropdownMenuRadioItem as OctantMenuRadioItem,
  DropdownMenuSeparator as OctantMenuSeparator,
  DropdownMenuSub as OctantMenuSub,
  DropdownMenuSubPopup as OctantMenuSubPopup,
  DropdownMenuSubTrigger as OctantMenuSubTrigger,
  DropdownMenuTrigger as OctantMenuTrigger,
} from "./NativeDropdownMenu";
import { menuIconColumn } from "../shadcn/menu-row";
import { cn } from "../shadcn/utils";

export {
  OctantMenuRoot,
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuSeparator,
  OctantMenuSub,
  OctantMenuSubPopup,
  OctantMenuSubTrigger,
  OctantMenuTrigger,
};

export interface OctantMenuItem {
  readonly description?: string;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly value: string;
}

export interface OctantMenuAction {
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface OctantMenuProps {
  readonly actions?: ReadonlyArray<OctantMenuAction>;
  readonly items: ReadonlyArray<OctantMenuItem>;
  readonly onValueChange: (value: string) => void;
  readonly trigger: ReactNode;
  /**
   * Replaces `octant-menu__trigger` rather than adding to it: the caller's
   * recipe and the default style the same properties, and stylesheet order
   * would otherwise decide which one wins.
   */
  readonly triggerClassName?: string;
  /** A trigger that cannot open right now, such as a composer that is already sending. */
  readonly triggerDisabled?: boolean;
  readonly triggerLabel: string;
  /** A tooltip for a trigger whose words a narrow room can hide. */
  readonly triggerTitle?: string;
  readonly value: string;
  /** Action menus invoke every enabled item, including the current value. */
  readonly selectionMode?: "radio" | "action";
}

/** Octant menu adapter over the owned shadcn/Base UI DropdownMenu recipe. */
export function OctantMenu(props: OctantMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // An item's accessible name is its label alone; the description is exposed
  // as a description. Naming from content ran the two together ("Work Work
  // with local files and documents") and left the mode menu unnamed in the
  // shell's accessibility tree.
  const menuId = useId();
  const labelId = (index: number) => `${menuId}-item-${index}-label`;
  const descriptionId = (index: number) => `${menuId}-item-${index}-description`;
  // A menu where any row has an icon reserves the column for all of them, so
  // the words stand on one edge; a menu with none keeps them on the popup's own
  // inset.
  const hasIcons =
    props.items.some((item) => item.icon !== undefined) ||
    (props.actions ?? []).some((action) => action.icon !== undefined);
  const itemBody = (item: OctantMenuItem, index: number) => (
    <>
      {hasIcons ? (
        <span aria-hidden="true" className={menuIconColumn}>
          {item.icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" id={labelId(index)}>
          {item.label}
        </span>
        {item.description === undefined ? null : (
          <span className="truncate oct-menu-detail" id={descriptionId(index)}>
            {item.description}
          </span>
        )}
      </span>
    </>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={props.triggerLabel}
        className={cn(props.triggerClassName ?? "octant-menu__trigger", "window-no-drag")}
        disabled={props.triggerDisabled === true}
        ref={triggerRef}
        {...(props.triggerTitle === undefined ? {} : { title: props.triggerTitle })}
      >
        {props.trigger}
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuPositioner>
          <DropdownMenuPopup className="window-no-drag" finalFocus={triggerRef}>
            {props.selectionMode === "action" ? (
              props.items.map((item, index) => (
                <DropdownMenuItem
                  aria-labelledby={labelId(index)}
                  {...(item.description === undefined
                    ? {}
                    : { "aria-describedby": descriptionId(index) })}
                  key={item.value}
                  {...(item.disabled === true ? { disabled: true } : {})}
                  onClick={() => props.onValueChange(item.value)}
                >
                  {itemBody(item, index)}
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuRadioGroup
                onValueChange={(value) => {
                  if (
                    typeof value === "string" &&
                    props.items.some((item) => item.value === value && item.disabled !== true)
                  ) {
                    props.onValueChange(value);
                  }
                }}
                value={props.value}
              >
                {props.items.map((item, index) => (
                  <DropdownMenuRadioItem
                    aria-labelledby={labelId(index)}
                    {...(item.description === undefined
                      ? {}
                      : { "aria-describedby": descriptionId(index) })}
                    // The recipe leaves this to the caller; without it a radio
                    // choice leaves the menu open and focus never returns to
                    // the trigger.
                    closeOnClick
                    key={item.value}
                    label={item.label}
                    {...(item.disabled === true ? { disabled: true } : {})}
                    value={item.value}
                  >
                    {itemBody(item, index)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
            {props.actions === undefined || props.actions.length === 0 ? null : (
              <>
                <DropdownMenuSeparator />
                {props.actions.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    {...(action.disabled === true ? { disabled: true } : {})}
                    onClick={action.onSelect}
                  >
                    {hasIcons ? (
                      <span aria-hidden="true" className={menuIconColumn}>
                        {action.icon}
                      </span>
                    ) : null}
                    <span className="truncate">{action.label}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuPopup>
        </DropdownMenuPositioner>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
