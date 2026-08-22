import { ShadcnContextMenu, type ShadcnContextMenuProps } from "../shadcn/context-menu";

/** Octant context-menu adapter over the owned shadcn/Base UI ContextMenu recipe. */
export function OctantContextMenu(props: ShadcnContextMenuProps) {
  return <ShadcnContextMenu {...props} />;
}
