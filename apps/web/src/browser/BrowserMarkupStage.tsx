import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { DEFAULT_MARKUP_INK, markupInk, type MarkupInkId } from "../theme/markupInk";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { BrowserMarkupBar, type MarkupStroke, type MarkupTool } from "./BrowserMarkupBar";
import { exportMarkedPicture, MARKUP_FILE_NAME } from "./markupExport";
import {
  emptyMarkup,
  markupReducer,
  translateMark,
  type Mark,
  type MarkupPoint,
} from "./markupModel";
import { markBounds, markHit, markShapes, markTextSize, type MarkShape } from "./markupShapes";
import "./browser-markup.css";

/** Closer than this a pen's next sample adds nothing a line would not show. */
const MIN_PEN_STEP = 2;
/** Samples held while one stroke is drawn; the model keeps far fewer. */
const MAX_RAW_PEN_POINTS = 2_000;
/** How far from a mark's line, on screen, a click still picks it. */
const PICK_SLOP_PX = 6;

export interface BrowserMarkupStageProps {
  /** The person's own kept capture, as the host answered the read. */
  readonly dataUrl: string;
  readonly onAddToChat: (file: File) => void;
  readonly onClose: () => void;
}

interface Picture {
  readonly image: HTMLImageElement;
  readonly width: number;
  readonly height: number;
}

type PictureState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | ({ readonly status: "ready" } & Picture);

interface View {
  readonly scale: number;
  readonly left: number;
  readonly top: number;
}

interface TextEntry {
  readonly at: MarkupPoint;
  /** Where the field sits over the picture, in the layer's own pixels. */
  readonly screen: { readonly left: number; readonly top: number; readonly size: number };
}

type Gesture =
  | { readonly kind: "draw"; readonly pointerId: number }
  | {
      readonly kind: "move";
      readonly pointerId: number;
      readonly id: string;
      readonly from: MarkupPoint;
    };

/**
 * The still of a kept capture with a drawing layer over it. The layer is one
 * SVG in the picture's own pixels, so the still is fitted and centred by the
 * SVG itself and a mark means the same place on the screen and in the export.
 */
