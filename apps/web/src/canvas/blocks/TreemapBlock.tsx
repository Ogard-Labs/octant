import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type {
  CanvasTreemapBlock,
  CanvasTreemapNode,
  CanvasTreemapScale,
} from "@octant/contracts/canvas";
import type { CanvasActionBlock } from "@octant/contracts/canvas-actions";
import {
  CHART_DIVERGING_STEPS,
  CHART_SEQUENTIAL_STEPS,
  chartScaleRoleId,
  chartScaleStep,
} from "@octant/theme";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { ChartTooltip, type ChartTooltipAnchor } from "../ChartTooltip";
import { formatCanvasValue } from "../canvasRuntime";
import type { CanvasActionRuntime } from "../canvasActionRuntime";
import { openSourceActionBlock } from "../canvasActionRuntime";
import {
  layoutCanvasTreemap,
  treemapChildren,
  treemapLeafReading,
  treemapMeasureDomain,
  treemapParentOf,
  treemapPath,
  treemapRootId,
  treemapTotals,
  type CanvasTreemapRect,
} from "@octant/domain/canvas-treemap-layout";

const PLOT_WIDTH = 320;
const PLOT_HEIGHT = 200;
const LABEL_MIN_WIDTH = 34;
const LABEL_MIN_HEIGHT = 14;
const GROUP_HEADER_MIN_WIDTH = 20;
const GROUP_HEADER_MIN_HEIGHT = 12;

type SortDirection = "asc" | "desc";

interface TreemapSort {
  readonly measureId: string;
  readonly direction: SortDirection;
}

/**
 * A hierarchy sized and coloured by numbers.
 *
 * The block supplies the readings; a reader sizes by one measure, colours by
 * another, and zooms into a group. Size, colour, and zoom are view state only:
 * they are never journaled and never revise the Canvas. Labels are drawn only
 * where they fit, and the disclosed table is the accessible reading of the same
 * data.
 */
