import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ShadcnContextMenu,
  type ShadcnContextMenuProps,
} from "../shadcn/context-menu";

/** Octant context-menu adapter over the owned shadcn/Base UI ContextMenu recipe. */
export function OctantContextMenu(props: ShadcnContextMenuProps) {
  return <ShadcnContextMenu {...props} />;
}

export const OctantContextMenuRoot = ContextMenu;
export const OctantContextMenuTrigger = ContextMenuTrigger;
export const OctantContextMenuContent = ContextMenuContent;
export const OctantContextMenuGroup = ContextMenuGroup;
export const OctantContextMenuLabel = ContextMenuLabel;
export const OctantContextMenuItem = ContextMenuItem;
export const OctantContextMenuSeparator = ContextMenuSeparator;
