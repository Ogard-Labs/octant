import type { CanvasBarListBlock } from "@octant/contracts/canvas";

/**
 * Where a ranked bar list's rows sit, worked out from the block alone.
 *
 * A bar list is a ranking: rows are ordered by their value, largest first by
 * default, and each bar's length is its share of the largest value. The order
 * is deterministic — ties keep the author's declared order — so the screen
 * renderer and the static SVG export draw the same list. Nothing here reads
 * state: the sort direction and the number of rows to show are the caller's
 * view choices, passed in rather than stored.
 */

export interface CanvasBarListRowLayout {
  readonly label: string;
  readonly value: number;
  readonly secondaryValue: number | undefined;
  readonly sourceId: string | undefined;
  /** The row's index in the block as declared, for a stable tie-break. */
  readonly index: number;
  /** The bar's length as a fraction of the largest value, 0..1. */
  readonly fraction: number;
  /** The second reading's length, when the block carries one. */
  readonly secondaryFraction: number | undefined;
}

export interface CanvasBarListLayout {
  readonly rows: ReadonlyArray<CanvasBarListRowLayout>;
  /** The sum of every row's value, for a total or a share. */
  readonly total: number;
  /** The largest value, the denominator every bar fraction divides by. */
  readonly max: number;
  /** Rows the limit holds back; 0 when every row is shown. */
  readonly hiddenCount: number;
}

export interface CanvasBarListLayoutOptions {
  /** Largest first by default; `asc` reverses it. */
  readonly direction?: "desc" | "asc";
  /** How many rows to include from the top; the rest are counted as hidden. */
  readonly limit?: number;
}

/**
 * The rows a bar list shows before Show all: a ranking is read at a glance, and
 * eight keeps a "hottest files" list to a screenful without a scroll.
 */
export const BAR_LIST_DEFAULT_VISIBLE_ROWS = 8;

export type CanvasBarListScaleDomain = {
  readonly min: number;
  readonly max: number;
};

/** The range the values span, for colouring a bar through the sequential scale. */
export function barListValueDomain(block: CanvasBarListBlock): CanvasBarListScaleDomain {
  let max = 0;
  for (const row of block.rows) {
    if (row.value > max) max = row.value;
  }
  // The low end is zero: a bar list's lengths are read against none, not
  // against the smallest entry, so the scale starts where a bar starts.
  return { min: 0, max: max > 0 ? max : 1 };
}

function clampUnit(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

export function layoutCanvasBarList(
  block: CanvasBarListBlock,
  options: CanvasBarListLayoutOptions = {},
): CanvasBarListLayout {
  const direction = options.direction ?? "desc";
  const indexed = block.rows.map((row, index) => ({
    label: row.label,
    value: row.value,
    secondaryValue: row.secondaryValue,
    sourceId: row.sourceId === undefined ? undefined : String(row.sourceId),
    index,
  }));
  // Ties keep the author's order, so two rows with the same value never swap
  // between runs and the same input always draws the same list.
  const ordered = [...indexed].sort((left, right) => {
    const difference = left.value - right.value;
    if (difference !== 0) return direction === "desc" ? -difference : difference;
    return left.index - right.index;
  });

  let max = 0;
  let secondaryMax = 0;
  let total = 0;
  for (const row of ordered) {
    if (row.value > max) max = row.value;
    if (row.secondaryValue !== undefined && row.secondaryValue > secondaryMax) {
      secondaryMax = row.secondaryValue;
    }
    total += row.value;
  }

  const limit = options.limit === undefined ? ordered.length : Math.max(0, options.limit);
  const visible = ordered.slice(0, limit);
  const rows: CanvasBarListRowLayout[] = visible.map((row) => ({
    label: row.label,
    value: row.value,
    secondaryValue: row.secondaryValue,
    sourceId: row.sourceId,
    index: row.index,
    fraction: max > 0 ? clampUnit(row.value / max) : 0,
    secondaryFraction:
      row.secondaryValue === undefined
        ? undefined
        : secondaryMax > 0
          ? clampUnit(row.secondaryValue / secondaryMax)
          : 0,
  }));

  return { rows, total, max, hiddenCount: Math.max(0, ordered.length - visible.length) };
}