export function TreemapBlock({
  block,
  actionRuntime,
}: {
  readonly block: CanvasTreemapBlock;
  readonly actionRuntime?: CanvasActionRuntime | undefined;
}) {
  const rootId = useMemo(() => treemapRootId(block), [block]);
  const parentOf = useMemo(() => treemapParentOf(block), [block]);
  const childrenOf = useMemo(() => treemapChildren(block), [block]);
  const [sizeBy, setSizeBy] = useState(() => String(block.sizeBy));
  const [colorBy, setColorBy] = useState(() => String(block.colorBy));
  const [focusId, setFocusId] = useState(() => startingFocus(block, rootId));
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [anchor, setAnchor] = useState<ChartTooltipAnchor | undefined>(undefined);
  const [sort, setSort] = useState<TreemapSort | undefined>(undefined);

  const layout = useMemo(
    () =>
      layoutCanvasTreemap(block, {
        width: PLOT_WIDTH,
        height: PLOT_HEIGHT,
        measureId: sizeBy,
        rootId: focusId,
      }),
    [block, sizeBy, focusId],
  );
  const colorDomain = useMemo(() => treemapMeasureDomain(block, colorBy), [block, colorBy]);
  const totalsByMeasure = useMemo(
    () =>
      new Map<string, ReadonlyMap<string, number>>(
        block.measures.map((measure): [string, ReadonlyMap<string, number>] => [
          String(measure.measureId),
          treemapTotals(block, String(measure.measureId)),
        ]),
      ),
    [block],
  );

  const scale: CanvasTreemapScale = block.colorScale ?? "categorical";
  const topGroups = useMemo(() => childrenOf.get(rootId) ?? [], [childrenOf, rootId]);
  const topGroupOf = useMemo(() => {
    const resolve = (nodeId: string): string => {
      let current = nodeId;
      for (;;) {
        const parent = parentOf.get(current);
        if (parent === undefined || parent === rootId) return current;
        current = parent;
      }
    };
    return resolve;
  }, [parentOf, rootId]);

  const fillFor = (rect: CanvasTreemapRect): string => {
    if (scale === "categorical") {
      const groupIndex = Math.max(0, topGroups.indexOf(topGroupOf(rect.nodeId)));
      return `var(--oct-series-${String((groupIndex % 6) + 1)})`;
    }
    const value = treemapLeafReading(block, rect.nodeId, colorBy);
    const kind = scale === "diverging" ? "diverging" : "sequential";
    const steps = scale === "diverging" ? CHART_DIVERGING_STEPS : CHART_SEQUENTIAL_STEPS;
    const step = chartScaleStep(value, colorDomain, steps);
    return `var(--octant-${chartScaleRoleId(kind, step)})`;
  };

  const rectById = useMemo(
    () => new Map(layout.nodes.map((rect) => [rect.nodeId, rect])),
    [layout],
  );

  const focusCells = layout.nodes.filter((rect) => rect.depth === 1).map((rect) => rect.nodeId);

  const showAnchor = (nodeId: string) => {
    const rect = rectById.get(nodeId);
    if (rect === undefined) return;
    setActiveId(nodeId);
    setAnchor(anchorFor(block, nodeId, rect));
  };

  const moveActive = (delta: number) => {
    if (focusCells.length === 0) return;
    // The first arrow picks the first cell; a later arrow steps from the one
    // already chosen, so the keyboard never skips past a cell.
    if (activeId === undefined || !focusCells.includes(activeId)) {
      const first = focusCells[0];
      if (first !== undefined) showAnchor(first);
      return;
    }
    const index = focusCells.indexOf(activeId);
    const next = focusCells[(index + delta + focusCells.length) % focusCells.length];
    if (next === undefined) return;
    showAnchor(next);
  };

  const zoomOut = () => {
    const parent = parentOf.get(focusId);
    if (parent === undefined) return;
    setFocusId(parent);
    setActiveId(undefined);
    setAnchor(undefined);
  };

  const zoomIn = (nodeId: string) => {
    if ((childrenOf.get(nodeId)?.length ?? 0) === 0) return;
    setFocusId(nodeId);
    setActiveId(undefined);
    setAnchor(undefined);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        return;
      case "Enter":
        if (activeId !== undefined) {
          event.preventDefault();
          zoomIn(activeId);
        }
        return;
      case "Escape":
        event.preventDefault();
        zoomOut();
        return;
      default:
        return;
    }
  };

  const measureOptions = block.measures.map((measure) => ({
    id: String(measure.measureId),
    label: measure.label,
  }));

  const activeLeaf =
    activeId === undefined
      ? undefined
      : block.nodes.find((node) => String(node.nodeId) === activeId);
  const activeSource =
    activeLeaf !== undefined && activeLeaf.sourceId !== undefined && actionRuntime !== undefined
      ? { leaf: activeLeaf, sourceId: String(activeLeaf.sourceId) }
      : undefined;

  return (
    <figure className="canvas-block__treemap" data-color-scale={scale}>
      <div className="canvas-block__treemap-header">
        <span className="canvas-block__treemap-control">
          <span className="canvas-block__treemap-control-label">Size by</span>
          <OctantSelectField
            aria-label="Size by"
            onValueChange={setSizeBy}
            options={measureOptions}
            value={sizeBy}
          />
        </span>
        <span className="canvas-block__treemap-control">
          <span className="canvas-block__treemap-control-label">Colour by</span>
          <OctantSelectField
            aria-label="Colour by"
            onValueChange={setColorBy}
            options={measureOptions}
            value={colorBy}
          />
        </span>
        {focusId === rootId ? null : (
          <OctantButton onClick={zoomOut} type="button" variant="bare">
            Zoom out
          </OctantButton>
        )}
      </div>

      <TreemapBreadcrumb
        block={block}
        focusId={focusId}
        onFocus={(nodeId) => {
          setFocusId(nodeId);
          setActiveId(undefined);
          setAnchor(undefined);
        }}
      />

      <div
        aria-label={treemapLabel(block)}
        className="canvas-block__treemap-plot"
        onContextMenu={(event) => {
          event.preventDefault();
          zoomOut();
        }}
        onKeyDown={onKeyDown}
        role="group"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className="canvas-block__treemap-svg"
          viewBox={`0 0 ${String(PLOT_WIDTH)} ${String(PLOT_HEIGHT)}`}
        >
          {layout.nodes
            .filter((rect) => rect.depth > 0)
            .map((rect) =>
              rect.isGroup ? (
                <GroupRect
                  key={rect.nodeId}
                  active={rect.nodeId === activeId}
                  onZoom={() => zoomIn(rect.nodeId)}
                  rect={rect}
                />
              ) : (
                <LeafRect
                  key={rect.nodeId}
                  active={rect.nodeId === activeId}
                  fill={fillFor(rect)}
                  onHover={() => showAnchor(rect.nodeId)}
                  onLeave={() => {
                    setActiveId(undefined);
                    setAnchor(undefined);
                  }}
                  rect={rect}
                />
              ),
            )}
        </svg>
        <ChartTooltip anchor={anchor} />
      </div>

      {activeSource === undefined ? null : (
        <OpenFileControl
          actionRuntime={actionRuntime}
          blockId={String(block.blockId)}
          label={activeSource.leaf.label}
          nodeId={activeSource.leaf.nodeId}
          sourceId={activeSource.sourceId}
        />
      )}

      <TreemapLegend block={block} colorBy={colorBy} scale={scale} />

      <TreemapTable
        block={block}
        onOpenFile={
          actionRuntime === undefined
            ? undefined
            : (node) => (
                <OpenFileControl
                  actionRuntime={actionRuntime}
                  blockId={String(block.blockId)}
                  label={node.label}
                  nodeId={node.nodeId}
                  sourceId={String(node.sourceId ?? "")}
                />
              )
        }
        onSort={(measureId) =>
          setSort((current) =>
            current !== undefined && current.measureId === measureId
              ? { measureId, direction: current.direction === "desc" ? "asc" : "desc" }
              : { measureId, direction: "desc" },
          )
        }
        sort={sort}
        totals={totalsByMeasure}
      />
    </figure>
  );
}

