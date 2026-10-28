import type { CanvasBlock, CanvasFlowBlock, CanvasMockupBlock } from "@octant/contracts/canvas";
import {
  CANVAS_MOCKUP_DEVICE_NAME,
  canvasMockupCallouts,
  canvasMockupFrames,
  type CanvasMockupFrame,
} from "@octant/domain";
import type { CanvasFlowScreenSourceBlock } from "@octant/domain";
import { layoutCanvasFlow } from "@octant/domain";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { ChevronLeft, Play, RotateCcw, X } from "lucide-react";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import type { DesignAssetRuntime } from "./designDocument";
import { DesignFrameView, FullscreenButton, useFullscreen, useSize } from "./DesignBlock";
import type { DiagramBoardLayoutRuntime } from "./DiagramBoard";
import { MockupFrame, type MockupHotspots } from "./MockupBlock";

/**
 * A flow block as a board: the screens it names, drawn at board scale and
 * connected by their transitions, with the diagram board's zoom, pan, and
 * journaled drag. A mockup screen draws through the same frame drawing the
 * document uses; a design screen is its live page, scaled into the node, as
 * the design board draws it. Every pointer gesture has a keyboard path, and
 * the outline lists the flow as text.
 */

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
  readonly kind: "screen" | "pan";
  readonly screenId?: string;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

// Pointer capture keeps a fast drag from escaping the node when the cursor
// outruns it; a DOM without the API (jsdom) simply drags without capture.
function capturePointer(event: PointerEvent<Element>): void {
  const target = event.currentTarget;
  if (typeof target.setPointerCapture === "function") target.setPointerCapture(event.pointerId);
}

