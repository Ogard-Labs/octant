/**
 * The Zen wall: where cards sit when a space arranges itself.
 *
 * A focus zone is read, not decorated. Free placement made every pin land on a
 * stored coordinate, so cards stacked on each other, removing one left a hole,
 * and a window resize left the arrangement behind. The wall derives geometry
 * from the card count and the area it has, so those three cannot happen. A
 * space that wants a hand-made arrangement switches to `arrange` and keeps its
 * stored geometry; nothing here is persisted (0106).
 */
import {
  MIN_ZEN_ELEMENT_HEIGHT,
  MIN_ZEN_ELEMENT_WIDTH,
  type ZenGeometry,
} from "@octant/contracts/zen";

export interface ZenWallArea {
  readonly width: number;
  readonly height: number;
}

export interface ZenWallOptions {
  /** Space between two tiles, and between a tile and the area's edge. */
  readonly gap?: number;
  /**
   * Room the wall leaves at the top and bottom for the surface's own floating
   * chrome. A wall fills the area it is given, so without this the spaces pill
   * and the Navigator bar sit on top of the first and last rows.
   */
  readonly insetTop?: number;
  readonly insetBottom?: number;
  /**
   * The narrowest a card may be before the wall spends a column instead. A
   * thread card is a reading, and a reading needs a measure; three columns on
   * a laptop would leave each one too narrow to read a reply in.
   */
  readonly minTileWidth?: number;
}

const DEFAULT_GAP = 16;
const DEFAULT_MIN_TILE_WIDTH = 420;

/**
 * Columns the wall would use given room for all of them. Past nine cards the
 * count stops driving the shape: a space holds at most twenty, and a fifth
 * column is narrower than a card can be read at on any window we ship for.
 */
function preferredColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

/**
 * Lay `count` cards over `area`, in order. Row heights are uniform; a short
 * last row spreads its cards across the full width rather than leaving one
 * card beside dead space.
 */
export function planZenWall(
  count: number,
  area: ZenWallArea,
  options: ZenWallOptions = {},
): ReadonlyArray<ZenGeometry> {
  if (count <= 0) return [];
  const gap = options.gap ?? DEFAULT_GAP;
  const minTileWidth = options.minTileWidth ?? DEFAULT_MIN_TILE_WIDTH;
  const insetTop = options.insetTop ?? 0;
  const insetBottom = options.insetBottom ?? 0;

  const innerWidth = Math.max(0, area.width - gap * 2);
  const innerHeight = Math.max(0, area.height - gap * 2 - insetTop - insetBottom);

  const fitting = Math.floor((innerWidth + gap) / (minTileWidth + gap));
  const columns = Math.max(1, Math.min(preferredColumns(count), Math.max(1, fitting)));
  const rows = Math.ceil(count / columns);
  const rowHeight = Math.max(
    MIN_ZEN_ELEMENT_HEIGHT,
    (innerHeight - gap * (rows - 1)) / Math.max(1, rows),
  );

  const tiles: ZenGeometry[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    // The last row carries whatever is left, and shares the width between
    // exactly those cards.
    const inThisRow = Math.min(columns, count - row * columns);
    const tileWidth = Math.max(
      MIN_ZEN_ELEMENT_WIDTH,
      (innerWidth - gap * (inThisRow - 1)) / inThisRow,
    );
    tiles.push({
      x: Math.round(gap + column * (tileWidth + gap)),
      y: Math.round(gap + insetTop + row * (rowHeight + gap)),
      width: Math.round(tileWidth),
      height: Math.round(rowHeight),
    });
  }
  return tiles;
}
