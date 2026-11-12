import { LayoutPanelLeft, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { signalNativeSurfaceLayoutChange } from "../browser/useNativeBrowserSurface";
import { IconButton } from "./IconButton";
import {
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import {
  MIN_DOCK_TILE_SHARE,
  type DockTileLayout,
  type DockTileMove,
} from "./rightUtilityDockSelection";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/** A tile is never shorter than this while the dock has the room. */
const MIN_TILE_HEIGHT = 140;
/**
 * A column is never narrower than this while the dock has the room. The dock's
 * own minimum is 280px, and tools are built for that: Review's header
 * overlapped and its History tab clipped at 243px.
 */
const MIN_COLUMN_WIDTH = 280;
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.08;

/** What the surface knows about one shown tool; the tile area draws the frame around it. */
export interface DockTileContent {
  /** Stable while the tool stays in this tile, so a page change inside it remounts nothing. */
  readonly key: string;
  readonly label: string;
  readonly surface: RightUtilityDockSurfaceId;
  /**
   * What the tile's one bar shows at its leading edge: the tool's icon and
   * name, or for the Browser its row of pages. The tool is named here once.
   */
  readonly barLeading: ReactNode;
  /** Which moves the caps and edges allow from here. */
  readonly moves: Readonly<Record<DockTileMove, boolean>>;
  readonly children: ReactNode;
  /** The tool's own panel: its class names and inset marker. */
  readonly bodyClassName: string;
  readonly inset: boolean;
  /** The tool can stand as a card on the shelf, so its caption offers to minimise it. */
  readonly minimisable?: boolean;
}

export interface DockTilesProps {
  /** One tile is the single-tool view: no caption, no dividers, the same element tree. */
  readonly layout: DockTileLayout;
  /** The focused tile's tab. */
  readonly focusedTabId: string | undefined;
  /** Receives focus when a tool opens in place of a tile's. */
  readonly panelRef?: Ref<HTMLElement>;
  readonly renderTile: (tabId: string) => DockTileContent | undefined;
  readonly onFocusTile: (tabId: string) => void;
  readonly onHideTile: (tabId: string) => void;
  readonly onMinimiseTile?: (tabId: string) => void;
  /** Closes the tool, as its button's Close does. */
  readonly onCloseTile: (tabId: string) => void;
  readonly onMoveTile: (tabId: string, direction: DockTileMove) => void;
  readonly onShowTileAlone: (tabId: string) => void;
  readonly onResizeColumns: (shares: ReadonlyArray<number>) => void;
  readonly onResizeColumn: (columnIndex: number, shares: ReadonlyArray<number>) => void;
}

type Preview =
  | { readonly kind: "columns"; readonly shares: ReadonlyArray<number> }
  | {
      readonly kind: "tiles";
      readonly column: number;
      readonly shares: ReadonlyArray<number>;
    };

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Pulls every share up to the floor and takes the difference from the larger
 * ones, so a tile that was added, or a column that stacked, never ends under
 * its floor while the span can hold them all. When it cannot, the caller
 * grows the span instead and every share sits at the floor.
 */
function applyFloor(shares: ReadonlyArray<number>, floor: number): ReadonlyArray<number> {
  const count = shares.length;
  if (count < 2 || floor <= 0) return shares;
  if (floor * count >= 1) return shares.map(() => 1 / count);
  const result = [...shares];
  const pinned = new Set<number>();
  // Pinning one share to the floor shrinks what the rest may take, which can
  // push another under it, so the pass repeats until none moves.
  for (let pass = 0; pass <= count; pass += 1) {
    const free = result.flatMap((_, index) => (pinned.has(index) ? [] : [index]));
    const freeTotal = free.reduce((sum, index) => sum + (shares[index] ?? 0), 0);
    const room = 1 - floor * pinned.size;
    const under = free.filter((index) => ((shares[index] ?? 0) / freeTotal) * room < floor);
    if (under.length === 0) {
      for (const index of free) result[index] = ((shares[index] ?? 0) / freeTotal) * room;
      break;
    }
    for (const index of under) {
      pinned.add(index);
      result[index] = floor;
    }
  }
  return result;
}

/**
 * Where every tile and divider sits, as fractions of the surface. Tiles are
 * positioned rather than nested in columns, so they are all children of one
 * element: a tool that moves between columns, or whose neighbour leaves, keeps
 * its place in the React tree and is never remounted. The floors apply here,
 * wherever the shares came from.
 */
function arrange(
  layout: DockTileLayout,
  preview: Preview | undefined,
  stacked: boolean,
  size: { readonly width: number; readonly height: number },
) {
  const columns = layout.columns;
  const rawColumns = columns.map((column, index) =>
    preview?.kind === "columns" ? (preview.shares[index] ?? column.share) : column.share,
  );
  const rawTiles = columns.map((column, columnIndex) =>
    column.tiles.map((tile, tileIndex) =>
      preview?.kind === "tiles" && preview.column === columnIndex
        ? (preview.shares[tileIndex] ?? tile.share)
        : tile.share,
    ),
  );
  const tileCount = columns.reduce((sum, column) => sum + column.tiles.length, 0);
  const tallest = Math.max(...columns.map((column) => column.tiles.length));
  const required = size.height <= 0 ? 0 : (stacked ? tileCount : tallest) * MIN_TILE_HEIGHT;
  // The surface grows past the visible area, and scrolls, when the tiles
  // cannot all have their floor inside it.
  const total = Math.max(size.height, required);
  let columnShares: ReadonlyArray<number> = rawColumns;
  let tileShares: ReadonlyArray<ReadonlyArray<number>> = rawTiles;
  if (!stacked) {
    if (size.width > 0) columnShares = applyFloor(rawColumns, MIN_COLUMN_WIDTH / size.width);
    if (total > 0)
      tileShares = rawTiles.map((shares) => applyFloor(shares, MIN_TILE_HEIGHT / total));
  } else if (total > 0) {
    // Stacked, every tile runs down one axis, so the floor applies to them all.
    const flat = applyFloor(
      rawTiles.flatMap((shares, columnIndex) =>
        shares.map((share) => (rawColumns[columnIndex] ?? 0) * share),
      ),
      MIN_TILE_HEIGHT / total,
    );
    let at = 0;
    const columnSums: number[] = [];
    const tileRows: ReadonlyArray<number>[] = [];
    for (const shares of rawTiles) {
      const part = flat.slice(at, at + shares.length);
      at += shares.length;
      const sum = part.reduce((acc, value) => acc + value, 0);
      columnSums.push(sum);
      tileRows.push(part.map((value) => value / sum));
    }
    columnShares = columnSums;
    tileShares = tileRows;
  }
  const tiles: { tabId: string; box: Box }[] = [];
  const columnDividers: { index: number; at: number }[] = [];
  const tileDividers: { column: number; index: number; box: Box }[] = [];
  let columnStart = 0;
  columns.forEach((column, columnIndex) => {
    const share = columnShares[columnIndex] ?? column.share;
    const span: Box = stacked
      ? { left: 0, top: columnStart, width: 1, height: share }
      : { left: columnStart, top: 0, width: share, height: 1 };
    let tileStart = 0;
    column.tiles.forEach((tile, tileIndex) => {
      const tileShare = tileShares[columnIndex]?.[tileIndex] ?? tile.share;
      const box: Box = {
        left: span.left,
        top: span.top + tileStart * span.height,
        width: span.width,
        height: tileShare * span.height,
      };
      tiles.push({ tabId: tile.tabId, box });
      if (tileIndex > 0) tileDividers.push({ column: columnIndex, index: tileIndex - 1, box });
      tileStart += tileShare;
    });
    columnStart += share;
    if (columnIndex < columns.length - 1)
      columnDividers.push({ index: columnIndex, at: columnStart });
  });
  return {
    tiles,
    columnDividers,
    tileDividers,
    columnShares,
    tileShares,
    total,
    scrollHeight: required > size.height ? required : undefined,
  };
}

const percent = (fraction: number) => `${fraction * 100}%`;

/**
 * The width of a divider's hit area, centred on the edge between two tiles. In
 * a narrow window a tile is a panel and each edge it shares with a neighbour
 * is pulled in by half a gap (`--octant-tile-inset`, set in dock.css), so the
 * pair end up a gap apart; from 681px up the inset is 0 and tiles share the
 * edge. An edge on the dock's own boundary never moves.
 */
const DIVIDER_HIT = 8;
const EDGE = 1e-4;
const INSET = "var(--octant-tile-inset, 0px)";
const along = (start: number, size: number) => {
  const before = start > EDGE;
  const after = start + size < 1 - EDGE;
  return {
    start: before ? `calc(${percent(start)} + ${INSET})` : `calc(${percent(start)} + 0px)`,
    size:
      before && after
        ? `calc(${percent(size)} - 2 * ${INSET})`
        : before || after
          ? `calc(${percent(size)} - ${INSET})`
          : `calc(${percent(size)} - 0px)`,
  };
};

/**
 * Open tools drawn together, each one live. Tiles are keyed by their tool, so
 * choosing another tile, resizing, adding or removing a neighbour never
 * remounts a tool that stays shown: a simulator or a page would lose its
 * session.
 */
export function DockTiles(props: DockTilesProps) {
  const area = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Preview>();
  const [dragging, setDragging] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const columnCount = props.layout.columns.length;
  const shape = props.layout.columns
    .map((column) => column.tiles.map((tile) => tile.tabId).join("+"))
    .join("|");
  const tileCount = props.layout.columns.reduce((sum, column) => sum + column.tiles.length, 0);

  // Two columns that cannot each have their floor stack instead of shrinking
  // under it. Measured rather than a container query so the dividers and the
  // drag arithmetic know which way the columns run.
  useLayoutEffect(() => {
    const node = area.current;
    if (node === null) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
      const width = node.clientWidth;
      setStacked(columnCount > 1 && width > 0 && width < MIN_COLUMN_WIDTH * columnCount);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [columnCount]);

  // A drag whose divider has gone, or whose tiles changed under it, must not
  // leave the shield up (the native page stays out of the window) or a preview
  // drawn that no commit will ever replace.
  useEffect(() => {
    setDragging(false);
    setPreview(undefined);
  }, [shape]);

  const placed = arrange(props.layout, preview, stacked, size);
  const labelOf = (tabId: string | undefined) =>
    (tabId === undefined ? undefined : props.renderTile(tabId)?.label) ?? "tool";

  // A native page is placed by its element's rectangle, which no observer sees
  // change when a tile keeps its size and only moves.
  const boxKey = `${stacked}|${placed.scrollHeight ?? ""}|${placed.tiles
    .map(({ box }) => [box.left, box.top, box.width, box.height].map((n) => n.toFixed(4)).join(","))
    .join(";")}`;
  useLayoutEffect(() => {
    signalNativeSurfaceLayoutChange();
  }, [boxKey]);

  return (
    <div
      className="dock-tiles"
      data-stacked={stacked ? "true" : undefined}
      onScroll={signalNativeSurfaceLayoutChange}
      ref={area}
    >
      <div
        className="dock-tiles__surface"
        style={placed.scrollHeight === undefined ? undefined : { height: placed.scrollHeight }}
      >
        {placed.tiles.map(({ tabId, box }) => {
          const content = props.renderTile(tabId);
          if (content === undefined) return null;
          return (
            <Tile
              box={box}
              content={content}
              focused={tabId === props.focusedTabId}
              key={`tile:${content.key}`}
              onFocusTile={() => {
                if (tabId !== props.focusedTabId) props.onFocusTile(tabId);
              }}
              onClose={() => props.onCloseTile(tabId)}
              onHide={() => props.onHideTile(tabId)}
              {...(props.onMinimiseTile === undefined || content.minimisable !== true
                ? {}
                : { onMinimise: () => props.onMinimiseTile?.(tabId) })}
              onMove={(direction) => props.onMoveTile(tabId, direction)}
              onShowAlone={() => props.onShowTileAlone(tabId)}
              panelRef={tabId === props.focusedTabId ? props.panelRef : undefined}
              single={tileCount === 1}
            />
          );
        })}
        {placed.columnDividers.map(({ index, at }) => (
          <TileDivider
            at={at}
            floorPx={
              stacked
                ? MIN_TILE_HEIGHT *
                  Math.max(
                    props.layout.columns[index]?.tiles.length ?? 1,
                    props.layout.columns[index + 1]?.tiles.length ?? 1,
                  )
                : MIN_COLUMN_WIDTH
            }
            index={index}
            key={`columns:${index}`}
            label={`Resize ${labelOf(props.layout.columns[index]?.tiles[0]?.tabId)} and ${labelOf(
              props.layout.columns[index + 1]?.tiles[0]?.tabId,
            )}`}
            onCancel={() => setPreview(undefined)}
            onCommit={(shares) => {
              setPreview(undefined);
              props.onResizeColumns(shares);
            }}
            onDraggingChange={setDragging}
            onPreview={(shares) => setPreview({ kind: "columns", shares })}
            orientation={stacked ? "horizontal" : "vertical"}
            shares={placed.columnShares}
            sizeOf={() => (stacked ? placed.total : size.width)}
          />
        ))}
        {placed.tileDividers.map(({ column, index, box }) => {
          const tiles = props.layout.columns[column]?.tiles ?? [];
          return (
            <TileDivider
              at={box.top}
              extent={{ left: box.left, width: box.width }}
              floorPx={MIN_TILE_HEIGHT}
              index={index}
              key={`tiles:${column}:${tiles[index]?.tabId ?? index}`}
              label={`Resize ${labelOf(tiles[index]?.tabId)} and ${labelOf(tiles[index + 1]?.tabId)}`}
              onCancel={() => setPreview(undefined)}
              onCommit={(next) => {
                setPreview(undefined);
                props.onResizeColumn(column, next);
              }}
              onDraggingChange={setDragging}
              onPreview={(next) => setPreview({ kind: "tiles", column, shares: next })}
              orientation="horizontal"
              shares={placed.tileShares[column] ?? []}
              sizeOf={() => placed.total * (stacked ? (placed.columnShares[column] ?? 1) : 1)}
            />
          );
        })}
        {/* A native page is a window-level view that swallows the pointer over
            it, so a divider dragged across the Browser tile stopped following
            the pointer. This shield is in the renderer's overlay selector, which
            takes the native page out of the window for the length of the drag. */}
        {dragging ? <div aria-hidden="true" className="dock-tiles__drag-shield" /> : null}
      </div>
    </div>
  );
}

function Tile(props: {
  readonly box: Box;
  readonly content: DockTileContent;
  readonly focused: boolean;
  readonly onClose: () => void;
  readonly onFocusTile: () => void;
  readonly onHide: () => void;
  readonly onMinimise?: () => void;
  readonly onMove: (direction: DockTileMove) => void;
  readonly onShowAlone: () => void;
  readonly panelRef: Ref<HTMLElement> | undefined;
  readonly single: boolean;
}) {
  const element = useRef<HTMLElement | null>(null);
  const onFocusTile = useRef(props.onFocusTile);
  onFocusTile.current = props.onFocusTile;
  // Native listeners: a tool can portal part of its panel into its tile, and
  // React's synthetic events from a portal bubble through the React tree (the
  // thread pane that rendered it), never through the tile. The DOM sees both.
  useEffect(() => {
    const node = element.current;
    if (node === null) return;
    const focus = () => onFocusTile.current();
    node.addEventListener("pointerdown", focus, true);
    node.addEventListener("focusin", focus, true);
    return () => {
      node.removeEventListener("pointerdown", focus, true);
      node.removeEventListener("focusin", focus, true);
    };
  }, []);
  const { content, box } = props;
  const across = along(box.left, box.width);
  const down = along(box.top, box.height);
  const style: CSSProperties = {
    left: across.start,
    top: down.start,
    width: across.size,
    height: down.size,
  };
  return (
    <section
      aria-label={content.label}
      className="dock-tile"
      data-dock-tile={content.surface}
      data-focused={props.focused ? "true" : undefined}
      ref={(node) => {
        element.current = node;
        const forward = props.panelRef;
        if (typeof forward === "function") forward(node);
        else if (forward !== undefined && forward !== null) forward.current = node;
      }}
      style={style}
      tabIndex={-1}
    >
      {props.single ? null : (
        // One bar per tile, the tool's own header: its name (or the Browser's
        // pages) leads, the tile's controls trail, and every bar is one height
        // so neighbouring tiles line up.
        <div className="dock-tile__bar">
          <div className="dock-tile__lead">{content.barLeading}</div>
          <OctantMenuRoot>
            <OctantMenuTrigger
              aria-label={`Arrange ${content.label}`}
              className="shell-icon-button dock-tile__control window-no-drag"
              title={`Arrange ${content.label}`}
            >
              <LayoutPanelLeft aria-hidden="true" size={14} />
            </OctantMenuTrigger>
            <OctantMenuPortal>
              <OctantMenuPositioner>
                <OctantMenuPopup aria-label={`Arrange ${content.label}`}>
                  {(
                    [
                      ["left", "Move left"],
                      ["right", "Move right"],
                      ["up", "Move up"],
                      ["down", "Move down"],
                    ] as const
                  ).map(([direction, label]) =>
                    content.moves[direction] ? (
                      <OctantMenuItem
                        className="workspace-disclosure__action window-no-drag"
                        key={direction}
                        onClick={() => props.onMove(direction)}
                      >
                        <span>{label}</span>
                      </OctantMenuItem>
                    ) : null,
                  )}
                  <OctantMenuSeparator />
                  <OctantMenuItem
                    className="workspace-disclosure__action window-no-drag"
                    onClick={props.onShowAlone}
                  >
                    <span>Show alone</span>
                  </OctantMenuItem>
                  <OctantMenuItem
                    className="workspace-disclosure__action window-no-drag"
                    onClick={props.onHide}
                  >
                    <span>Hide from view</span>
                  </OctantMenuItem>
                  {props.onMinimise === undefined ? null : (
                    <OctantMenuItem
                      className="workspace-disclosure__action window-no-drag"
                      onClick={props.onMinimise}
                    >
                      <span>Minimise to card</span>
                    </OctantMenuItem>
                  )}
                </OctantMenuPopup>
              </OctantMenuPositioner>
            </OctantMenuPortal>
          </OctantMenuRoot>
          <IconButton
            className="dock-tile__control text-muted-foreground"
            icon={X}
            label={`Close ${content.label}`}
            onClick={props.onClose}
          />
        </div>
      )}
      <div className={content.bodyClassName} data-dock-inset={content.inset ? "true" : undefined}>
        {content.children}
      </div>
    </section>
  );
}

/**
 * The line between two neighbours that trade a fixed total of space. Pointer
 * drags are captured, previewed locally and committed once on release, as the
 * dock's own edge is; arrow keys commit a step each, Home and End go to the
 * ends of the range the floors allow.
 */
function TileDivider(props: {
  /** The fraction of the area, across the divider's axis, that the line sits at. */
  readonly at: number;
  /** For a line between stacked tiles: where it starts and how far it runs across. */
  readonly extent?: { readonly left: number; readonly width: number };
  readonly floorPx: number;
  /** The divider sits between `index` and `index + 1`. */
  readonly index: number;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onCommit: (shares: ReadonlyArray<number>) => void;
  readonly onDraggingChange: (dragging: boolean) => void;
  readonly onPreview: (shares: ReadonlyArray<number>) => void;
  readonly orientation: "vertical" | "horizontal";
  readonly shares: ReadonlyArray<number>;
  /** The pixel size of the span the shares divide. */
  readonly sizeOf: () => number;
}) {
  const drag = useRef<
    | {
        readonly pointerId: number;
        readonly start: number;
        readonly size: number;
        readonly first: number;
        readonly target: HTMLElement;
        last?: ReadonlyArray<number>;
      }
    | undefined
  >(undefined);
  const latest = useRef(props);
  latest.current = props;
  // Escape abandons a drag in progress: the previewed sizes go, the stored ones
  // stay, and releasing the pointer afterwards commits nothing.
  const escape = useRef((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || drag.current === undefined) return;
    event.preventDefault();
    const current = drag.current;
    drag.current = undefined;
    window.removeEventListener("keydown", escape.current);
    try {
      current.target.releasePointerCapture?.(current.pointerId);
    } catch {
      // The pointer was already released.
    }
    latest.current.onDraggingChange(false);
    latest.current.onCancel();
  });
  useEffect(
    () => () => {
      window.removeEventListener("keydown", escape.current);
      if (drag.current === undefined) return;
      drag.current = undefined;
      latest.current.onDraggingChange(false);
      latest.current.onCancel();
    },
    [],
  );
  const vertical = props.orientation === "vertical";
  const first = props.shares[props.index] ?? 0;
  const second = props.shares[props.index + 1] ?? 0;
  const pair = first + second;

  /** The share the pair may hand to either side: the px floor, never more than half. */
  function floorShare(size: number): number {
    const fromPixels = size > 0 ? props.floorPx / size : MIN_DOCK_TILE_SHARE;
    return Math.min(Math.max(fromPixels, MIN_DOCK_TILE_SHARE), pair / 2);
  }

  function resized(nextFirst: number, size: number): ReadonlyArray<number> {
    const floor = floorShare(size);
    const clamped = Math.min(pair - floor, Math.max(floor, nextFirst));
    return props.shares.map((share, index) =>
      index === props.index ? clamped : index === props.index + 1 ? pair - clamped : share,
    );
  }

  // The range the separator reports is the range it can reach.
  const floor = floorShare(props.sizeOf());

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      start: vertical ? event.clientX : event.clientY,
      size: props.sizeOf(),
      first,
      target: event.currentTarget,
    };
    window.addEventListener("keydown", escape.current);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    props.onDraggingChange(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current === undefined || current.pointerId !== event.pointerId || current.size <= 0) return;
    // `size` is the whole column (or the whole row of columns), so the pointer's
    // travel over it is already a share of the whole. Scaled by the pair again,
    // a divider in a column of three moved 60px under a 90px drag.
    const delta = ((vertical ? event.clientX : event.clientY) - current.start) / current.size;
    const next = resized(current.first + delta, current.size);
    current.last = next;
    props.onPreview(next);
  }

  function finish(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const current = drag.current;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    drag.current = undefined;
    window.removeEventListener("keydown", escape.current);
    props.onDraggingChange(false);
    if (commit && current.last !== undefined) props.onCommit(current.last);
    else props.onCancel();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const grows = vertical ? "ArrowRight" : "ArrowDown";
    const shrinks = vertical ? "ArrowLeft" : "ArrowUp";
    let target: number;
    if (event.key === "Home") target = 0;
    else if (event.key === "End") target = pair;
    else if (event.key === grows || event.key === shrinks) {
      const step = (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP) * pair;
      target = first + (event.key === grows ? step : -step);
    } else return;
    event.preventDefault();
    const next = resized(target, props.sizeOf());
    if (next[props.index] === first) return;
    props.onCommit(next);
  }

  const style: CSSProperties = vertical
    ? {
        left: `calc(${percent(props.at)} - ${DIVIDER_HIT / 2}px)`,
        top: 0,
        height: "100%",
        width: DIVIDER_HIT,
      }
    : {
        left: percent(props.extent?.left ?? 0),
        top: `calc(${percent(props.at)} - ${DIVIDER_HIT / 2}px)`,
        width: percent(props.extent?.width ?? 1),
        height: DIVIDER_HIT,
      };
  return (
    <div
      aria-label={props.label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemax={Math.round((pair - floor) * 100)}
      aria-valuemin={Math.round(floor * 100)}
      aria-valuenow={Math.round(first * 100)}
      aria-valuetext={`${Math.round(first * 100)} percent`}
      className="dock-tiles__divider"
      data-orientation={props.orientation}
      onKeyDown={onKeyDown}
      onLostPointerCapture={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      role="separator"
      style={style}
      tabIndex={0}
    />
  );
}
