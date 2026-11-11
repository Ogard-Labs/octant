import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { CANVAS_COMMENT_STROKE_MAX_POINTS } from "@octant/contracts/canvas-board";
import {
  canvasAreaOfDrag,
  canvasCommentPickAt,
  canvasPointInBlock,
  canvasStrokeOfDrag,
  type CanvasCommentMark,
  type CanvasCommentPick,
  type CanvasTool,
} from "./canvasTools";

export interface CanvasToolSurfaceProps {
  readonly tool: CanvasTool;
  /** Whether the Canvas takes a comment on the anchor a choice id names. */
  readonly isAnchor: (choiceId: string) => boolean;
  readonly onPick: (pick: CanvasCommentPick) => void;
  /** A box, a line, or a point a person marked on one block. */
  readonly onMark: (mark: CanvasCommentMark) => void;
  readonly children: ReactNode;
}

type Gesture =
  | {
      readonly kind: "hand";
      readonly x: number;
      readonly y: number;
      readonly left: number;
      readonly top: number;
    }
  | {
      readonly kind: "area";
      readonly blockId: string;
      readonly section: Element;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: "pen";
      readonly blockId: string;
      readonly section: Element;
      /** Every place the pointer has been, in client pixels. */
      readonly path: Array<{ readonly x: number; readonly y: number }>;
    };

interface Outline {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The scrolling document of a Canvas, with the chosen tool laid over it. With
 * `select` it adds nothing. Any other tool takes pointer input in the capture
 * phase, before a block sees it: a board would otherwise pan and a button
 * would fire under a drag that meant to move the page or mark an area. A
 * click made from the keyboard is let through, so a person without a pointer
 * keeps every control and comments from the markers beside each block.
 */
export function CanvasToolSurface(props: CanvasToolSurfaceProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const hovered = useRef<Element | undefined>(undefined);
  const [target, setTarget] = useState<Outline>();
  const [band, setBand] = useState<Outline>();
  // The line under the pen while it is down, in the document's own pixels.
  const [ink, setInk] = useState<string>();
  const { tool } = props;

  // A tool change ends whatever the last tool was showing.
  useEffect(() => {
    gesture.current = undefined;
    hovered.current = undefined;
    setTarget(undefined);
    setBand(undefined);
    setInk(undefined);
  }, [tool]);

  const outlineOf = (rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  }): Outline | undefined => {
    const origin = content.current?.getBoundingClientRect();
    if (origin === undefined) return undefined;
    return {
      left: rect.left - origin.left,
      top: rect.top - origin.top,
      width: rect.width,
      height: rect.height,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (tool === "hand") {
      const scrolled = scroller.current;
      if (scrolled === null) return;
      gesture.current = {
        kind: "hand",
        x: event.clientX,
        y: event.clientY,
        left: scrolled.scrollLeft,
        top: scrolled.scrollTop,
      };
      capturePointer(event);
      return;
    }
    if (tool !== "area" && tool !== "pen") return;
    const section = markableBlock(event.target);
    if (section === undefined) return;
    const blockId = section.getAttribute("data-block-id") ?? "";
    const at = { x: event.clientX, y: event.clientY };
    gesture.current =
      tool === "area"
        ? { kind: "area", blockId, section, ...at }
        : { kind: "pen", blockId, section, path: [at] };
    capturePointer(event);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current?.kind === "hand") {
      const scrolled = scroller.current;
      if (scrolled === null) return;
      scrolled.scrollLeft = current.left - (event.clientX - current.x);
      scrolled.scrollTop = current.top - (event.clientY - current.y);
      return;
    }
    if (current?.kind === "pen") {
      current.path.push({ x: event.clientX, y: event.clientY });
      const origin = content.current?.getBoundingClientRect();
      if (origin === undefined) return;
      setInk(
        current.path
          .map((at) => `${String(at.x - origin.left)},${String(at.y - origin.top)}`)
          .join(" "),
      );
      return;
    }
    if (current?.kind === "area") {
      const block = current.section.getBoundingClientRect();
      const area = canvasAreaOfDrag(block, current, { x: event.clientX, y: event.clientY });
      setBand(
        area === undefined
          ? undefined
          : outlineOf({
              left: block.left + (area.x / 100) * block.width,
              top: block.top + (area.y / 100) * block.height,
              width: (area.width / 100) * block.width,
              height: (area.height / 100) * block.height,
            }),
      );
      return;
    }
    if (tool !== "comment" || !(event.target instanceof Element)) return;
    const found = canvasCommentPickAt(event.target, props.isAnchor);
    if (found?.element === hovered.current) return;
    hovered.current = found?.element;
    setTarget(found === undefined ? undefined : outlineOf(found.element.getBoundingClientRect()));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = undefined;
    if (current === undefined) return;
    releasePointer(event);
    if (current.kind === "hand") return;
    const block = current.section.getBoundingClientRect();
    const at = { x: event.clientX, y: event.clientY };
    if (current.kind === "area") {
      setBand(undefined);
      const area = canvasAreaOfDrag(block, current, at);
      if (area !== undefined) props.onMark({ kind: "area", blockId: current.blockId, ...area });
    } else {
      setInk(undefined);
      const points = canvasStrokeOfDrag(
        block,
        [...current.path, at],
        CANVAS_COMMENT_STROKE_MAX_POINTS,
      );
      if (points !== undefined) {
        props.onMark({ kind: "stroke", blockId: current.blockId, points });
      }
    }
  };