function releasePointer(event: PointerEvent<Element>): void {
  const target = event.currentTarget;
  if (typeof target.hasPointerCapture === "function" && target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export interface FlowBoardProps {
  readonly block: CanvasFlowBlock;
  /** The document's own blocks, where the flow's screens resolve. */
  readonly blocks: ReadonlyArray<CanvasBlock>;
  /** Lets the board journal a drag; absent on surfaces that cannot. */
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
  /** Reaches the host for a design screen's images; absent, they draw as placeholders. */
  readonly designAssetRuntime?: DesignAssetRuntime;
}

/** Room under a screen for its label, in board pixels. */
const FLOW_SCREEN_LABEL_ALLOWANCE = 28;

export function FlowBoard(props: FlowBoardProps) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    new Map(),
  );
  // A newer version arrived: the layout it carries is the truth, and any
  // unsent nudge from the previous version would land on the wrong sequence.
  useEffect(() => setOverrides(new Map()), [props.block]);
  const sources = useMemo(
    () => flowScreenSources(props.block, props.blocks),
    [props.block, props.blocks],
  );
  const committedLayout = useMemo(
    () => layoutCanvasFlow(props.block, sources),
    [props.block, sources],
  );
  // While a screen is mid-drag the whole picture is laid out again from the
  // moved positions, so edges follow the screen rather than pointing at where
  // it used to be.
  const layout = useMemo(
    () =>
      overrides.size === 0
        ? committedLayout
        : layoutCanvasFlow(
            {
              ...props.block,
              layout: "manual",
              screens: props.block.screens.map((screen) => {
                const moved = overrides.get(String(screen.screenId));
                return moved === undefined
                  ? screen
                  : { ...screen, x: moved.x, y: moved.y, positioned: true };
              }),
            },
            sources,
          ),
    [committedLayout, overrides, props.block, sources],
  );
  const byId = new Map(layout.screens.map((screen) => [screen.screenId, screen]));
  // A flow's callouts are numbered in the order the author wrote, like a
  // mockup's; the marker draws on the screen's node and the note lists under
  // the outline, where a comment on the callout anchors to the screen.
  const callouts = new Map(
    (props.block.annotations ?? []).map((annotation, index) => [
      String(annotation.nodeId),
      index + 1,
    ]),
  );
  const fitViewport = (): Viewport => ({ x: -FIT_MARGIN, y: -FIT_MARGIN, zoom: 1 });
  const [viewport, setViewport] = useState<Viewport>(fitViewport);
  const [message, setMessage] = useState<string>();
  const [playing, setPlaying] = useState<string | undefined>(undefined);
  const playButton = useRef<HTMLButtonElement>(null);
  const markerScope = useId().replace(/[^A-Za-z0-9_-]/g, "");
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

  const zoomBy = useCallback(
    (factor: number) =>
      setViewport((current) => {
        const zoom = clampZoom(current.zoom * factor);
        const centreX = current.x + viewWidth / current.zoom / 2;
        const centreY = current.y + viewHeight / current.zoom / 2;
        return { zoom, x: centreX - viewWidth / zoom / 2, y: centreY - viewHeight / zoom / 2 };
      }),
    [viewWidth, viewHeight],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  const fit = () => setViewport(fitViewport());

  const commit = async (screenId: string, x: number, y: number) => {
    const runtime = props.layoutRuntime;
    if (runtime === undefined) return;
    const original = committedLayout.screens.find((screen) => screen.screenId === screenId);
    if (original !== undefined && original.x === x && original.y === y) return;
    setPending(true);
    setMessage(undefined);
    try {
      const screenIdBranded = props.block.screens.find(
        (screen) => String(screen.screenId) === screenId,
      )?.screenId;
      if (screenIdBranded === undefined) return;
      const result = await runtime.onRevise(props.block.blockId, [
        { nodeId: screenIdBranded, x, y },
      ]);
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

  const onScreenPointerDown = (event: PointerEvent<Element>, screenId: string) => {
    if (!editable || event.button !== 0) return;
    const screen = byId.get(screenId);
    if (screen === undefined) return;
    event.stopPropagation();
    capturePointer(event);
    dragRef.current = {
      kind: "screen",
      screenId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: screen.x,
      startY: screen.y,
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
    if (drag.screenId === undefined) return;
    const screenId = drag.screenId;
    setOverrides((current) => {
      const next = new Map(current);
      next.set(screenId, { x: Math.round(drag.startX + dx), y: Math.round(drag.startY + dy) });
      return next;
    });
  };

  const onPointerUp = (event: PointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (drag === undefined) return;
    releasePointer(event);
    if (drag.kind !== "screen" || drag.screenId === undefined || !drag.moved) return;
    // Compute from the gesture itself: reading `overrides` here races a sync
    // pointerMove→pointerUp, so commit would see the pre-drag position.
    const factor = scale();
    const x = Math.round(drag.startX + (event.clientX - drag.startClientX) * factor);
    const y = Math.round(drag.startY + (event.clientY - drag.startClientY) * factor);
    void commit(drag.screenId, x, y);
  };

  const onScreenKeyDown = (event: KeyboardEvent<Element>, screenId: string) => {
    const screen = byId.get(screenId);
    if (screen === undefined) return;
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
    const x = screen.x + delta.x;
    const y = screen.y + delta.y;
    setOverrides((current) => new Map(current).set(screenId, { x, y }));
    void commit(screenId, x, y);
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
      aria-label="Flow board"
      className="canvas-board canvas-flow-board"
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
        <OctantButton
          onClick={() => setPlaying(String(props.block.screens[0]?.screenId ?? ""))}
          ref={playButton}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Play aria-hidden="true" size={12} strokeWidth={2} />
          Play
        </OctantButton>
      </div>
      <svg
        className="canvas-board__svg"
        role="presentation"
        onPointerCancel={onPointerUp}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={svgRef}
        viewBox={viewBox}
      >
        <defs>
          <marker
            className="canvas-block__diagram-arrowhead"
            id={`${markerScope}-arrow`}
            markerHeight={8}
            markerWidth={8}
            orient="auto-start-reverse"
            refX={9}
            refY={5}
            viewBox="0 0 10 10"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {layout.edges.map((edge) => {
          // The label sits at the route's middle, offset above the line, so it
          // reads between the screens it joins rather than over either.
          const first = edge.points[0];
          const last = edge.points.at(-1);
          const labelX =
            first === undefined || last === undefined ? 0 : first.x + (last.x - first.x) / 2;
          const labelY =
            first === undefined || last === undefined ? 0 : first.y + (last.y - first.y) / 2 - 6;
          return (
            <g key={edge.edgeId} data-edge-id={edge.edgeId}>
              <polyline
                className="canvas-block__diagram-edge canvas-flow-board__edge"
                data-tone={edge.tone}
                markerEnd={`url(#${markerScope}-arrow)`}
                points={edge.points.map((point) => `${point.x},${point.y}`).join(" ")}
              />
              {edge.label === undefined ? null : (
                <text className="canvas-block__diagram-edge-label" x={labelX} y={labelY}>
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
        {layout.screens.map((screen) => (
          <foreignObject
            height={screen.height + FLOW_SCREEN_LABEL_ALLOWANCE}
            key={screen.screenId}
            width={screen.width}
            x={screen.x}
            y={screen.y}
          >
            <div
              aria-label={`${screen.label} screen`}
              className="canvas-flow-board__screen"
              data-source={screen.source}
              onKeyDown={(event) => onScreenKeyDown(event, screen.screenId)}
              onPointerDown={(event) => onScreenPointerDown(event, screen.screenId)}
              role={editable ? "button" : undefined}
              tabIndex={editable ? 0 : undefined}
            >
              {screen.source === "mockup" ? (
                <MockupScreen
                  blockId={screen.blockId}
                  blocks={props.blocks}
                  {...(screen.variantId === undefined ? {} : { variantId: screen.variantId })}
                />
              ) : (
                <DesignScreen
                  {...(props.designAssetRuntime === undefined
                    ? {}
                    : { assetRuntime: props.designAssetRuntime })}
                  blockId={screen.blockId}
                  blocks={props.blocks}
                  {...(screen.frameId === undefined ? {} : { frameId: screen.frameId })}
                  height={screen.height}
                  scale={screen.scale}
                  width={screen.width}
                />
              )}
              <span className="canvas-flow-board__screen-label">{screen.label}</span>
              {callouts.get(screen.screenId) === undefined ? null : (
                <span aria-hidden="true" className="canvas-flow-board__callout">
                  {String(callouts.get(screen.screenId))}
                </span>
              )}
            </div>
          </foreignObject>
        ))}
      </svg>
      {(props.block.annotations ?? []).length === 0 ? null : (
        <ol className="canvas-flow-board__callouts" aria-label={`Callouts on ${props.block.title}`}>
          {(props.block.annotations ?? []).map((annotation, index) => (
            <li className="canvas-flow-board__callout-note" key={String(annotation.nodeId)}>
              <span aria-hidden="true" className="canvas-flow-board__callout">
                {String(index + 1)}
              </span>
              <span>
                <span className="canvas-flow-board__callout-target">
                  {byId.get(String(annotation.nodeId))?.label ?? String(annotation.nodeId)}
                </span>
                {` — ${annotation.note}`}
              </span>
            </li>
          ))}
        </ol>
      )}
      <details className="canvas-flow-board__outline">
        <summary>Outline</summary>
        <ul>
          {layout.screens.map((screen) => (
            <li key={screen.screenId}>{screen.label}</li>
          ))}
        </ul>
        <ul>
          {layout.edges.map((edge) => (
            <li key={edge.edgeId}>
              {`${edge.from.label} → ${edge.to.label}${edge.label === undefined ? "" : `: ${edge.label}`}${edge.hotspot === undefined ? "" : ` (via ${edge.hotspot.label})`}`}
            </li>
          ))}
        </ul>
      </details>
      {message === undefined ? null : (
        <OctantAlert className="canvas-board__message" tone="warning">
          {message}
        </OctantAlert>
      )}
      {playing === undefined ? null : (
        <FlowPlayer
          block={props.block}
          blocks={props.blocks}
          {...(props.designAssetRuntime === undefined
            ? {}
            : { designAssetRuntime: props.designAssetRuntime })}
          onClose={() => setPlaying(undefined)}
          restoreFocus={playButton}
          startScreenId={playing}
        />
      )}
    </div>
  );
}

/** The frame a mockup without variants names; a validated block always holds one. */
const EMPTY_MOCKUP_FRAME: CanvasMockupFrame = { key: "screen", label: undefined, roots: [] };

/** The screen a design frame's own anchor names, when it names one: `#octant-flow:results` → `results`. */
export function flowDesignHotspotTarget(hash: string): string | undefined {
  const match = /^#octant-flow:([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(hash);
  return match === null ? undefined : (match[1] ?? undefined);
}

/**
 * A flow's click-through prototype: each screen drawn at its own size and
 * scaled to the stage, its named hotspots real buttons, every screen-level
 * transition an explicit Go to link, Back over the path taken, and no script
 * anywhere. Where the person is, and how they got there, is view state alone.
 */
function FlowPlayer(props: {
  readonly block: CanvasFlowBlock;
  readonly blocks: ReadonlyArray<CanvasBlock>;
  readonly designAssetRuntime?: DesignAssetRuntime;
  readonly onClose: () => void;
  readonly restoreFocus: RefObject<HTMLButtonElement | null>;
  readonly startScreenId: string;
}) {
  const { block, blocks } = props;
  const [current, setCurrent] = useState(props.startScreenId);
  const [history, setHistory] = useState<ReadonlyArray<string>>([]);
  const [stageRef, stage] = useSize();
  const fullscreen = useFullscreen<HTMLDivElement>();
  const sources = useMemo(() => flowScreenSources(block, blocks), [block, blocks]);
  const layout = useMemo(() => layoutCanvasFlow(block, sources), [block, sources]);
  const box = layout.screens.find((screen) => screen.screenId === current);
  const screen = block.screens.find((candidate) => String(candidate.screenId) === current);
  const mockupBlock =
    screen === undefined
      ? undefined
      : blocks.find(
          (candidate): candidate is CanvasMockupBlock =>
            candidate.kind === "mockup" && String(candidate.blockId) === String(screen.blockId),
        );
  // The player draws a screen at its intrinsic size — the device's viewport,
  // not the board's capped thumbnail width — scaled to fit the stage.
  const intrinsic =
    box === undefined || box.scale === 0
      ? undefined
      : { width: box.width / box.scale, height: box.height / box.scale };
  const scale =
    intrinsic === undefined || stage === undefined
      ? 1
      : Math.min(1, stage.width / intrinsic.width, stage.height / Math.max(intrinsic.height, 1));

  // The edges leaving the current screen: the ones with a hotspot reach their
  // target from inside the mockup's own drawing; the rest wait in the Go to
  // list, so no transition is left without a place to tap.
  const leaving = block.edges.filter((edge) => String(edge.fromScreenId) === current);
  // A designed screen's own anchors navigate the flow: the frame is drawn
  // same-origin (it still runs nothing), so the page's hash is readable and a
  // link the author wrote as #octant-flow:<screen> moves the prototype. The
  // exported site keeps the Go to list — a sandboxed frame there cannot reach
  // out without script.
  const designHostRef = useRef<HTMLDivElement>(null);
  const screenIdSet = useMemo(
    () => new Set(block.screens.map((screen) => String(screen.screenId))),
    [block],
  );
  useEffect(() => {
    if (mockupBlock !== undefined) return;
    const frame = designHostRef.current?.querySelector("iframe");
    const win = frame?.contentWindow;
    if (win === null || win === undefined) return;
    const followAnchor = () => {
      const target = flowDesignHotspotTarget(win.location.hash);
      if (target !== undefined && screenIdSet.has(target)) go(target);
    };
    win.addEventListener("hashchange", followAnchor);
    return () => win.removeEventListener("hashchange", followAnchor);
  });
  const go = (target: string) => {
    setHistory((path) => [...path, current]);
    setCurrent(target);
  };
  const hotspots: MockupHotspots = useMemo(
    () =>
      new Map(
        leaving.flatMap((edge) =>
          edge.fromNodeId === undefined
            ? []
            : ([[String(edge.fromNodeId), () => go(String(edge.toScreenId))]] as const),
        ),
      ),
    // The handlers close over the current screen only through `go`, which the
    // state update already carries, so the map is rebuilt when edges change.
    [block, current],
  );
  const screenLevel = leaving.filter((edge) => edge.fromNodeId === undefined);

  return (
    <OctantDialog
      className="canvas-flow-player"
      label={`Playing ${block.title}`}
      onClose={props.onClose}
      open
      restoreFocus={props.restoreFocus}
    >
      <div className="canvas-flow-player__body" ref={fullscreen.ref}>
        <header className="canvas-flow-player__bar">
          <span className="canvas-flow-player__title">{block.title}</span>
          <span className="canvas-flow-player__hint">Tap a control to move between screens</span>
          <div className="canvas-flow-player__actions">
            <OctantButton
              aria-label="Go back"
              disabled={history.length === 0}
              onClick={() =>
                setHistory((path) => {
                  const last = path.at(-1);
                  if (last !== undefined) setCurrent(last);
                  return path.slice(0, -1);
                })
              }
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" size={16} strokeWidth={1.8} />
            </OctantButton>
            <OctantButton
              onClick={() => {
                setHistory([]);
                setCurrent(props.startScreenId);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <RotateCcw aria-hidden="true" size={12} strokeWidth={2} />
              Restart
            </OctantButton>
            <FullscreenButton fullscreen={fullscreen} />
            <OctantButton
              aria-label="Close"
              onClick={props.onClose}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={16} strokeWidth={1.8} />
            </OctantButton>
          </div>
        </header>
        <div className="canvas-flow-player__stage" ref={stageRef}>
          {box === undefined || screen === undefined ? null : (
            <div
              className="canvas-flow-player__screen"
              style={{
                width: (intrinsic?.width ?? 0) * scale,
                height: (intrinsic?.height ?? 0) * scale,
              }}
            >
              {mockupBlock === undefined ? (
                screen.frameId === undefined ? null : (
                  <div ref={designHostRef}>
                    <DesignFrameView
                      {...(props.designAssetRuntime === undefined
                        ? {}
                        : { assetRuntime: props.designAssetRuntime })}
                      block={
                        blocks.find(
                          (candidate) =>
                            candidate.kind === "design" &&
                            String(candidate.blockId) === String(screen.blockId),
                        ) as never
                      }
                      frameId={screen.frameId}
                      sandboxOverride="allow-same-origin"
                      scale={scale}
                    />
                  </div>
                )
              ) : (
                <div
                  className="canvas-flow-player__mockup"
                  style={{ width: (intrinsic?.width ?? 0) * scale }}
                >
                  <MockupFrame
                    block={mockupBlock}
                    callouts={canvasMockupCallouts(mockupBlock)}
                    deviceDetail={
                      mockupBlock.size === undefined
                        ? CANVAS_MOCKUP_DEVICE_NAME[mockupBlock.device]
                        : `${String(mockupBlock.size.width)} × ${String(mockupBlock.size.height)}`
                    }
                    frame={
                      canvasMockupFrames(mockupBlock).find(
                        (candidate) =>
                          candidate.key ===
                          (screen?.variantId === undefined ? "screen" : String(screen.variantId)),
                      ) ?? EMPTY_MOCKUP_FRAME
                    }
                    hotspots={hotspots}
                  />
                </div>
              )}
            </div>
          )}
          {screenLevel.length === 0 ? null : (
            <nav aria-label="Continue" className="canvas-flow-player__links">
              {screenLevel.map((edge) => (
                <OctantButton
                  key={String(edge.edgeId)}
                  onClick={() => go(String(edge.toScreenId))}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {`${edge.label ?? "Continue"} →`}
                </OctantButton>
              ))}
            </nav>
          )}
        </div>
      </div>
    </OctantDialog>
  );
}

/** The document's mockup and design blocks as the flow layout reads them. */
function flowScreenSources(
  flow: CanvasFlowBlock,
  blocks: ReadonlyArray<CanvasBlock>,
): ReadonlyArray<CanvasFlowScreenSourceBlock> {
  const wanted = new Set(flow.screens.map((screen) => String(screen.blockId)));
  return blocks.filter((block) =>
    wanted.has(String(block.blockId)),
  ) as ReadonlyArray<CanvasFlowScreenSourceBlock>;
}

/** A mockup screen: the variant the flow names, drawn through the same frame the document draws. */
function MockupScreen({
  blockId,
  blocks,
  variantId,
}: {
  readonly blockId: string;
  readonly blocks: ReadonlyArray<CanvasBlock>;
  readonly variantId?: string | undefined;
}) {
  const block = blocks.find(
    (candidate): candidate is CanvasMockupBlock =>
      candidate.kind === "mockup" && String(candidate.blockId) === blockId,
  );
  if (block === undefined) return null;
  const callouts = canvasMockupCallouts(block);
  const frames = canvasMockupFrames(block);
  const frame =
    variantId === undefined
      ? frames[0]
      : frames.find((candidate) => candidate.key === String(variantId));
  if (frame === undefined) return null;
  const deviceDetail =
    block.size === undefined
      ? CANVAS_MOCKUP_DEVICE_NAME[block.device]
      : `${String(block.size.width)} × ${String(block.size.height)}`;
  return (
    <MockupFrame block={block} callouts={callouts} deviceDetail={deviceDetail} frame={frame} />
  );
}

/** A design screen: the named frame of a static design, scaled into the node. */
function DesignScreen({
  assetRuntime,
  blockId,
  blocks,
  frameId,
  height,
  scale,
  width,
}: {
  readonly assetRuntime?: DesignAssetRuntime;
  readonly blockId: string;
  readonly blocks: ReadonlyArray<CanvasBlock>;
  readonly frameId?: string | undefined;
  readonly height: number;
  readonly scale: number;
  readonly width: number;
}) {
  const block = blocks.find(
    (candidate) => candidate.kind === "design" && String(candidate.blockId) === blockId,
  );
  if (block === undefined || block.kind !== "design" || frameId === undefined) return null;
  return (
    // The wrapper takes the frame's own viewport ratio, so a phone or tablet
    // page is not cropped to a landscape box around its scaled iframe.
    <div
      className="canvas-flow-board__design-frame"
      data-canvas-design={blockId}
      style={{ aspectRatio: `${String(width)} / ${String(height)}` }}
    >
      <DesignFrameView
        {...(assetRuntime === undefined ? {} : { assetRuntime })}
        block={block}
        frameId={frameId}
        scale={scale}
      />
    </div>
  );
}
