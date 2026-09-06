import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useId, useRef } from "react";
import { cn } from "./utils";

export function DropdownMenu(props: ComponentProps<typeof MenuPrimitive.Root>) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

export function DropdownMenuTrigger({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Trigger>) {
  return (
    <MenuPrimitive.Trigger
      className={cn(
        "inline-flex cursor-pointer items-center justify-center rounded-md outline-none",
        className,
      )}
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

export function DropdownMenuPopup({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Popup>) {
  return (
    <MenuPrimitive.Popup
      className={cn(
        "z-50 min-w-48 rounded-xl bg-popover p-1 text-popover-foreground shadow-[var(--octant-shadow-overlay)] outline-none data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="dropdown-menu-content"
      {...props}
    />
  );
}

const dropdownMenuItemClassName =
  "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag";

export function DropdownMenuPortal(props: ComponentProps<typeof MenuPrimitive.Portal>) {
  return <MenuPrimitive.Portal {...props} />;
}

export function DropdownMenuPositioner({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Positioner>) {
  return (
    <MenuPrimitive.Positioner
      align="start"
      className={cn("z-50 outline-none window-no-drag", className)}
      side="bottom"
      sideOffset={4}
      {...props}
    />
  );
}

export function DropdownMenuGroup(props: ComponentProps<typeof MenuPrimitive.Group>) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

export function DropdownMenuGroupLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.GroupLabel>) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      className={cn(dropdownMenuItemClassName, className)}
      closeOnClick
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      data-slot="dropdown-menu-separator"
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem
      className={cn(dropdownMenuItemClassName, className)}
      data-slot="dropdown-menu-checkbox-item"
      {...props}
    >
      {children}
      <MenuPrimitive.CheckboxItemIndicator className="octant-menu__indicator ml-auto text-foreground">
        <Check aria-hidden="true" size={14} strokeWidth={1.8} />
      </MenuPrimitive.CheckboxItemIndicator>
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioGroup(props: ComponentProps<typeof MenuPrimitive.RadioGroup>) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(dropdownMenuItemClassName, className)}
      data-slot="dropdown-menu-radio-item"
      {...props}
    >
      {children}
      <MenuPrimitive.RadioItemIndicator className="octant-menu__indicator ml-auto text-foreground">
        <Check aria-hidden="true" size={14} strokeWidth={1.8} />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSub(props: ComponentProps<typeof MenuPrimitive.SubmenuRoot>) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubmenuTrigger>) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(dropdownMenuItemClassName, className)}
      data-slot="dropdown-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="ml-auto" size={14} strokeWidth={1.8} />
    </MenuPrimitive.SubmenuTrigger>
  );
}

export function DropdownMenuSubPopup({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Popup>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align="start"
        className="z-50 outline-none window-no-drag"
        side="right"
        sideOffset={0}
      >
        <DropdownMenuPopup className={cn("window-no-drag", className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export interface ShadcnMenuItem {
  readonly description?: string;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly value: string;
}

export interface ShadcnMenuAction {
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ShadcnDropdownMenuProps {
  readonly actions?: ReadonlyArray<ShadcnMenuAction>;
  readonly items: ReadonlyArray<ShadcnMenuItem>;
  readonly onValueChange: (value: string) => void;
  readonly trigger: ReactNode;
  /**
   * Replaces `octant-menu__trigger` rather than adding to it: the caller's
   * recipe and the default style the same properties, and stylesheet order
   * would otherwise decide which one wins.
   */
  readonly triggerClassName?: string;
  readonly triggerLabel: string;
  readonly value: string;
  /** Action menus invoke every enabled item, including the current value. */
  readonly selectionMode?: "radio" | "action";
}

export function ShadcnDropdownMenu(props: ShadcnDropdownMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // An item's accessible name is its label alone; the description is exposed
  // as a description. Naming from content ran the two together ("Work Work
  // with local files and documents") and left the mode menu unnamed in the
  // shell's accessibility tree.
  const menuId = useId();
  const labelId = (index: number) => `${menuId}-item-${index}-label`;
  const descriptionId = (index: number) => `${menuId}-item-${index}-description`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={props.triggerLabel}
        className={cn(props.triggerClassName ?? "octant-menu__trigger", "window-no-drag")}
        ref={triggerRef}
      >
        {props.trigger}
      </DropdownMenuTrigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          align="start"
          className="z-50 outline-none window-no-drag"
          side="bottom"
          sideOffset={4}
        >
          <DropdownMenuPopup className="window-no-drag" finalFocus={triggerRef}>
            {props.selectionMode === "action" ? (
              props.items.map((item, index) => (
                <MenuPrimitive.Item
                  aria-labelledby={labelId(index)}
                  {...(item.description === undefined
                    ? {}
                    : { "aria-describedby": descriptionId(index) })}
                  className={cn(
                    "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag",
                  )}
                  closeOnClick
                  key={item.value}
                  {...(item.disabled === true ? { disabled: true } : {})}
                  onClick={() => props.onValueChange(item.value)}
                >
                  <span aria-hidden="true" className="flex size-4 items-center justify-center">
                    {item.icon}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium" id={labelId(index)}>
                      {item.label}
                    </span>
                    {item.description === undefined ? null : (
                      <span
                        className="truncate text-xs text-muted-foreground"
                        id={descriptionId(index)}
                      >
                        {item.description}
                      </span>
                    )}
                  </span>
                </MenuPrimitive.Item>
              ))
            ) : (
              <MenuPrimitive.RadioGroup
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
                  <MenuPrimitive.RadioItem
                    aria-labelledby={labelId(index)}
                    {...(item.description === undefined
                      ? {}
                      : { "aria-describedby": descriptionId(index) })}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag",
                    )}
                    closeOnClick
                    key={item.value}
                    label={item.label}
                    {...(item.disabled === true ? { disabled: true } : {})}
                    onKeyDown={(event) => {
                      if (event.key === " ") {
                        event.preventDefault();
                        event.currentTarget.click();
                      }
                    }}
                    value={item.value}
                  >
                    <span aria-hidden="true" className="flex size-4 items-center justify-center">
                      {item.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium" id={labelId(index)}>
                        {item.label}
                      </span>
                      {item.description === undefined ? null : (
                        <span
                          className="truncate text-xs text-muted-foreground"
                          id={descriptionId(index)}
                        >
                          {item.description}
                        </span>
                      )}
                    </span>
                    <MenuPrimitive.RadioItemIndicator className="octant-menu__indicator ml-auto text-foreground">
                      <Check aria-hidden="true" size={14} strokeWidth={1.8} />
                    </MenuPrimitive.RadioItemIndicator>
                  </MenuPrimitive.RadioItem>
                ))}
              </MenuPrimitive.RadioGroup>
            )}
            {props.actions === undefined || props.actions.length === 0 ? null : (
              <>
                <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
                {props.actions.map((action) => (
                  <MenuPrimitive.Item
                    className="relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag"
                    closeOnClick
                    key={action.label}
                    {...(action.disabled === true ? { disabled: true } : {})}
                    onClick={action.onSelect}
                  >
                    <span aria-hidden="true" className="flex size-4 items-center justify-center">
                      {action.icon}
                    </span>
                    <span className="truncate font-medium">{action.label}</span>
                  </MenuPrimitive.Item>
                ))}
              </>
            )}
          </DropdownMenuPopup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </DropdownMenu>
  );
}
