import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Play, RotateCcw, X } from "lucide-react";
import {
  CANVAS_DESIGN_VIEWPORT,
  type CanvasDesignBlock,
  type CanvasDesignSize,
} from "@octant/contracts/canvas";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import { designDocument } from "./designDocument";

const SIZE_NAME: Record<CanvasDesignSize, string> = {
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
  slide: "Slide",
};

/** How wide a frame is drawn on the board before the board runs out of room. */
const BOARD_FRAME_WIDTH: Record<CanvasDesignSize, number> = {
  phone: 200,
  tablet: 260,
  desktop: 440,
  slide: 440,
};

/**
 * Screens of an app or site, or the slides of a deck, side by side. Each frame
 * is a picture here; Play (or Present, for slides) opens the design at full
 * size, where its links work.
 */
export function DesignBlock({ block }: { readonly block: CanvasDesignBlock }) {
  const slides = block.size === "slide";
  const [playing, setPlaying] = useState<string | undefined>(undefined);
  const playButton = useRef<HTMLButtonElement>(null);
  const [boardRef, board] = useSize();
  const boardWidth = board?.width;
  const viewport = CANVAS_DESIGN_VIEWPORT[block.size];
  const frameWidth = Math.min(BOARD_FRAME_WIDTH[block.size], boardWidth ?? Infinity);
  const scale = frameWidth / viewport.width;
  const count = block.frames.length;
  const noun = slides ? (count === 1 ? "slide" : "slides") : count === 1 ? "screen" : "screens";
  const first = String(block.frames[0]?.frameId ?? "");

  return (
    <section
      aria-label={`${block.title}, ${SIZE_NAME[block.size]} design`}
      aria-roledescription="design"
      className="canvas-design"
    >
      <header className="canvas-design__header">
        <div className="canvas-design__heading">
          <h3 className="canvas-design__title">{block.title}</h3>
          <span className="canvas-design__meta">
            {`${SIZE_NAME[block.size]} · ${String(count)} ${noun}`}
          </span>
        </div>
        <OctantButton
          onClick={() => setPlaying(first)}
          ref={playButton}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Play aria-hidden="true" size={12} strokeWidth={2} />
          {slides ? "Present" : "Play"}
        </OctantButton>
      </header>
      <div className="canvas-design__board" ref={boardRef}>
        {block.frames.map((frame, index) => (
          <figure className="canvas-design__frame" key={String(frame.frameId)}>
            <figcaption className="canvas-design__caption">
              <span className="canvas-design__index">{String(index + 1)}</span>
              <span className="canvas-design__frame-title">{frame.title}</span>
            </figcaption>
            {/* Chromium draws nothing for a frame inside a button, so the
                button lies over the picture instead of holding it. */}
            <div
              className="canvas-design__preview"
              style={{ width: frameWidth, height: viewport.height * scale }}
            >
              <FrameView
                block={block}
                frameIds={[String(frame.frameId)]}
                still
                scale={scale}
                title={`${frame.title}, ${SIZE_NAME[block.size]} ${slides ? "slide" : "screen"}`}
              />
              <OctantButton
                aria-label={`${slides ? "Present from" : "Play from"} ${frame.title}`}
                className="canvas-design__open"
                onClick={() => setPlaying(String(frame.frameId))}
                type="button"
                variant="bare"
              />
            </div>
          </figure>
        ))}
      </div>
      {playing === undefined ? null : (
        <DesignPlayer
          block={block}
          onClose={() => setPlaying(undefined)}
          restoreFocus={playButton}
          startFrameId={playing}
        />
      )}
    </section>
  );
}

