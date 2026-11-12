/** A trailing icon of the Browser toolbar, in the order it is drawn. */
export type BrowserToolbarTrailing = "status" | "hold" | "extensions" | "profile";

/** The address keeps at least this much width. */
export const BROWSER_ADDRESS_MIN_WIDTH = 120;
/** Most trailing icons the row draws besides the More menu. */
export const BROWSER_TRAILING_LIMIT = 3;

// The row's measures, from its CSS: 28px buttons (`--oct-rail-button-h`), 4px
// gaps (`--oct-space-1`), a 6px start inset and a 4px end inset, three history
// buttons before the address.
const BUTTON = 28;
const GAP = 4;
const INSETS = 10;
const HISTORY = 3;

/** The address field's width when `trailing` buttons (the More menu included) follow it. */
export function addressWidth(rowWidth: number, trailing: number): number {
  const items = HISTORY + 1 + trailing;
  return rowWidth - INSETS - (HISTORY + trailing) * BUTTON - (items - 1) * GAP;
}

/**
 * Which trailing icons move into the More menu: from the left of the list,
 * until no more than three remain and the address keeps its floor. The profile
 * is the last icon and never folds. An unknown width only applies the limit.
 */
export function foldedTrailing(options: {
  readonly rowWidth: number | undefined;
  readonly visible: ReadonlyArray<BrowserToolbarTrailing>;
  /** The More menu has items of its own, so it is drawn even with nothing folded. */
  readonly moreHasItems: boolean;
}): ReadonlySet<BrowserToolbarTrailing> {
  const folded = new Set<BrowserToolbarTrailing>();
  for (const candidate of options.visible) {
    const drawn = options.visible.length - folded.size;
    const more = options.moreHasItems || folded.size > 0 ? 1 : 0;
    const fits =
      drawn <= BROWSER_TRAILING_LIMIT &&
      (options.rowWidth === undefined ||
        addressWidth(options.rowWidth, drawn + more) >= BROWSER_ADDRESS_MIN_WIDTH);
    if (fits || candidate === "profile") break;
    folded.add(candidate);
  }
  return folded;
}