export function BrowserMarkupStage(props: BrowserMarkupStageProps) {
  const [picture, setPicture] = useState<PictureState>({ status: "loading" });
  const [state, dispatch] = useReducer(markupReducer, emptyMarkup);
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [ink, setInk] = useState<MarkupInkId>(DEFAULT_MARKUP_INK);
  const [stroke, setStroke] = useState<MarkupStroke>("thin");
  const [draft, setDraft] = useState<Mark | undefined>(undefined);
  const [drag, setDrag] = useState<{
    readonly id: string;
    readonly dx: number;
    readonly dy: number;
  }>();
  const [entry, setEntry] = useState<TextEntry | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  // One font for the layer and the export: the interface's own.
  const [fontFamily] = useState(
    () => globalThis.getComputedStyle(document.body).fontFamily || "sans-serif",
  );
  const layer = useRef<SVGSVGElement>(null);
  const nextId = useRef(0);
  const gesture = useRef<Gesture | undefined>(undefined);
  const entryText = useRef("");
  const entryOpen = useRef<TextEntry | undefined>(undefined);

  useEffect(() => {
    const image = new Image();
    let current = true;
    image.onload = () => {
      if (!current) return;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        setPicture({
          status: "ready",
          image,
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      } else {
        setPicture({ status: "failed" });
      }
    };
    image.onerror = () => {
      if (current) setPicture({ status: "failed" });
    };
    image.src = props.dataUrl;
    return () => {
      current = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [props.dataUrl]);

  const width = picture.status === "ready" ? picture.width : 0;
  const height = picture.status === "ready" ? picture.height : 0;
  // Line width in picture pixels, sized to the picture so a mark reads the same
  // on a small capture and a large one.
  const lineWidth =
    Math.max(2, Math.round(Math.max(width, height) / 400)) * (stroke === "thin" ? 1 : 2);

  function viewOf(element: SVGSVGElement): View | undefined {
    const rect = element.getBoundingClientRect();
    if (width === 0 || height === 0 || rect.width === 0 || rect.height === 0) return undefined;
    const scale = Math.min(rect.width / width, rect.height / height);
    return {
      scale,
      left: rect.left + (rect.width - width * scale) / 2,
      top: rect.top + (rect.height - height * scale) / 2,
    };
  }

  function pictureStep(event: { clientX: number; clientY: number }): MarkupPoint | undefined {
    const element = layer.current;
    const view = element === null ? undefined : viewOf(element);
    if (view === undefined) return undefined;
    return {
      x: Math.min(width, Math.max(0, (event.clientX - view.left) / view.scale)),
      y: Math.min(height, Math.max(0, (event.clientY - view.top) / view.scale)),
    };
  }

  function mintMark(point: MarkupPoint): Mark | undefined {
    const id = `mark-${String(nextId.current++)}`;
    const base = { id, ink, width: lineWidth };
    if (tool === "pen") return { ...base, kind: "pen", points: [point] };
    if (tool === "box") return { ...base, kind: "box", x: point.x, y: point.y, w: 0, h: 0 };
    if (tool === "arrow") return { ...base, kind: "arrow", from: point, to: point };
    return undefined;
  }

  function commitEntry(): void {
    const open = entryOpen.current;
    if (open === undefined) return;
    const text = entryText.current;
    entryOpen.current = undefined;
    entryText.current = "";
    setEntry(undefined);
    dispatch({
      type: "add",
      mark: {
        id: `mark-${String(nextId.current++)}`,
        kind: "text",
        ink,
        width: lineWidth,
        x: open.at.x,
        y: open.at.y,
        text,
      },
    });
  }

  function cancelEntry(): void {
    entryOpen.current = undefined;
    entryText.current = "";
    setEntry(undefined);
    layer.current?.focus();
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    if (event.button !== 0 || picture.status !== "ready") return;
    const point = pictureStep(event);
    if (point === undefined) return;
    event.preventDefault();
    commitEntry();
    event.currentTarget.focus();
    if (tool === "text") {
      const view = viewOf(event.currentTarget);
      const rect = event.currentTarget.getBoundingClientRect();
      if (view === undefined) return;
      const open: TextEntry = {
        at: point,
        screen: {
          left: view.left - rect.left + point.x * view.scale,
          top: view.top - rect.top + point.y * view.scale,
          size: markTextSize(lineWidth) * view.scale,
        },
      };
      entryOpen.current = open;
      entryText.current = "";
      setEntry(open);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (tool === "select") {
      const view = viewOf(event.currentTarget);
      const slop = view === undefined ? PICK_SLOP_PX : PICK_SLOP_PX / view.scale;
      const hit = [...state.marks].reverse().find((mark) => markHit(mark, point, slop));
      dispatch({ type: "select", id: hit?.id });
      if (hit !== undefined) {
        gesture.current = { kind: "move", pointerId: event.pointerId, id: hit.id, from: point };
        setDrag({ id: hit.id, dx: 0, dy: 0 });
      }
      return;
    }
    const mark = mintMark(point);
    if (mark === undefined) return;
    dispatch({ type: "select", id: undefined });
    gesture.current = { kind: "draw", pointerId: event.pointerId };
    setDraft(mark);
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
    const active = gesture.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    const point = pictureStep(event);
    if (point === undefined) return;
    if (active.kind === "move") {
      setDrag({ id: active.id, dx: point.x - active.from.x, dy: point.y - active.from.y });
      return;
    }
    setDraft((current) => {
      if (current === undefined) return current;
      if (current.kind === "pen") {
        const last = current.points[current.points.length - 1];
        if (
          last === undefined ||
          current.points.length >= MAX_RAW_PEN_POINTS ||
          Math.hypot(point.x - last.x, point.y - last.y) < MIN_PEN_STEP
        ) {
          return current;
        }
        return { ...current, points: [...current.points, point] };
      }
      if (current.kind === "box") {
        const start = { x: current.x, y: current.y };
        // The box keeps its first corner; the model reads its size as signed.
        return { ...current, x: start.x, y: start.y, w: point.x - start.x, h: point.y - start.y };
      }
      if (current.kind === "arrow") return { ...current, to: point };
      return current;
    });
  }

  function onPointerUp(event: PointerEvent<SVGSVGElement>): void {
    const active = gesture.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (active.kind === "move") {
      if (drag !== undefined) dispatch({ type: "move", id: drag.id, dx: drag.dx, dy: drag.dy });
      setDrag(undefined);
      return;
    }
    if (draft !== undefined) dispatch({ type: "add", mark: draft });
    setDraft(undefined);
  }

  function onPointerCancel(): void {
    gesture.current = undefined;
    setDraft(undefined);
    setDrag(undefined);
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>): void {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      dispatch({ type: event.shiftKey ? "redo" : "undo" });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "remove-selected" });
    } else if (event.key === "Escape") {
      // Nothing here is destructive: a stroke in progress is dropped, otherwise
      // the selection is, and the picture and the other marks stay as they are.
      event.preventDefault();
      if (gesture.current !== undefined) onPointerCancel();
      else dispatch({ type: "select", id: undefined });
    }
  }

  async function addToChat(): Promise<void> {
    if (picture.status !== "ready" || exporting) return;
    commitEntry();
    setExporting(true);
    setExportFailed(false);
    const blob = await exportMarkedPicture({
      image: picture.image,
      picture: { width: picture.width, height: picture.height },
      marks: state.marks,
      fontFamily,
    });
    setExporting(false);
    if (blob === undefined) {
      setExportFailed(true);
      return;
    }
    props.onAddToChat(new File([blob], MARKUP_FILE_NAME, { type: "image/png" }));
  }

  const shown: ReadonlyArray<Mark> = state.marks.map((mark) =>
    drag?.id === mark.id ? translateMark(mark, drag.dx, drag.dy) : mark,
  );
  const selected = shown.find((mark) => mark.id === state.selectedId);

  return (
    <div className="browser-markup">
      {picture.status === "ready" ? (
        <svg
          ref={layer}
          aria-label="Page capture to draw on"
          className={`browser-markup__layer browser-markup__layer--${tool}`}
          onKeyDown={onKeyDown}
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          preserveAspectRatio="xMidYMid meet"
          role="application"
          tabIndex={0}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
        >
          <image
            height={height}
            href={props.dataUrl}
            preserveAspectRatio="none"
            width={width}
            x={0}
            y={0}
          />
          {[...shown, ...(draft === undefined ? [] : [draft])].map((mark) => (
            <g key={mark.id}>
              {markShapes(mark).map((shape, index) => (
                <MarkShapeElement key={index} fontFamily={fontFamily} shape={shape} />
              ))}
            </g>
          ))}
          {selected === undefined ? null : <SelectionOutline mark={selected} />}
        </svg>
      ) : picture.status === "failed" ? (
        <OctantAlert
          action={
            <OctantButton onClick={props.onClose} type="button" variant="secondary">
              Close
            </OctantButton>
          }
          className="browser-markup__failed"
          tone="danger"
        >
          This picture could not be opened for drawing.
        </OctantAlert>
      ) : (
        <p className="browser-markup__loading" role="status">
          Opening the picture…
        </p>
      )}
      {entry === undefined ? null : (
        <OctantInput
          aria-label="Text for the drawing"
          autoFocus
          className="browser-markup__text"
          onBlur={commitEntry}
          onChange={(event) => {
            entryText.current = event.target.value;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitEntry();
              layer.current?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelEntry();
            }
          }}
          spellCheck={false}
          style={{
            left: entry.screen.left,
            top: entry.screen.top,
            fontSize: Math.max(12, entry.screen.size),
            color: markupInk(ink).value,
          }}
          type="text"
        />
      )}
      {picture.status !== "ready" ? null : (
        <>
          {exportFailed ? (
            <OctantAlert className="browser-markup__problem" tone="danger">
              The marked-up picture could not be made. Try again.
            </OctantAlert>
          ) : null}
          <BrowserMarkupBar
            busy={exporting}
            canDelete={state.selectedId !== undefined}
            canRedo={state.future.length > 0}
            canUndo={state.past.length > 0}
            ink={ink}
            onAddToChat={() => void addToChat()}
            onClose={props.onClose}
            onDelete={() => dispatch({ type: "remove-selected" })}
            onInk={setInk}
            onRedo={() => dispatch({ type: "redo" })}
            onStroke={setStroke}
            onTool={(next) => {
              commitEntry();
              setTool(next);
            }}
            onUndo={() => dispatch({ type: "undo" })}
            stroke={stroke}
            tool={tool}
          />
        </>
      )}
    </div>
  );
}

