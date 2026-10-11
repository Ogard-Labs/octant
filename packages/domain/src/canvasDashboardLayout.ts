import {
  CANVAS_DASHBOARD_CELL_KINDS,
  CANVAS_DEFAULT_DASHBOARD_COLUMNS,
  type CanvasDashboardCellKind,
} from "@octant/contracts/canvas";

/**
 * How a dashboard reads, once, for every surface that draws one.
 *
 * The screen, the preview SVG, the Markdown and HTML export, and a shared
 * snapshot all draw a dashboard's cells where the dashboard sits and skip the
 * placed blocks at their own positions. The functions read loose shapes so a
 * live definition and a sanitized share document ask the same question.
 */

interface BlockShape {
  readonly kind: string;
  readonly blockId: string;
}

interface DashboardShape extends BlockShape {
  readonly kind: "dashboard";
  readonly title: string;
  readonly columns?: number | undefined;
  readonly cells: ReadonlyArray<{ readonly blockId: string; readonly span?: number | undefined }>;
}

/** One placed block with the columns it takes on a wide grid. */
export interface CanvasDashboardPlacedCell<B> {
  readonly block: B;
  readonly span: number;
}

export type CanvasReadingItem<B> =
  | { readonly kind: "block"; readonly block: B }
  | {
      readonly kind: "dashboard";
      readonly dashboard: B & DashboardShape;
      readonly columns: number;
      readonly cells: ReadonlyArray<CanvasDashboardPlacedCell<B>>;
    };

const CELL_KINDS: ReadonlySet<string> = new Set(CANVAS_DASHBOARD_CELL_KINDS);

/** Whether a kind may be placed in a dashboard cell. */
export function isCanvasDashboardCellKind(kind: string): kind is CanvasDashboardCellKind {
  return CELL_KINDS.has(kind);
}

function isDashboard<B extends BlockShape>(block: B): block is B & DashboardShape {
  return block.kind === "dashboard";
}

/** Columns a dashboard lays out on a wide grid. */
export function canvasDashboardColumns(dashboard: {
  readonly columns?: number | undefined;
}): number {
  return dashboard.columns ?? CANVAS_DEFAULT_DASHBOARD_COLUMNS;
}

/**
 * The columns a cell takes. An author's span wins; otherwise a tile takes one
 * column and a chart or table two, since a chart in a quarter of the row is
 * too narrow to read. Never more than the grid has.
 */
export function canvasDashboardCellSpan(
  kind: string,
  span: number | undefined,
  columns: number,
): number {
  const wanted = span ?? (kind === "chart" || kind === "table" ? 2 : 1);
  return Math.max(1, Math.min(wanted, columns));
}

/**
 * The document in reading order: each dashboard with its placed blocks in
 * cell order, and every other block where it sits. A placed block is drawn
 * only inside its dashboard. A cell naming a block that is missing or not
 * placeable is skipped; the policy refuses such a document, so this only
 * guards a reader of an unvalidated shape.
 */
export function canvasReadingOrder<B extends BlockShape>(
  blocks: ReadonlyArray<B>,
): ReadonlyArray<CanvasReadingItem<B>> {
  const byId = new Map<string, B>();
  for (const block of blocks) byId.set(String(block.blockId), block);
  const placed = new Set<string>();
  for (const block of blocks) {
    if (!isDashboard(block)) continue;
    for (const cell of block.cells) {
      const target = byId.get(String(cell.blockId));
      if (target !== undefined && isCanvasDashboardCellKind(target.kind)) {
        placed.add(String(cell.blockId));
      }
    }
  }

  const items: Array<CanvasReadingItem<B>> = [];
  const drawn = new Set<string>();
  for (const block of blocks) {
    if (placed.has(String(block.blockId))) continue;
    if (!isDashboard(block)) {
      items.push({ kind: "block", block });
      continue;
    }
    const columns = canvasDashboardColumns(block);
    const cells: Array<CanvasDashboardPlacedCell<B>> = [];
    for (const cell of block.cells) {
      const id = String(cell.blockId);
      const target = byId.get(id);
      if (target === undefined || !placed.has(id) || drawn.has(id)) continue;
      drawn.add(id);
      cells.push({ block: target, span: canvasDashboardCellSpan(target.kind, cell.span, columns) });
    }
    items.push({ kind: "dashboard", dashboard: block, columns, cells });
  }
  return items;
}

/** One cell on the packed grid a static picture draws. */
export interface CanvasDashboardGridCell<B> extends CanvasDashboardPlacedCell<B> {
  readonly row: number;
  readonly column: number;
}

/**
 * Pack cells left to right into rows of `columns`, wrapping a cell that does
 * not fit to the next row, the way the screen's grid flows. Never reorders,
 * so a picture reads in the same order as the document.
 */
export function packCanvasDashboardGrid<B>(
  cells: ReadonlyArray<CanvasDashboardPlacedCell<B>>,
  columns: number,
): ReadonlyArray<CanvasDashboardGridCell<B>> {
  const packed: Array<CanvasDashboardGridCell<B>> = [];
  let row = 0;
  let column = 0;
  for (const cell of cells) {
    const span = Math.max(1, Math.min(cell.span, columns));
    if (column + span > columns) {
      row += 1;
      column = 0;
    }
    packed.push({ ...cell, span, row, column });
    column += span;
  }
  return packed;
}
