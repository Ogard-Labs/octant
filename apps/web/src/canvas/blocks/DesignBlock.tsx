import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { ChevronLeft, ChevronRight, Play, RotateCcw, X } from "lucide-react";
import {
  CANVAS_DESIGN_VIEWPORT,
  type CanvasDesignAssetResolution,
  type CanvasDesignBlock,
  type CanvasDesignDeviceSize,
  type CanvasDesignSize,
} from "@octant/contracts/canvas";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import {
  designAssetUrls,
  designDocument,
  designFrameSandbox,
  designFrameTheme,
  readWorkspaceFrameTheme,
  type DesignAssetRuntime,
  type DesignFrameThemeValues,
} from "./designDocument";
import { installFrameFonts } from "./designFrameFonts";

const SIZE_NAME: Record<CanvasDesignSize, string> = {
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
  slide: "Slide",
  document: "Document",
};

/** How wide a frame is drawn on the board before the board runs out of room. */
const BOARD_FRAME_WIDTH: Record<CanvasDesignDeviceSize, number> = {
  phone: 200,
  tablet: 260,
  desktop: 440,
  slide: 440,
};

/**
 * How tall a document frame may grow before it scrolls inside itself. Past
 * this a page is no longer read in place, and an unbounded frame would let one
 * page make the Canvas as tall as the browser allows.
 */
export const DESIGN_DOCUMENT_MAX_HEIGHT = 12_000;
const DESIGN_DOCUMENT_MIN_HEIGHT = 48;

/**
 * Screens of an app or site, or the slides of a deck, side by side. Each frame
 * is a picture here; Play (or Present, for slides) opens the design at full
 * size, where its links work. A document is read in place instead, as wide as
 * the Canvas and as tall as its page.
 */
export function DesignBlock({
  block,
  assetRuntime,
}: {
  readonly block: CanvasDesignBlock;
  /** Reaches the host for the design's images; without it they draw as placeholders. */
  readonly assetRuntime?: DesignAssetRuntime;
}) {
  const theme = useWorkspaceFrameTheme(designFrameTheme(block) === "workspace");
  const assetUrls = useDesignAssetUrls(block, assetRuntime);
  const frame = { theme, assetUrls };
  if (block.size === "document") return <DesignDocumentBlock block={block} frame={frame} />;
  return <DesignBoard block={block} size={block.size} frame={frame} />;
}

/** What every frame of one design is drawn with: the theme and the images. */
interface DesignFrameInputs {
  readonly theme: DesignFrameThemeValues | undefined;
  readonly assetUrls: ReadonlyMap<string, string>;
}

/**
 * Where each of a design's declared images is drawn from. The host is asked
 * once each time the design is drawn, so what a reader sees follows the
 * host's authority now; until it answers, and when it cannot, each image is a
 * placeholder that says why.
 */
function useDesignAssetUrls(
  block: CanvasDesignBlock,
  runtime: DesignAssetRuntime | undefined,
): ReadonlyMap<string, string> {
  const declared = (block.assets ?? []).length > 0;
  const [resolved, setResolved] = useState<ReadonlyArray<CanvasDesignAssetResolution> | undefined>(
    undefined,
  );
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    setResolved(undefined);
    setAnswered(false);
    if (!declared || runtime === undefined) return;
    let current = true;
    runtime
      .resolve(String(block.blockId))
      .then((assets) => {
        if (!current) return;
        setResolved(assets);
        setAnswered(true);
      })
      .catch(() => {
        if (current) setAnswered(true);
      });
    return () => {
      current = false;
    };
  }, [block, declared, runtime]);
  return useMemo(
    () =>
      designAssetUrls(
        block,
        resolved,
        runtime === undefined || answered ? "not-loaded" : "loading",
      ),
    [answered, block, resolved, runtime],
  );
}

function DesignDocumentBlock({
  block,
  frame,
}: {
  readonly block: CanvasDesignBlock;
  readonly frame: DesignFrameInputs;
}) {
  return (
    <section
      aria-label={`${block.title}, document`}
      aria-roledescription="design"
      className="canvas-design"
    >
      <header className="canvas-design__header">
        <div className="canvas-design__heading">
          <h3 className="canvas-design__title">{block.title}</h3>
        </div>
      </header>
      <DocumentFrame block={block} frame={frame} />
    </section>
  );
}

function DesignBoard({
  block,
  size,
  frame: inputs,
}: {
  readonly block: CanvasDesignBlock;
  readonly size: CanvasDesignDeviceSize;
  readonly frame: DesignFrameInputs;
}) {
  const slides = size === "slide";
  const [playing, setPlaying] = useState<string | undefined>(undefined);
  const playButton = useRef<HTMLButtonElement>(null);
  const [boardRef, board] = useSize();
  const boardWidth = board?.width;
  const viewport = CANVAS_DESIGN_VIEWPORT[size];
  const frameWidth = Math.min(BOARD_FRAME_WIDTH[size], boardWidth ?? Infinity);
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
                size={size}
                still
                scale={scale}
                frame={inputs}
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
          size={size}
          startFrameId={playing}
          frame={inputs}
        />
      )}
    </section>
  );
}

