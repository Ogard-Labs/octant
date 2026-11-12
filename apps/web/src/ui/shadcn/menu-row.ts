/*
 * The one row every pick-list draws: a menu, a context menu, a select, a
 * combobox and the model list. Its height, inset, gap and type are the
 * `--oct-menu-*` tokens and the Menu option role, so the same line of text
 * stands on the same x in every menu: a row with an icon puts the words at
 * 4 (the popup) + 8 (the row) + 16 (the icon column) + 8 (the gap) = 36px
 * from the popup's edge, and a row with none at 12px. A menu where any row has
 * an icon reserves the column for all of them (`menuIconColumn`), so no menu
 * has two edges. A row that carries a second line (`oct-menu-detail`) is 44px;
 * it never shrinks under the height.
 *
 * An icon that is a direct child takes the 16px column whatever size the call
 * site drew it at; a feature stylesheet that sets a row's own font size, gap or
 * padding is repainting the recipe.
 */
export const menuRow =
  "relative flex min-h-(--oct-menu-row-h) has-[.oct-menu-detail]:min-h-(--oct-menu-row-two-h) cursor-default items-center gap-(--oct-menu-row-gap) rounded-md px-(--oct-menu-row-inset) py-1 oct-menu-option outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-(--oct-disabled-opacity) data-highlighted:bg-accent data-highlighted:text-accent-foreground [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-(--oct-icon-md)";

/** The 16px box an icon stands in, so labels without one can reserve it. */
export const menuIconColumn = "flex size-(--oct-icon-md) shrink-0 items-center justify-center";

/** A group's heading is the navigation group label, on the rows' inset so its words line up with theirs. */
export const menuGroupLabel = "oct-nav-group px-(--oct-menu-row-inset) py-1";

/** One hairline, as wide as the rows: it stands in from the popup's edge by the same inset as they do. */
export const menuSeparator = "my-1 h-px bg-border";