  // A drag the browser took away (a pen or touch takeover, a system gesture)
  // was never finished, so it marks nothing: its last coordinates are not
  // where the person let go.
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current === undefined) return;
    gesture.current = undefined;
    releasePointer(event);
    setBand(undefined);
    setInk(undefined);
  };

  // Also on scroll: the page moved under a still pointer, so the outlined
  // part is no longer the one a click would pick.
  const clearTarget = () => {
    hovered.current = undefined;
    setTarget(undefined);
  };

  // The press itself would move focus into the block and start a text
  // selection under a drag.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    // `detail` counts pointer presses and is 0 for a click a key made.
    if (event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (tool === "text") {
      const section = markableBlock(event.target);
      const point =
        section === undefined
          ? undefined
          : canvasPointInBlock(section.getBoundingClientRect(), {
              x: event.clientX,
              y: event.clientY,
            });
      if (section !== undefined && point !== undefined) {
        props.onMark({
          kind: "note",
          blockId: section.getAttribute("data-block-id") ?? "",
          ...point,
        });
      }
      return;
    }
    if (tool !== "comment" || !(event.target instanceof Element)) return;
    const found = canvasCommentPickAt(event.target, props.isAnchor);
    if (found !== undefined) props.onPick(found.pick);
  };

  const handlers =
    tool === "select"
      ? {}
      : {
          onClickCapture: onClick,
          onMouseDownCapture: onMouseDown,
          onPointerCancelCapture: onPointerCancel,
          onPointerDownCapture: onPointerDown,
          onPointerLeave: clearTarget,
          onPointerMoveCapture: onPointerMove,
          onPointerUpCapture: onPointerUp,
        };

  return (
    <div
      className="canvas-workspace-tab__document"
      onScroll={tool === "comment" ? clearTarget : undefined}
      ref={scroller}
    >
      <div className="canvas-tool-surface" data-tool={tool} ref={content} {...handlers}>
        {props.children}
        {target === undefined ? null : (
          <div aria-hidden="true" className="canvas-tool-surface__target" style={placed(target)} />
        )}
        {band === undefined ? null : (
          <div aria-hidden="true" className="canvas-tool-surface__band" style={placed(band)} />
        )}
        {ink === undefined ? null : (
          <svg aria-hidden="true" className="canvas-tool-surface__ink">
            <polyline points={ink} />
          </svg>
        )}
      </div>
    </div>
  );
}

/**
 * The block a drawn mark would sit on. A board's picture zooms and pans under
 * its block, so a share of the block's box would not stay on what the person
 * marked: it takes none, and its nodes and edges take comments instead.
 */
function markableBlock(target: EventTarget): Element | undefined {
  if (!(target instanceof Element) || target.closest(".canvas-board") !== null) return undefined;
  return target.closest("section.canvas-block[data-block-id]") ?? undefined;
}

function placed(outline: Outline): CSSProperties {
  return {
    left: outline.left,
    top: outline.top,
    width: outline.width,
    height: outline.height,
  };
}

// Capture keeps a drag alive when the pointer leaves the document; a DOM
// without the API (jsdom) drags without it.
function capturePointer(event: PointerEvent<HTMLDivElement>): void {
  const element = event.currentTarget;
  if (typeof element.setPointerCapture === "function") element.setPointerCapture(event.pointerId);
}

function releasePointer(event: PointerEvent<HTMLDivElement>): void {
  const element = event.currentTarget;
  if (
    typeof element.hasPointerCapture === "function" &&
    element.hasPointerCapture(event.pointerId)
  ) {
    element.releasePointerCapture(event.pointerId);
  }
}