function DesignPlayer({
  block,
  startFrameId,
  onClose,
  restoreFocus,
}: {
  readonly block: CanvasDesignBlock;
  readonly startFrameId: string;
  readonly onClose: () => void;
  readonly restoreFocus: RefObject<HTMLButtonElement | null>;
}) {
  const slides = block.size === "slide";
  const startIndex = Math.max(
    0,
    block.frames.findIndex((frame) => String(frame.frameId) === startFrameId),
  );
  const [index, setIndex] = useState(startIndex);
  // A restart reloads the page, which is the only way back to the start frame
  // of a page that runs no script.
  const [restarts, setRestarts] = useState(0);
  const [stageRef, stage] = useSize();
  const viewport = CANVAS_DESIGN_VIEWPORT[block.size];
  const scale =
    stage === undefined
      ? 1
      : Math.min(1, stage.width / viewport.width, stage.height / viewport.height);
  const current = block.frames[index];
  const last = block.frames.length - 1;

  const step = (by: number) => setIndex((value) => Math.min(last, Math.max(0, value + by)));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!slides) return;
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      step(-1);
    }
  };

  return (
    <OctantDialog
      className="canvas-design-player"
      label={slides ? `Presenting ${block.title}` : `Playing ${block.title}`}
      onClose={onClose}
      open
      restoreFocus={restoreFocus}
    >
      {/* Keys reach the deck here; a slide frame takes no focus or pointer. */}
      <div className="canvas-design-player__body" onKeyDown={onKeyDown}>
        <header className="canvas-design-player__bar">
          <span className="canvas-design-player__title">{block.title}</span>
          {slides ? (
            <span aria-live="polite" className="canvas-design-player__position">
              {`${String(index + 1)} / ${String(last + 1)}`}
            </span>
          ) : (
            <span className="canvas-design-player__hint">Click links to move between screens</span>
          )}
          <div className="canvas-design-player__actions">
            {slides ? (
              <>
                <OctantButton
                  aria-label="Previous slide"
                  disabled={index === 0}
                  onClick={() => step(-1)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft aria-hidden="true" size={16} strokeWidth={1.8} />
                </OctantButton>
                <OctantButton
                  aria-label="Next slide"
                  disabled={index === last}
                  onClick={() => step(1)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronRight aria-hidden="true" size={16} strokeWidth={1.8} />
                </OctantButton>
              </>
            ) : (
              <OctantButton
                onClick={() => setRestarts((value) => value + 1)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <RotateCcw aria-hidden="true" size={12} strokeWidth={2} />
                Restart
              </OctantButton>
            )}
            <OctantButton
              aria-label="Close"
              onClick={onClose}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={16} strokeWidth={1.8} />
            </OctantButton>
          </div>
        </header>
        <div className="canvas-design-player__stage" ref={stageRef}>
          <div
            className="canvas-design-player__screen"
            style={{ width: viewport.width * scale, height: viewport.height * scale }}
          >
            {slides ? (
              current === undefined ? null : (
                <>
                  <FrameView
                    block={block}
                    frameIds={[String(current.frameId)]}
                    key={String(current.frameId)}
                    scale={scale}
                    still
                    title={`${current.title}, slide ${String(index + 1)}`}
                  />
                  <div aria-hidden="true" className="canvas-design__cover" />
                </>
              )
            ) : (
              <FrameView
                block={block}
                key={restarts}
                scale={scale}
                startFrameId={startFrameId}
                title={`${block.title}, prototype`}
              />
            )}
          </div>
        </div>
      </div>
    </OctantDialog>
  );
}

/**
 * One sandboxed page drawn at its design size and scaled to fit. A `still`
 * page takes no focus; whoever shows it lays a cover over it so the pointer
 * never reaches it either. The page itself must stay hit-testable: Chromium
 * stopped painting sandboxed frames that were `inert` or had
 * `pointer-events: none` until one that took the pointer appeared beside them.
 */
function FrameView({
  block,
  frameIds,
  startFrameId,
  scale,
  title,
  still = false,
}: {
  readonly block: CanvasDesignBlock;
  readonly frameIds?: ReadonlyArray<string>;
  readonly startFrameId?: string;
  readonly scale: number;
  readonly title: string;
  readonly still?: boolean;
}) {
  const viewport = CANVAS_DESIGN_VIEWPORT[block.size];
  return (
    <iframe
      className="canvas-design__page"
      referrerPolicy="no-referrer"
      sandbox=""
      srcDoc={designDocument(block, {
        ...(frameIds === undefined ? {} : { frameIds }),
        ...(startFrameId === undefined ? {} : { startFrameId }),
      })}
      style={{
        width: viewport.width,
        height: viewport.height,
        transform: `scale(${String(scale)})`,
      }}
      tabIndex={still ? -1 : undefined}
      title={title}
    />
  );
}

/**
 * An element's content size, kept current; undefined until measured. A
 * callback ref, because the player's stage mounts inside a dialog after the
 * component that asks for it.
 */
function useSize(): readonly [
  (element: HTMLElement | null) => void,
  { readonly width: number; readonly height: number } | undefined,
] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      if (width > 0) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}
