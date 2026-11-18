/**
 * Where a drawn ground keeps calm: behind the start screen's content column.
 * Text, cards, chips and the composer all sit in that one column, so the ground
 * is dimmed across its full width and height, with a soft margin, and stays
 * livelier at the edges and in the empty areas beside it.
 */

/**
 * Behind the column a drawn ground keeps a fifth of its strength: the start
 * screen's list of rows sits on it, and at a third its characters ran through
 * the row text.
 */
export const COLUMN_SHARE = 1 / 5;
/**
 * On a light page the ground's dark ink reads louder against small text than
 * light ink on a dark page does, so behind the column it keeps a sixth.
 */
export const LIGHT_PAGE_COLUMN_SHARE = 1 / 6;
/** Past the column's edge the ground is back at full strength after this many pixels. */
export const COLUMN_MARGIN = 140;
/** A page whose column cannot be measured is taken to have one this wide, centred. */
const FALLBACK_COLUMN_WIDTH = 720;

/** The content column's left and right edges, in the ground's own CSS pixels. */
export interface ContentColumn {
  readonly left: number;
  readonly right: number;
}

/** Whether the ink is light, which is how a ground tells a dark page from a pale one. */
export function isDarkPage(ink: readonly [number, number, number]): boolean {
  return 0.2126 * ink[0] + 0.7152 * ink[1] + 0.0722 * ink[2] > 140;
}

/** How much of its strength a ground keeps behind the content column, by the page it sits on. */
export function columnFloor(darkPage: boolean): number {
  return darkPage ? COLUMN_SHARE : LIGHT_PAGE_COLUMN_SHARE;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/**
 * The share of a ground's strength that survives at horizontal position `x`:
 * `floor` inside any column, rising to full over the margin outside them all.
 */
export function columnShare(
  x: number,
  columns: ReadonlyArray<ContentColumn>,
  floor: number = COLUMN_SHARE,
) {
  let share = 1;
  for (const column of columns) {
    const outside = Math.max(column.left - x, x - column.right, 0);
    share = Math.min(share, floor + (1 - floor) * smoothstep(0, COLUMN_MARGIN, outside));
  }
  return share;
}

/** The start screen's content column, which the ground at `canvas` lies behind. */
export function readContentColumns(
  canvas: HTMLElement,
  width: number,
): ReadonlyArray<ContentColumn> {
  const origin = canvas.getBoundingClientRect();
  const stage = canvas.closest(".app-backdrop")?.parentElement;
  const content = stage?.querySelector(".welcome");
  if (content instanceof HTMLElement) {
    const rect = content.getBoundingClientRect();
    if (rect.width > 0) return [{ left: rect.left - origin.left, right: rect.right - origin.left }];
  }
  const half = Math.min(width, FALLBACK_COLUMN_WIDTH) / 2;
  return [{ left: width / 2 - half, right: width / 2 + half }];
}

/**
 * The sidebar, when the ground runs under it: its rows are text, so the ground
 * keeps a fifth of its strength there whatever the scene's own floor is.
 */
export function readSidebarColumns(canvas: HTMLElement): ReadonlyArray<ContentColumn> {
  const origin = canvas.getBoundingClientRect();
  const sidebar = document.querySelector("[data-octant-sidebar]");
  if (!(sidebar instanceof HTMLElement)) return [];
  const rect = sidebar.getBoundingClientRect();
  if (rect.width <= 0 || rect.right <= origin.left || rect.left >= origin.right) return [];
  return [{ left: rect.left - origin.left, right: rect.right - origin.left }];
}
