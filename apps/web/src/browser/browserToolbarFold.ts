/** A trailing icon of the Browser toolbar, in the order it is drawn. */
export type BrowserToolbarTrailing = "status" | "hold" | "extensions" | "profile";

/** A trailing control and the width it takes in the row. */
export interface BrowserToolbarTrailingItem {
  readonly id: BrowserToolbarTrailing;
  readonly width: number;
}

/** The address keeps at least this much width. */
export const BROWSER_ADDRESS_MIN_WIDTH = 120;
/** Most trailing icons the row draws besides the More menu. */
export const BROWSER_TRAILING_LIMIT = 3;

// The row's measures, from its CSS: 28px buttons (`--oct-rail-button-h`), 4px
// gaps (`--oct-space-1`), a 6px start inset and a 4px end inset, three history
// buttons before the address.
export const BROWSER_BUTTON_WIDTH = 28;
const GAP = 4;
const INSETS = 10;
const HISTORY = 3;
/** The extensions button with the agent's count beside its icon. */
export const BROWSER_COUNTED_BUTTON_WIDTH = 40;

/** The address field's width when controls of these widths (the More menu included) follow it. */
export function addressWidth(rowWidth: number, trailing: ReadonlyArray<number>): number {
  const items = HISTORY + 1 + trailing.length;
  const widths = HISTORY * BROWSER_BUTTON_WIDTH + trailing.reduce((sum, width) => sum + width, 0);
  return rowWidth - INSETS - widths - (items - 1) * GAP;
}

/**
 * Which trailing icons move into the More menu: from the left of the list,
 * until no more than three remain and the address keeps its floor. The profile
 * is last, so it folds only when nothing else is left to fold and the floor
 * still fails. Its name shrinks with an ellipsis before anything folds, so it
 * counts as its icon's width. An unknown width only applies the limit.
 */
export function foldedTrailing(options: {
  readonly rowWidth: number | undefined;
  readonly visible: ReadonlyArray<BrowserToolbarTrailingItem>;
  /** The More menu has items of its own, so it is drawn even with nothing folded. */
  readonly moreHasItems: boolean;
}): ReadonlySet<BrowserToolbarTrailing> {
  const folded = new Set<BrowserToolbarTrailing>();
  for (const candidate of options.visible) {
    const drawn = options.visible.filter((item) => !folded.has(item.id));
    const more = options.moreHasItems || folded.size > 0;
    const widths = [
      ...drawn.map((item) => (item.id === "profile" ? BROWSER_BUTTON_WIDTH : item.width)),
      ...(more ? [BROWSER_BUTTON_WIDTH] : []),
    ];
    const fits =
      drawn.length <= BROWSER_TRAILING_LIMIT &&
      (options.rowWidth === undefined ||
        addressWidth(options.rowWidth, widths) >= BROWSER_ADDRESS_MIN_WIDTH);
    if (fits) break;
    folded.add(candidate.id);
  }
  return folded;
}