function DesignPlayer({
  block,
  size,
  frame: inputs,
  startFrameId,
  onClose,
  restoreFocus,
}: {
  readonly block: CanvasDesignBlock;
  readonly size: CanvasDesignDeviceSize;
  readonly frame: DesignFrameInputs;
  readonly startFrameId: string;
  readonly onClose: () => void;
  readonly restoreFocus: RefObject<HTMLButtonElement | null>;
}) {
  const slides = size === "slide";
  const startIndex = Math.max(
    0,
    block.frames.findIndex((frame) => String(frame.frameId) === startFrameId),
  );
  const [index, setIndex] = useState(startIndex);
  // A restart reloads the page, which is the only way back to the start frame
  // of a page that runs no script.
  const [restarts, setRestarts] = useState(0);
  const [stageRef, stage] = useSize();
  const viewport = CANVAS_DESIGN_VIEWPORT[size];
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
                    size={size}
                    still
                    frame={inputs}
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
                size={size}
                startFrameId={startFrameId}
                frame={inputs}
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
  size,
  frame: { theme, assetUrls },
  frameIds,
  startFrameId,
  scale,
  title,
  still = false,
}: {
  readonly block: CanvasDesignBlock;
  readonly size: CanvasDesignDeviceSize;
  readonly frame: DesignFrameInputs;
  readonly frameIds?: ReadonlyArray<string>;
  readonly startFrameId?: string;
  readonly scale: number;
  readonly title: string;
  readonly still?: boolean;
}) {
  const viewport = CANVAS_DESIGN_VIEWPORT[size];
  // Keyed by the ids, not the array, so a parent's new array of the same ids
  // does not reload the page. A frame id never holds a line break.
  const frameKey = frameIds?.join("\n");
  const srcDoc = useMemo(
    () =>
      designDocument(block, {
        ...(frameKey === undefined ? {} : { frameIds: frameKey.split("\n") }),
        ...(startFrameId === undefined ? {} : { startFrameId }),
        ...(theme === undefined ? {} : { theme }),
        assetUrls,
      }),
    [assetUrls, block, frameKey, startFrameId, theme],
  );
  const themed = designFrameTheme(block) === "workspace";
  return (
    <iframe
      className="canvas-design__page"
      onLoad={themed ? (event) => installFrameFonts(event.currentTarget) : undefined}
      referrerPolicy="no-referrer"
      sandbox={designFrameSandbox(block)}
      srcDoc={srcDoc}
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
 * A document's page, as wide as the Canvas and as tall as its content. The
 * frame is same-origin and runs no script, so the host reads the page's height
 * itself and follows it as fonts arrive, the column narrows, or a tab opens.
 * Past the height cap the page scrolls inside the frame.
 */
function DocumentFrame({
  block,
  frame: { theme, assetUrls },
}: {
  readonly block: CanvasDesignBlock;
  readonly frame: DesignFrameInputs;
}) {
  const [height, setHeight] = useState(DESIGN_DOCUMENT_MIN_HEIGHT);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  const srcDoc = useMemo(
    () => designDocument(block, { ...(theme === undefined ? {} : { theme }), assetUrls }),
    [assetUrls, block, theme],
  );
  const themed = designFrameTheme(block) === "workspace";

  const onLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget;
    observer.current?.disconnect();
    observer.current = null;
    if (themed) installFrameFonts(frame);
    const page = frame.contentDocument;
    const body = page?.body;
    if (page === null || page === undefined || body === null || body === undefined) return;
    const measure = () => {
      const content = Math.ceil(body.getBoundingClientRect().height);
      page.documentElement.style.overflowY =
        content > DESIGN_DOCUMENT_MAX_HEIGHT ? "auto" : "hidden";
      setHeight(
        Math.min(DESIGN_DOCUMENT_MAX_HEIGHT, Math.max(DESIGN_DOCUMENT_MIN_HEIGHT, content)),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver(measure);
    next.observe(body);
    observer.current = next;
  };

  return (
    <iframe
      className="canvas-design__document"
      onLoad={onLoad}
      referrerPolicy="no-referrer"
      sandbox={designFrameSandbox(block)}
      srcDoc={srcDoc}
      style={{ height }}
      title={`${block.title}, document`}
    />
  );
}

/**
 * The workspace theme a themed frame is drawn in, kept current: the theme
 * writes its tokens and mode onto the root element, so a change there redraws
 * the frame in the new theme. Undefined when no frame here is themed.
 */
function useWorkspaceFrameTheme(enabled: boolean): DesignFrameThemeValues | undefined {
  const [theme, setTheme] = useState<DesignFrameThemeValues | undefined>(() =>
    enabled ? readWorkspaceFrameTheme(document.documentElement) : undefined,
  );
  useEffect(() => {
    if (!enabled) {
      setTheme(undefined);
      return;
    }
    const root = document.documentElement;
    let last = "";
    const read = () => {
      const next = readWorkspaceFrameTheme(root);
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      setTheme((current) => (JSON.stringify(current) === key ? current : next));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true });
    // The Contrast theme is the system's increased-contrast preference: the
    // stylesheet swaps the text roles under `prefers-contrast: more` and no
    // attribute on the root moves, so the frame listens for it as well.
    const preferences =
      typeof window.matchMedia === "function"
        ? [
            window.matchMedia("(prefers-color-scheme: dark)"),
            window.matchMedia("(prefers-contrast: more)"),
          ]
        : [];
    for (const preference of preferences) preference.addEventListener("change", read);
    return () => {
      observer.disconnect();
      for (const preference of preferences) preference.removeEventListener("change", read);
    };
  }, [enabled]);
  return theme;
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