function MarkShapeElement(props: { readonly shape: MarkShape; readonly fontFamily: string }) {
  const { shape } = props;
  if (shape.kind === "line") {
    return (
      <polyline
        fill="none"
        points={shape.points.map((point) => `${String(point.x)},${String(point.y)}`).join(" ")}
        stroke={shape.stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={shape.width}
      />
    );
  }
  if (shape.kind === "rect") {
    return (
      <rect
        fill="none"
        height={shape.h}
        stroke={shape.stroke}
        strokeLinejoin="miter"
        strokeWidth={shape.width}
        width={shape.w}
        x={shape.x}
        y={shape.y}
      />
    );
  }
  return (
    <text
      fill={shape.fill}
      fontFamily={props.fontFamily}
      fontSize={shape.size}
      paintOrder="stroke"
      stroke={shape.outline}
      strokeLinejoin="round"
      strokeWidth={shape.outlineWidth}
      x={shape.x}
      y={shape.y}
    >
      {shape.text}
    </text>
  );
}

/** The dashed box round the selected mark; it is the layer's, never the export's. */
function SelectionOutline(props: { readonly mark: Mark }) {
  const box = markBounds(props.mark);
  return (
    <rect
      className="browser-markup__selection"
      fill="none"
      height={box.h}
      width={box.w}
      x={box.x}
      y={box.y}
    />
  );
}