function startingFocus(block: CanvasTreemapBlock, rootId: string): string {
  if (block.startNodeId === undefined) return rootId;
  const start = String(block.startNodeId);
  return block.nodes.some((node) => String(node.nodeId) === start) ? start : rootId;
}

function anchorFor(
  block: CanvasTreemapBlock,
  nodeId: string,
  rect: CanvasTreemapRect,
): ChartTooltipAnchor {
  const path = treemapPath(block, nodeId);
  const readings = block.measures
    .map((measure) => {
      const value = treemapLeafReading(block, nodeId, String(measure.measureId));
      return `${measure.label}: ${formatCanvasValue(value, measure.format)}`;
    })
    .join(" · ");
  return {
    seriesLabel: path.join(" / "),
    valueLabel: readings,
    x: Math.min(1, Math.max(0, (rect.x + rect.width / 2) / PLOT_WIDTH)),
    y: Math.min(1, Math.max(0, rect.y / PLOT_HEIGHT)),
  };
}

function GroupRect({
  rect,
  active,
  onZoom,
}: {
  readonly rect: CanvasTreemapRect;
  readonly active: boolean;
  readonly onZoom: () => void;
}) {
  const showHeader =
    rect.showsHeader &&
    rect.width >= GROUP_HEADER_MIN_WIDTH &&
    rect.height >= GROUP_HEADER_MIN_HEIGHT;
  return (
    <g
      className="canvas-block__treemap-group"
      data-active={active ? "true" : "false"}
      data-node-id={rect.nodeId}
      data-treemap-group="true"
    >
      <rect
        className="canvas-block__treemap-group-frame"
        height={rect.height}
        onClick={onZoom}
        width={rect.width}
        x={rect.x}
        y={rect.y}
      />
      {showHeader ? (
        <text className="canvas-block__treemap-group-label" x={rect.x + 4} y={rect.y + 11}>
          {rect.label}
        </text>
      ) : null}
    </g>
  );
}

