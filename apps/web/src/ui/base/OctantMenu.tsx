import type { ReactNode } from "react";
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
  ShadcnDropdownMenu,
} from "../shadcn/dropdown-menu";

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
  /** Replaces the default trigger recipe when a surface owns one (e.g. `mode-trigger`). */
  readonly triggerClassName?: string;
  readonly triggerLabel: string;
  readonly value: string;
  readonly selectionMode?: "radio" | "action";
}

/** Octant menu adapter over the owned shadcn/Base UI DropdownMenu recipe. */
export function OctantMenu(props: OctantMenuProps) {
  return <ShadcnDropdownMenu {...props} />;
}
