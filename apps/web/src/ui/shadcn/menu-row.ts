/*
 * The row every pick-list draws: a menu, a context menu, a select and a
 * combobox. Its height and its inset are the `--oct-menu-row-*` tokens in
 * octant.css, in pixels. The rem steps each recipe shipped with followed the
 * interface font size, so the same one-line row measured 24px in a menu, 26px
 * in a context menu and a select, and 30px in a combobox, with a 6.5px inset.
 * A row that carries a second line (a described choice) grows past the height;
 * it never shrinks under it.
 */
export const menuRow =
  "relative flex min-h-(--oct-menu-row-h) cursor-default items-center gap-2 rounded-md px-(--oct-menu-row-inset) py-1 oct-menu-option outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-(--oct-disabled-opacity) data-highlighted:bg-accent data-highlighted:text-accent-foreground";

/** A group's heading stands on the rows' inset, so its words line up with theirs. */
export const menuGroupLabel =
  "px-(--oct-menu-row-inset) py-1.5 text-xs font-medium text-muted-foreground";
