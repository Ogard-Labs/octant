import type { CanvasDiagramBlock } from "@octant/contracts/canvas";
import type { CanvasDiagramNodePosition } from "@octant/contracts/canvas-board";
import { layoutCanvasDiagram } from "@octant/domain";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { OctantButton } from "../../ui/base/OctantButton";

/**
 * How the board hands a finished drag to the host. Absent when the surface
 * cannot journal a layout (a shared snapshot, an older host, a paired
 * browser): the board still zooms and pans, and the nodes stay where the
 * version put them.
 */
export interface DiagramBoardLayoutRuntime {
  readonly onRevise: (
    blockId: CanvasDiagramBlock["blockId"],
    positions: ReadonlyArray<CanvasDiagramNodePosition>,
  ) => Promise<
    { readonly kind: "accepted" } | { readonly kind: "denied"; readonly message: string }
  >;
}

export interface DiagramBoardProps {
  readonly block: CanvasDiagramBlock;
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.2;
const KEYBOARD_NUDGE = 10;
const KEYBOARD_NUDGE_LARGE = 50;
const FIT_MARGIN = 24;

interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

interface Drag {
  readonly kind: "node" | "pan";
  readonly nodeId?: string;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

// Pointer capture keeps a fast drag from escaping the node when the cursor
// outruns it; a DOM without the API (jsdom) simply drags without capture.
function capturePointer(event: PointerEvent<SVGElement>): void {
  const target = event.currentTarget;
  if (typeof target.setPointerCapture === "function") target.setPointerCapture(event.pointerId);
}

function releasePointer(event: PointerEvent<SVGElement>): void {
  const target = event.currentTarget;
  if (typeof target.hasPointerCapture === "function" && target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * A diagram block as a board: zoom, pan, and fit through the viewBox; a drag
 * or arrow-key nudge moves a node and, when the host offers a layout runtime,
 * appends an immutable version with the new positions. Every pointer gesture
 * has a keyboard path: nodes are focusable, arrows move the focused node,
 * `+` `-` zoom, `0` fits.
 */
export function DiagramBoard(props: DiagramBoardProps) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    new Map(),
  );
  // A newer version arrived: the layout it carries is the truth, and any
  // unsent nudge from the previous version would land on the wrong sequence.
  useEffect(() => setOverrides(new Map()), [props.block]);
  const committedLayout = useMemo(() => layoutCanvasDiagram(props.block), [props.block]);
  // While a node is mid-drag the whole picture is laid out again from the
  // moved positions, so edges and group boxes follow the node rather than
  // pointing at where it used to be.
  const layout = useMemo(
    () =>
      overrides.size === 0
        ? committedLayout
        : layoutCanvasDiagram({
            ...props.block,
            layout: "manual",
            nodes: props.block.nodes.map((node) => {
              const moved = overrides.get(String(node.nodeId));
              return moved === undefined
                ? node
                : { ...node, x: moved.x, y: moved.y, positioned: true };
            }),
          }),
    [committedLayout, overrides, props.block],
  );
  const nodes = layout.nodes;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const fitViewport = (): Viewport => ({
    x: -FIT_MARGIN,
    y: -FIT_MARGIN,
    zoom: 1,
  });
  const [viewport, setViewport] = useState<Viewport>(fitViewport);
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const dragRef = useRef<Drag | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewWidth = committedLayout.width + FIT_MARGIN * 2;
  const viewHeight = committedLayout.height + FIT_MARGIN * 2;
  const viewBox = `${viewport.x} ${viewport.y} ${viewWidth / viewport.zoom} ${viewHeight / viewport.zoom}`;
  const editable = props.layoutRuntime !== undefined && !pending;

  const scale = (): number => {
    const svg = svgRef.current;
    if (svg === null) return 1;
    const rect = svg.getBoundingClientRect();
    return rect.width === 0 ? 1 : viewWidth / viewport.zoom / rect.width;
  };

  const zoomBy = (factor: number) =>
    setViewport((current) => {
      const zoom = clampZoom(current.zoom * factor);
      // Zoom about the centre of what is on screen, so the picture grows in
      // place instead of running off toward the origin.
      const centreX = current.x + viewWidth / current.zoom / 2;
      const centreY = current.y + viewHeight / current.zoom / 2;
      return { zoom, x: centreX - viewWidth / zoom / 2, y: centreY - viewHeight / zoom / 2 };
    });
  const fit = () => setViewport(fitViewport());

  const commit = async (nodeId: string, x: number, y: number) => {
    const runtime = props.layoutRuntime;
    if (runtime === undefined) return;
    const original = committedLayout.nodes.find((node) => node.nodeId === nodeId);
    if (original !== undefined && original.x === x && original.y === y) return;
    setPending(true);
    setMessage(undefined);
    try {
      const nodeIdBranded = props.block.nodes.find(
        (node) => String(node.nodeId) === nodeId,
      )?.nodeId;
      if (nodeIdBranded === undefined) return;
      const result = await runtime.onRevise(props.block.blockId, [{ nodeId: nodeIdBranded, x, y }]);
      if (result.kind === "denied") {
        setOverrides(new Map());
        setMessage(result.message);
      }
    } catch {
      setOverrides(new Map());
      setMessage("The board could not be saved on the host.");
    } finally {
      setPending(false);
    }
  };

  const onNodePointerDown = (event: PointerEvent<SVGGElement>, nodeId: string) => {
    if (!editable || event.button !== 0) return;
    const node = byId.get(nodeId);
    if (node === undefined) return;
    event.stopPropagation();
    capturePointer(event);
    dragRef.current = {
      kind: "node",
      nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.x,
      startY: node.y,
      moved: false,
    };
  };

  const onBackgroundPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    capturePointer(event);
    dragRef.current = {
      kind: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (drag === undefined) return;
    const factor = scale();
    const dx = (event.clientX - drag.startClientX) * factor;
    const dy = (event.clientY - drag.startClientY) * factor;
    if (Math.abs(dx) + Math.abs(dy) > 0) drag.moved = true;
    if (drag.kind === "pan") {
      setViewport((current) => ({ ...current, x: drag.startX - dx, y: drag.startY - dy }));
      return;
    }
    if (drag.nodeId === undefined) return;
    const nodeId = drag.nodeId;
    setOverrides((current) => {
      const next = new Map(current);
      next.set(nodeId, { x: Math.round(drag.startX + dx), y: Math.round(drag.startY + dy) });
      return next;
    });
  };

  const onPointerUp = (event: PointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (drag === undefined) return;
    releasePointer(event);
    if (drag.kind !== "node" || drag.nodeId === undefined || !drag.moved) return;
    const moved = overrides.get(drag.nodeId) ?? byId.get(drag.nodeId);
    if (moved !== undefined) void commit(drag.nodeId, moved.x, moved.y);
  };

  const onNodeKeyDown = (event: KeyboardEvent<SVGGElement>, nodeId: string) => {
    const node = byId.get(nodeId);
    if (node === undefined) return;
    const step = event.shiftKey ? KEYBOARD_NUDGE_LARGE : KEYBOARD_NUDGE;
    const delta =
      event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : event.key === "ArrowDown"
              ? { x: 0, y: step }
              : undefined;
    if (delta === undefined || !editable) return;
    event.preventDefault();
    const x = node.x + delta.x;
    const y = node.y + delta.y;
    setOverrides((current) => new Map(current).set(nodeId, { x, y }));
    void commit(nodeId, x, y);
  };

  const onBoardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
    }
  };

