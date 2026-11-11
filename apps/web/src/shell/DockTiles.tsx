import { X } from "lucide-react";
import {
  Fragment,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { DockToolIcon } from "./dockToolIcons";
import { IconButton } from "./IconButton";
import {
  MIN_DOCK_TILE_SHARE,
  type DockTileColumn,
  type DockTileLayout,
} from "./rightUtilityDockSelection";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/** A tile is never shorter than this while the dock has the room. */
const MIN_TILE_HEIGHT = 140;
/** A column is never narrower than this while the dock has the room. */
const MIN_COLUMN_WIDTH = 240;
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.08;

/** What the surface knows about one shown tool; the tile area draws the frame around it. */
export interface DockTileContent {
  readonly label: string;
  readonly surface: RightUtilityDockSurfaceId;
  readonly children: ReactNode;
  /** Passed through to the tool's own panel: its modifier class and inset marker. */
  readonly bodyClassName: string;
  readonly inset: boolean;
}

export interface DockTilesProps {
  readonly layout: DockTileLayout;
  /** The focused tile's tab. */
  readonly focusedTabId: string | undefined;
  readonly renderTile: (tabId: string) => DockTileContent | undefined;
  readonly onFocusTile: (tabId: string) => void;
  readonly onHideTile: (tabId: string) => void;
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

/**
 * Several open tools drawn together, each one live. Tiles are keyed by their
 * tab, so choosing another tile, resizing or adding a tile never remounts a
 * tool that stays shown: a simulator or a page would lose its session.
 */
export function DockTiles(props: DockTilesProps) {
  const area = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Preview>();
  const [dragging, setDragging] = useState(false);
  const columnShares =
    preview?.kind === "columns" ? preview.shares : props.layout.columns.map((c) => c.share);
  return (
    <div className="dock-tiles" ref={area}>
      <div className="dock-tiles__columns">
        {props.layout.columns.map((column, columnIndex) => (
          <Fragment key={columnIndex}>
            {columnIndex === 0 ? null : (
              <TileDivider
                container={area}
                floorPx={MIN_COLUMN_WIDTH}
                index={columnIndex - 1}
                label="Resize tool columns"
                onCommit={(shares) => {
                  setPreview(undefined);
                  props.onResizeColumns(shares);
                }}
                onDraggingChange={setDragging}
                onPreview={(shares) => setPreview({ kind: "columns", shares })}
                orientation="vertical"
                shares={columnShares}
              />
            )}
            <div
              className="dock-tiles__column"
              data-column={columnIndex}
              style={{ flexGrow: columnShares[columnIndex] ?? column.share }}
            >
              <TileColumn
                {...props}
                column={column}
                columnIndex={columnIndex}
                onDraggingChange={setDragging}
                preview={
                  preview?.kind === "tiles" && preview.column === columnIndex ? preview : undefined
                }
                setPreview={setPreview}
              />
            </div>
          </Fragment>
        ))}
      </div>
      {/* A native page is a window-level view that swallows the pointer over
          it, so a divider dragged across the Browser tile stopped following
          the pointer. This shield is in the renderer's overlay selector, which
          takes the native page out of the window for the length of the drag. */}
      {dragging ? <div aria-hidden="true" className="dock-tiles__drag-shield" /> : null}
    </div>
  );
}

function TileColumn(
  props: DockTilesProps & {
    readonly column: DockTileColumn;
    readonly columnIndex: number;
    readonly preview: Extract<Preview, { kind: "tiles" }> | undefined;
    readonly setPreview: (preview: Preview | undefined) => void;
    readonly onDraggingChange: (dragging: boolean) => void;
  },
) {
  const column = useRef<HTMLDivElement>(null);
  const shares = props.preview?.shares ?? props.column.tiles.map((tile) => tile.share);
  return (
    <div className="dock-tiles__stack" ref={column}>
      {props.column.tiles.map((tile, tileIndex) => {
        const content = props.renderTile(tile.tabId);
        return (
          <Fragment key={tile.tabId}>
            {tileIndex === 0 ? null : (
              <TileDivider
                container={column}
                floorPx={MIN_TILE_HEIGHT}
                index={tileIndex - 1}
                label="Resize tools"
                onCommit={(next) => {
                  props.setPreview(undefined);
                  props.onResizeColumn(props.columnIndex, next);
                }}
                onDraggingChange={props.onDraggingChange}
                onPreview={(next) =>
                  props.setPreview({ kind: "tiles", column: props.columnIndex, shares: next })
                }
                orientation="horizontal"
                shares={shares}
              />
            )}
            {content === undefined ? null : (
              <section
                aria-label={content.label}
                className="dock-tile"
                data-dock-tile={content.surface}
                data-focused={tile.tabId === props.focusedTabId ? "true" : undefined}
                onFocusCapture={() => {
                  if (tile.tabId !== props.focusedTabId) props.onFocusTile(tile.tabId);
                }}
                onPointerDownCapture={() => {
                  if (tile.tabId !== props.focusedTabId) props.onFocusTile(tile.tabId);
                }}
                style={{ flexGrow: shares[tileIndex] ?? tile.share }}
              >
                <div className="dock-tile__caption">
                  <DockToolIcon surface={content.surface} />
                  <span className="dock-tile__name">{content.label}</span>
                  <IconButton
                    className="dock-tile__hide text-muted-foreground"
                    icon={X}
                    label={`Hide ${content.label}`}
                    onClick={() => props.onHideTile(tile.tabId)}
                  />
                </div>
                <div
                  className={content.bodyClassName}
                  data-dock-inset={content.inset ? "true" : undefined}
                >
                  {content.children}
                </div>
              </section>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The line between two neighbours that trade a fixed total of space. Pointer
 * drags are captured, previewed locally and committed once on release, as the
 * dock's own edge is; arrow keys commit a step each.
 */
function TileDivider(props: {
  readonly container: RefObject<HTMLElement | null>;
  readonly floorPx: number;
  /** The divider sits between `index` and `index + 1`. */
  readonly index: number;
  readonly label: string;
  readonly onCommit: (shares: ReadonlyArray<number>) => void;
  readonly onDraggingChange: (dragging: boolean) => void;
  readonly onPreview: (shares: ReadonlyArray<number>) => void;
  readonly orientation: "vertical" | "horizontal";
  readonly shares: ReadonlyArray<number>;
}) {
  const drag = useRef<
    | {
        readonly pointerId: number;
        readonly start: number;
        readonly size: number;
        readonly first: number;
        last?: ReadonlyArray<number>;
      }
    | undefined
  >(undefined);
  const vertical = props.orientation === "vertical";
  const first = props.shares[props.index] ?? 0;
  const second = props.shares[props.index + 1] ?? 0;
  const pair = first + second;

  /** The share the pair may hand to either side: the px floor, but never more than half. */
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

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = props.container.current?.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      start: vertical ? event.clientX : event.clientY,
      size: (vertical ? rect?.width : rect?.height) ?? 0,
      first,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    props.onDraggingChange(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current === undefined || current.pointerId !== event.pointerId || current.size <= 0) return;
    const delta = ((vertical ? event.clientX : event.clientY) - current.start) / current.size;
    const next = resized(current.first + delta * pair, current.size);
    current.last = next;
    props.onPreview(next);
  }

  function finish(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const current = drag.current;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    drag.current = undefined;
    props.onDraggingChange(false);
    if (commit && current.last !== undefined) props.onCommit(current.last);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const grows = vertical ? "ArrowRight" : "ArrowDown";
    const shrinks = vertical ? "ArrowLeft" : "ArrowUp";
    if (event.key !== grows && event.key !== shrinks) return;
    event.preventDefault();
    const step = (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP) * pair;
    const rect = props.container.current?.getBoundingClientRect();
    const size = (vertical ? rect?.width : rect?.height) ?? 0;
    const next = resized(first + (event.key === grows ? step : -step), size);
    if (next[props.index] === first) return;
    props.onCommit(next);
  }

  return (
    <div
      aria-label={props.label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemax={Math.round((pair - MIN_DOCK_TILE_SHARE) * 100)}
      aria-valuemin={Math.round(MIN_DOCK_TILE_SHARE * 100)}
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
      tabIndex={0}
    />
  );
}
