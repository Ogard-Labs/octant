import { menuIconColumn } from "../shadcn/menu-row";

/**
 * An empty icon column. A menu where some rows carry an icon reserves the
 * column on the rest so the words stand on one edge; the adapters do it for
 * their own items, and a hand-built menu that mixes the two puts this first in
 * each row without one.
 */
export function OctantMenuIconSlot() {
  return <span aria-hidden="true" className={menuIconColumn} data-slot="menu-icon-slot" />;
}
