import {
  CANVAS_DASHBOARD_CELL_KINDS,
  CANVAS_DECK_SLIDE_KINDS,
  CANVAS_DEFAULT_DASHBOARD_COLUMNS,
  type CanvasDashboardCellKind,
} from "@octant/contracts/canvas";

/**
 * How a dashboard, tabs, and columns read, once, for every surface that draws
 * them.
 *
 * The screen, the preview SVG, the Markdown and HTML export, and a shared
 * snapshot all draw a dashboard's cells where the dashboard sits and a tab's
 * or column's children inside it, and skip each placed block at its own
 * position. A pane or column may hold a dashboard, drawn there exactly as at
 * the top level. The functions read loose shapes so a live definition and a
 * sanitized share document ask the same question.
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

interface TabsShape extends BlockShape {
  readonly kind: "tabs";
  readonly panes: ReadonlyArray<{
    readonly label: string;
    readonly blockIds: ReadonlyArray<string>;
  }>;
}

interface ColumnsShape extends BlockShape {
  readonly kind: "columns";
  readonly tracks: ReadonlyArray<{ readonly blockIds: ReadonlyArray<string> }>;
}

/** A flow, as a live definition or a sanitized share carries it. */
interface FlowShape extends BlockShape {
  readonly kind: "flow";
  readonly screens: ReadonlyArray<{ readonly blockId: string }>;
}

/** A deck, as a live definition or a sanitized share carries it. */
interface DeckShape extends BlockShape {
  readonly kind: "deck";
  readonly slides: ReadonlyArray<{ readonly blockId: string }>;
}

/** One placed block with the columns it takes on a wide grid. */
export interface CanvasDashboardPlacedCell<B> {
  readonly block: B;
  readonly span: number;
}

/** A block, or a dashboard with its placed cells, where it reads. */
export type CanvasPlacedReadingItem<B> =
  | { readonly kind: "block"; readonly block: B }
  | {
      readonly kind: "dashboard";
      readonly dashboard: B & DashboardShape;
      readonly columns: number;
      readonly cells: ReadonlyArray<CanvasDashboardPlacedCell<B>>;
    }
  | {
      readonly kind: "flow";
      readonly flow: B & FlowShape;
      readonly screens: ReadonlyArray<B>;
    }
  | {
      readonly kind: "deck";
      readonly deck: B & DeckShape;
      readonly slides: ReadonlyArray<B>;
    };

export type CanvasReadingItem<B> =
  | CanvasPlacedReadingItem<B>
  | {
      readonly kind: "group";
      readonly group: B & (TabsShape | ColumnsShape);
      /** One entry per pane or track, in the group's order. */
      readonly sections: ReadonlyArray<ReadonlyArray<CanvasPlacedReadingItem<B>>>;
    };

const CELL_KINDS: ReadonlySet<string> = new Set(CANVAS_DASHBOARD_CELL_KINDS);

/** Whether a kind may be placed in a dashboard cell. */
export function isCanvasDashboardCellKind(kind: string): kind is CanvasDashboardCellKind {
  return CELL_KINDS.has(kind);
}

function isDashboard<B extends BlockShape>(block: B): block is B & DashboardShape {
  return block.kind === "dashboard";
}

function isFlow<B extends BlockShape>(block: B): block is B & FlowShape {
  return block.kind === "flow";
}

function isDeck<B extends BlockShape>(block: B): block is B & DeckShape {
  return block.kind === "deck";
}

/** Whether a flow may place the block: its screens are mockups and designs. */
export function isCanvasFlowScreenKind(kind: string): boolean {
  return kind === "mockup" || kind === "design";
}

const DECK_SLIDE_KINDS: ReadonlySet<string> = new Set(CANVAS_DECK_SLIDE_KINDS);

/** Whether a deck may show the block. */
export function isCanvasDeckSlideKind(kind: string): boolean {
  return DECK_SLIDE_KINDS.has(kind);
}

function isGroup<B extends BlockShape>(block: B): block is B & (TabsShape | ColumnsShape) {
  return block.kind === "tabs" || block.kind === "columns";
}