function LeafRect({
  rect,
  fill,
  active,
  onHover,
  onLeave,
}: {
  readonly rect: CanvasTreemapRect;
  readonly fill: string;
  readonly active: boolean;
  readonly onHover: () => void;
  readonly onLeave: () => void;
}) {
  const showLabel = rect.width >= LABEL_MIN_WIDTH && rect.height >= LABEL_MIN_HEIGHT;
  return (
    <g
      className={`canvas-block__treemap-cell${active ? " is-active" : ""}`}
      data-active={active ? "true" : "false"}
      data-node-id={rect.nodeId}
    >
      <rect
        className="canvas-block__treemap-mark"
        fill={fill}
        height={rect.height}
        onPointerEnter={onHover}
        onPointerLeave={onLeave}
        width={rect.width}
        x={rect.x}
        y={rect.y}
      />
      {showLabel ? (
        <text className="canvas-block__treemap-label" x={rect.x + 4} y={rect.y + 12}>
          {shortLabel(rect.label, rect.width)}
        </text>
      ) : null}
    </g>
  );
}

function TreemapBreadcrumb({
  block,
  focusId,
  onFocus,
}: {
  readonly block: CanvasTreemapBlock;
  readonly focusId: string;
  readonly onFocus: (nodeId: string) => void;
}) {
  const parentOf = treemapParentOf(block);
  const trail: Array<string> = [];
  const seen = new Set<string>();
  let current: string | undefined = focusId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    trail.unshift(current);
    current = parentOf.get(current);
  }
  if (trail.length <= 1) return null;
  return (
    <nav aria-label="Zoom path" className="canvas-block__treemap-breadcrumb">
      <ol>
        {trail.map((nodeId, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={nodeId}>
              {last ? (
                <span aria-current="location">{labelFor(block, nodeId)}</span>
              ) : (
                <OctantButton onClick={() => onFocus(nodeId)} type="button" variant="bare">
                  {labelFor(block, nodeId)}
                </OctantButton>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function TreemapLegend({
  block,
  colorBy,
  scale,
}: {
  readonly block: CanvasTreemapBlock;
  readonly colorBy: string;
  readonly scale: CanvasTreemapScale;
}) {
  const measure = block.measures.find((entry) => String(entry.measureId) === colorBy);
  if (scale === "categorical") {
    const rootId = treemapRootId(block);
    const groups = treemapChildren(block).get(rootId) ?? [];
    return (
      <div className="canvas-block__treemap-legend" aria-label="Colour legend">
        <ul>
          {groups.map((groupId, index) => (
            <li key={groupId}>
              <span
                aria-hidden="true"
                className="canvas-block__treemap-swatch"
                style={{ background: `var(--oct-series-${String((index % 6) + 1)})` }}
              />
              {labelFor(block, groupId)}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const domain = treemapMeasureDomain(block, colorBy);
  const steps =
    scale === "diverging"
      ? Array.from({ length: CHART_DIVERGING_STEPS }, (_v, index) => index)
      : Array.from({ length: CHART_SEQUENTIAL_STEPS }, (_v, index) => index);
  return (
    <div className="canvas-block__treemap-legend" aria-label="Colour legend">
      <span className="canvas-block__treemap-legend-title">{measure?.label ?? "Colour"}</span>
      <ol className="canvas-block__treemap-scale">
        {steps.map((step) => (
          <li
            key={step}
            className="canvas-block__treemap-scale-step"
            style={{
              background:
                scale === "diverging"
                  ? `var(--octant-${chartScaleRoleId("diverging", step)})`
                  : `var(--octant-${chartScaleRoleId("sequential", step)})`,
            }}
          />
        ))}
      </ol>
      <span className="canvas-block__treemap-scale-bound">
        {formatCanvasValue(domain.min, measure?.format)}
      </span>
      <span className="canvas-block__treemap-scale-bound">
        {formatCanvasValue(domain.max, measure?.format)}
      </span>
    </div>
  );
}

function OpenFileControl({
  actionRuntime,
  blockId,
  label,
  nodeId,
  sourceId,
}: {
  readonly actionRuntime: CanvasActionRuntime | undefined;
  readonly blockId: string;
  readonly label: string;
  readonly nodeId: string;
  readonly sourceId: string;
}) {
  if (actionRuntime === undefined || sourceId.length === 0) return null;
  const action: CanvasActionBlock | undefined = openSourceActionBlock({
    blockId: `${blockId}-open-${nodeId}`,
    sourceId,
    label: `Open ${label}`,
  });
  if (action === undefined) return null;
  const availability = actionRuntime.availability(action);
  if (availability.state !== "available") return null;
  return (
    <OctantButton
      className="canvas-block__treemap-open"
      onClick={() => {
        void actionRuntime.onExecute(action);
      }}
      type="button"
      variant="bare"
    >
      Open file
    </OctantButton>
  );
}

interface TreemapTableProps {
  readonly block: CanvasTreemapBlock;
  readonly sort: TreemapSort | undefined;
  readonly totals: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly onSort: (measureId: string) => void;
  readonly onOpenFile: ((node: CanvasTreemapNode) => ReactNode) | undefined;
}

function TreemapTable({ block, sort, totals, onSort, onOpenFile }: TreemapTableProps) {
  const childrenOf = treemapChildren(block);
  const rootId = treemapRootId(block);
  const nodeById = new Map(block.nodes.map((node) => [String(node.nodeId), node]));
  const rows: Array<{ readonly node: CanvasTreemapNode; readonly depth: number }> = [];
  const walk = (nodeId: string, depth: number) => {
    const node = nodeById.get(nodeId);
    if (node === undefined) return;
    rows.push({ node, depth });
    const children = [...(childrenOf.get(nodeId) ?? [])];
    if (sort !== undefined) {
      const direction = sort.direction === "asc" ? 1 : -1;
      const totalOf = (id: string) => totals.get(sort.measureId)?.get(id) ?? 0;
      children.sort((left, right) => (totalOf(left) - totalOf(right)) * direction);
    }
    for (const child of children) walk(child, depth + 1);
  };
  walk(rootId, 0);

  return (
    <details className="canvas-block__treemap-data">
      <summary>View treemap data</summary>
      <div
        aria-label="Treemap data"
        className="canvas-block__treemap-table"
        role="region"
        tabIndex={0}
      >
        <table aria-label="Treemap readings" className="ds-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              {block.measures.map((measure) => (
                <th key={String(measure.measureId)} scope="col">
                  <OctantButton
                    aria-label={`Sort by ${measure.label}`}
                    aria-pressed={sort?.measureId === String(measure.measureId)}
                    onClick={() => onSort(String(measure.measureId))}
                    type="button"
                    variant="bare"
                  >
                    {measure.label}
                    {sort?.measureId === String(measure.measureId)
                      ? sort.direction === "desc"
                        ? " ↓"
                        : " ↑"
                      : ""}
                  </OctantButton>
                </th>
              ))}
              {onOpenFile === undefined ? null : <th scope="col">File</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => (
              <tr key={String(node.nodeId)}>
                <th scope="row" style={{ paddingInlineStart: `${String(depth * 14 + 4)}px` }}>
                  {node.label}
                </th>
                {block.measures.map((measure) => (
                  <td key={String(measure.measureId)}>
                    {formatCanvasValue(
                      totals.get(String(measure.measureId))?.get(String(node.nodeId)) ?? 0,
                      measure.format,
                    )}
                  </td>
                ))}
                {onOpenFile === undefined ? null : (
                  <td>{node.sourceId === undefined ? null : onOpenFile(node)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function labelFor(block: CanvasTreemapBlock, nodeId: string): string {
  return block.nodes.find((node) => String(node.nodeId) === nodeId)?.label ?? nodeId;
}

function shortLabel(label: string, width: number): string {
  const fits = Math.max(3, Math.floor(width / 7));
  return label.length <= fits ? label : `${label.slice(0, Math.max(1, fits - 1))}…`;
}

function treemapLabel(block: CanvasTreemapBlock): string {
  const children = treemapChildren(block);
  const leaves = block.nodes.filter(
    (node) => (children.get(String(node.nodeId))?.length ?? 0) === 0,
  ).length;
  return `Treemap with ${String(leaves)} cells. Use the arrow keys to move between cells and Enter to zoom in.`;
}
