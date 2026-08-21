import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useRef } from "react";
import { cn } from "./utils";

export function DropdownMenu(props: ComponentProps<typeof MenuPrimitive.Root>) {
  return <MenuPrimitive.Root {...props} />;
}

export function DropdownMenuTrigger({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Trigger>) {
  return (
    <MenuPrimitive.Trigger
      className={cn(
        "inline-flex items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
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
        "octant-glass octant-glass--overlay z-50 min-w-48 rounded-md p-1 text-popover-foreground outline-none",
        className,
      )}
      {...props}
    />
  );
}

export interface ShadcnMenuItem {
  readonly description?: string;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly value: string;
}

export interface ShadcnDropdownMenuProps {
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
}

export function ShadcnDropdownMenu(props: ShadcnDropdownMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
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
              {props.items.map((item) => (
                <MenuPrimitive.RadioItem
                  className={cn(
                    "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag",
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
                    <span className="truncate font-medium">{item.label}</span>
                    {item.description === undefined ? null : (
                      <span className="truncate text-xs text-muted-foreground">
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
          </DropdownMenuPopup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </DropdownMenu>
  );
}
