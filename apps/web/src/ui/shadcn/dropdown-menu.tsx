import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type MutableRefObject,
} from "react";
import { cn } from "./utils";

/** Whether the open in progress came from the keyboard, set by the root, read by the popup. */
const OpenedByKeyboard = createContext<MutableRefObject<boolean> | undefined>(undefined);

export function DropdownMenu({
  onOpenChange,
  ...props
}: ComponentProps<typeof MenuPrimitive.Root>) {
  const openedByKeyboard = useRef(false);
  return (
    <OpenedByKeyboard.Provider value={openedByKeyboard}>
      <MenuPrimitive.Root
        data-slot="dropdown-menu"
        onOpenChange={(open, details) => {
          const event = details.event;
          openedByKeyboard.current =
            open &&
            (event instanceof KeyboardEvent || (event instanceof MouseEvent && event.detail === 0));
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </OpenedByKeyboard.Provider>
  );
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

/**
 * A menu opened from the keyboard lands on its first item. When the menu leads
 * with a choice, the current one is where a person expects to start (a select
 * does), so move there. ArrowUp opens on the last item on purpose and stays there.
 */
function useStartOnCheckedItem(popup: MutableRefObject<HTMLDivElement | null>) {
  const openedByKeyboard = useContext(OpenedByKeyboard);
  useEffect(() => {
    if (openedByKeyboard?.current !== true) return;
    let frame = 0;
    let tries = 0;
    const settle = () => {
      const root = popup.current;
      if (root === null) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
        (item) => !item.hasAttribute("data-disabled"),
      );
      // Only a menu that leads with its choices. A menu of filters or actions
      // that happens to hold a checked radio further down opens on its first item.
      if (items[0]?.getAttribute("role") !== "menuitemradio") return;
      const checked = items.find(
        (item) =>
          item.getAttribute("role") === "menuitemradio" &&
          item.getAttribute("aria-checked") === "true",
      );
      if (checked === undefined || document.activeElement === checked) return;
      if (document.activeElement === items[0]) {
        checked.focus();
        return;
      }
      if (tries++ < 10) frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [openedByKeyboard, popup]);
}

export function DropdownMenuPopup({
  className,
  ref,
  ...props
}: ComponentProps<typeof MenuPrimitive.Popup>) {
  const popup = useRef<HTMLDivElement | null>(null);
  useStartOnCheckedItem(popup);
  return (
    <MenuPrimitive.Popup
      ref={(node) => {
        popup.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref !== null && ref !== undefined) ref.current = node;
      }}
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
  "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground window-no-drag";

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
        {/* A submenu opens on its first item whatever opened the root menu. */}
        <OpenedByKeyboard.Provider value={undefined}>
          <DropdownMenuPopup className={cn("window-no-drag", className)} {...props} />
        </OpenedByKeyboard.Provider>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}