  return (
    <div
      aria-label="Board"
      className="canvas-board"
      data-editable={editable ? "true" : "false"}
      onKeyDown={onBoardKeyDown}
      role="group"
    >
      <div className="canvas-board__controls">
        <OctantButton
          aria-label="Zoom in"
          onClick={() => zoomBy(ZOOM_STEP)}
          size="sm"
          type="button"
          variant="ghost"
        >
          +
        </OctantButton>
        <OctantButton
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          size="sm"
          type="button"
          variant="ghost"
        >
          −
        </OctantButton>
        <OctantButton aria-label="Fit board" onClick={fit} size="sm" type="button" variant="ghost">
          Fit
        </OctantButton>
        <span aria-live="polite" className="canvas-board__zoom">
          {Math.round(viewport.zoom * 100)}%
        </span>
      </div>
      <svg
        className="canvas-block__diagram-svg canvas-board__svg"
        role="presentation"
        onPointerCancel={onPointerUp}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        }}
        ref={svgRef}
        viewBox={viewBox}
      >
        {layout.groups.map((group) => (
          <g key={group.groupId} className="canvas-block__diagram-group">
            <rect x={group.x} y={group.y} width={group.width} height={group.height} rx={8} />
            <text x={group.x + 10} y={group.y + 15}>
              {group.label}
            </text>
          </g>
        ))}
        {layout.edges.map((edge) => (
          <g key={edge.edgeId}>
            <line
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              className="canvas-block__diagram-edge"
            />
            {edge.label === undefined ? null : (
              <text x={edge.labelX} y={edge.labelY} className="canvas-block__diagram-edge-label">
                {edge.label}
              </text>
            )}
          </g>
        ))}
        {nodes.map((node) => (
          <g
            aria-label={node.label}
            className="canvas-block__diagram-node canvas-board__node"
            data-node-id={node.nodeId}
            key={node.nodeId}
            onKeyDown={(event) => onNodeKeyDown(event, node.nodeId)}
            onPointerDown={(event) => onNodePointerDown(event, node.nodeId)}
            role={editable ? "button" : undefined}
            tabIndex={editable ? 0 : undefined}
          >
            <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={6} />
            <text x={node.x + node.width / 2} y={node.y + node.height / 2}>
              {node.label}
            </text>
          </g>
        ))}
      </svg>
      {message === undefined ? null : (
        <p className="canvas-board__message" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