function groupSections(group: TabsShape | ColumnsShape): ReadonlyArray<ReadonlyArray<string>> {
  return group.kind === "tabs"
    ? group.panes.map((pane) => pane.blockIds)
    : group.tracks.map((track) => track.blockIds);
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
 * cell order, each tabs or columns block with its children per pane or
 * track, and every other block where it sits. A placed block is drawn only
 * inside the block that places it, and a pane or track may hold a dashboard.
 * A name that is missing, a group inside a group, or a block placed twice is
 * skipped; the policy refuses such a document, so this only guards a reader
 * of an unvalidated shape.
 */
export function canvasReadingOrder<B extends BlockShape>(
  blocks: ReadonlyArray<B>,
): ReadonlyArray<CanvasReadingItem<B>> {
  const byId = new Map<string, B>();
  for (const block of blocks) byId.set(String(block.blockId), block);
  const placedInDashboard = new Set<string>();
  const placedInGroup = new Set<string>();
  const placedInFlow = new Set<string>();
  const placedInDeck = new Set<string>();
  for (const block of blocks) {
    if (isDashboard(block)) {
      for (const cell of block.cells) {
        const target = byId.get(String(cell.blockId));
        if (target !== undefined && isCanvasDashboardCellKind(target.kind)) {
          placedInDashboard.add(String(cell.blockId));
        }
      }
    }
    if (isFlow(block)) {
      for (const screen of block.screens) {
        const target = byId.get(String(screen.blockId));
        if (target !== undefined && isCanvasFlowScreenKind(target.kind)) {
          placedInFlow.add(String(screen.blockId));
        }
      }
    }
    if (isDeck(block)) {
      for (const slide of block.slides) {
        const target = byId.get(String(slide.blockId));
        if (target !== undefined && isCanvasDeckSlideKind(target.kind)) {
          placedInDeck.add(String(slide.blockId));
        }
      }
    }
    if (isGroup(block)) {
      for (const childId of groupSections(block).flat()) {
        const target = byId.get(String(childId));
        if (target !== undefined && !isGroup(target)) placedInGroup.add(String(childId));
      }
    }
  }

  const drawn = new Set<string>();
  const placedItem = (block: B): CanvasPlacedReadingItem<B> => {
    drawn.add(String(block.blockId));
    if (!isDashboard(block) && !isFlow(block) && !isDeck(block)) return { kind: "block", block };
    if (isDeck(block)) {
      const slides: Array<B> = [];
      for (const slide of block.slides) {
        const id = String(slide.blockId);
        const target = byId.get(id);
        if (target === undefined || !placedInDeck.has(id) || drawn.has(id)) continue;
        drawn.add(id);
        slides.push(target);
      }
      return { kind: "deck", deck: block, slides };
    }
    if (isFlow(block)) {
      const screens: Array<B> = [];
      for (const screen of block.screens) {
        const id = String(screen.blockId);
        const target = byId.get(id);
        if (target === undefined || !placedInFlow.has(id) || drawn.has(id)) continue;
        drawn.add(id);
        screens.push(target);
      }
      return { kind: "flow", flow: block, screens };
    }
    const columns = canvasDashboardColumns(block);
    const cells: Array<CanvasDashboardPlacedCell<B>> = [];
    for (const cell of block.cells) {
      const id = String(cell.blockId);
      const target = byId.get(id);
      if (target === undefined || !placedInDashboard.has(id) || drawn.has(id)) continue;
      drawn.add(id);
      cells.push({ block: target, span: canvasDashboardCellSpan(target.kind, cell.span, columns) });
    }
    return { kind: "dashboard", dashboard: block, columns, cells };
  };

  const items: Array<CanvasReadingItem<B>> = [];
  for (const block of blocks) {
    const id = String(block.blockId);
    if (
      placedInDashboard.has(id) ||
      placedInGroup.has(id) ||
      placedInFlow.has(id) ||
      placedInDeck.has(id)
    )
      continue;
    if (!isGroup(block)) {
      items.push(placedItem(block));
      continue;
    }
    const sections = groupSections(block).map((childIds) => {
      const section: Array<CanvasPlacedReadingItem<B>> = [];
      for (const childId of childIds) {
        const child = byId.get(String(childId));
        if (child === undefined || !placedInGroup.has(String(childId))) continue;
        if (
          placedInDashboard.has(String(childId)) ||
          placedInFlow.has(String(childId)) ||
          drawn.has(String(childId))
        )
          continue;
        section.push(placedItem(child));
      }
      return section;
    });
    items.push({ kind: "group", group: block, sections });
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

// The grid's width tiers and spacing, in CSS pixels, as the web stylesheet
// draws them (36rem and 52rem at the 16px root, a 12px gap, and a cell's 12px
// padding and 1px ring on each side). A measure that must agree with the
// screen, such as a preview warning, reads them from here.
const DASHBOARD_ONE_COLUMN_BELOW_PX = 576;
const DASHBOARD_TWO_COLUMNS_BELOW_PX = 832;
const DASHBOARD_GAP_PX = 12;
const DASHBOARD_CELL_FRAME_PX = 26;

/**
 * The width a placed block is drawn at inside a dashboard `gridWidth` wide:
 * the columns the grid shows at that width, the cell's span within them, and
 * the cell's own frame. A metric draws its own tile, so it loses no frame.
 */
export function canvasDashboardCellWidth(input: {
  readonly gridWidth: number;
  readonly columns: number;
  readonly span: number;
  readonly kind: string;
}): number {
  const shown =
    input.gridWidth < DASHBOARD_ONE_COLUMN_BELOW_PX
      ? 1
      : input.gridWidth < DASHBOARD_TWO_COLUMNS_BELOW_PX
        ? Math.min(2, input.columns)
        : input.columns;
  const span = Math.max(1, Math.min(input.span, shown));
  const track = (input.gridWidth - DASHBOARD_GAP_PX * (shown - 1)) / shown;
  const cell = track * span + DASHBOARD_GAP_PX * (span - 1);
  return Math.max(0, cell - (input.kind === "metric" ? 0 : DASHBOARD_CELL_FRAME_PX));
}
