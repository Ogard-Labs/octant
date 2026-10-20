import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import {
  CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS,
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
import {
  readDesignBridgeMessage,
  readDesignBridgePayload,
  RUNNING_DESIGN_FIRST_HEARTBEAT_MS,
  RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS,
  RUNNING_DESIGN_MAX_ERRORS,
  RUNNING_DESIGN_MAX_MESSAGES_PER_SECOND,
  RUNNING_DESIGN_MIN_HEIGHT,
  prepareDesktopSurface,
  RUNNING_DESIGN_SANDBOX,
  type DesignBridgeMessage,
  type DesignRunRuntime,
} from "./designRunningFrame";
import { DesktopPrototypeSurface } from "./DesktopPrototypeSurface";

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
  runRuntime,
}: {
  readonly block: CanvasDesignBlock;
  /** Reaches the host for the design's images; without it they draw as placeholders. */
  readonly assetRuntime?: DesignAssetRuntime;
  /** Reaches the host to run a design that runs script; without it, it cannot run here. */
  readonly runRuntime?: DesignRunRuntime;
}) {
  if (block.runsScript === true) {
    return (
      <RunningDesignBlock
        block={block}
        {...(runRuntime === undefined ? {} : { runtime: runRuntime })}
      />
    );
  }
  return (
    <StaticDesignBlock block={block} {...(assetRuntime === undefined ? {} : { assetRuntime })} />
  );
}

function StaticDesignBlock({
  block,
  assetRuntime,
}: {
  readonly block: CanvasDesignBlock;
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
      data-canvas-design={String(block.blockId)}
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
      data-canvas-design={String(block.blockId)}
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // The browser owns leaving: Esc ends full screen before any key reaches the
  // page, so the state follows the document rather than the toggle.
  useEffect(() => {
    const body = bodyRef.current;
    const sync = () => setFullscreen(document.fullscreenElement === body);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      if (document.fullscreenElement === body)
        void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    // A host that refuses (an embedded view, a denied request) leaves the
    // player in its window, which still works.
    void bodyRef.current?.requestFullscreen?.().catch(() => undefined);
  };
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
      <div className="canvas-design-player__body" onKeyDown={onKeyDown} ref={bodyRef}>
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
              aria-label={fullscreen ? "Leave full screen" : "Full screen"}
              aria-pressed={fullscreen}
              onClick={toggleFullscreen}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              {fullscreen ? (
                <Minimize2 aria-hidden="true" size={16} strokeWidth={1.8} />
              ) : (
                <Maximize2 aria-hidden="true" size={16} strokeWidth={1.8} />
              )}
            </OctantButton>
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

/** Why a running prototype is not running. */
type RunStopReason =
  | { readonly kind: "stopped" }
  | { readonly kind: "unresponsive" }
  | { readonly kind: "navigated" }
  | { readonly kind: "flooded" }
  | { readonly kind: "refused"; readonly reason: string };

type RunState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "running"; readonly url: string }
  | { readonly kind: "stopped"; readonly why: RunStopReason };

const STOPPED_TEXT: Record<Exclude<RunStopReason["kind"], "refused">, string> = {
  stopped: "Stopped.",
  unresponsive: "Stopped because the prototype stopped responding.",
  navigated: "Stopped because the prototype tried to load another page.",
  flooded: "Stopped because the prototype sent too many messages.",
};

/**
 * A design that runs its own script: a prototype a person can click through
 * with state. Its page is served by the host for a single-use ticket. In the
 * desktop app it is drawn from a process of its own with no route out, and when
 * that cannot be made it does not run; in a browser it is drawn in a frame
 * sandboxed to `allow-scripts` alone. Octant's chrome around it says it is
 * running and holds Stop, which the page cannot reach. It is removed and shown
 * as stopped when it misses its heartbeat or loads a second page. In the thread
 * it starts only when the person presses Run; the sidebar may start it when it
 * is shown.
 */
function RunningDesignBlock({
  block,
  runtime,
}: {
  readonly block: CanvasDesignBlock;
  readonly runtime?: DesignRunRuntime;
}) {
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const stopButton = useRef<HTMLButtonElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLElement | null>(null);
  // Each start or stop is a new generation, so a page asked for earlier
  // never replaces what the person did since.
  const generation = useRef(0);

  const run = useCallback(async () => {
    if (runtime === undefined) return;
    generation.current += 1;
    const asked = generation.current;
    setErrors([]);
    setState({ kind: "starting" });
    let next: RunState;
    try {
      // On the desktop's own surface a prototype is asked for only after the
      // desktop has closed that surface's network, whoever built the runtime.
      const prepared =
        runtime.drawnIn === "desktop-surface"
          ? await prepareDesktopSurface()
          : ({ status: "ready" } as const);
      const started =
        prepared.status === "ready"
          ? await runtime.start(String(block.blockId))
          : ({ kind: "refused", reason: prepared.reason } as const);
      next =
        started.kind === "ready"
          ? { kind: "running", url: started.url }
          : { kind: "stopped", why: { kind: "refused", reason: started.reason } };
    } catch {
      next = {
        kind: "stopped",
        why: { kind: "refused", reason: "Octant could not reach the host to run this." },
      };
    }
    if (asked === generation.current) setState(next);
  }, [block.blockId, runtime]);

  // A new version is a new page; the sidebar starts it again on its own. The
  // page is what the design says, not which object says it: the same version
  // read again arrives as a new object, and must not stop a running page.
  const runsOnOpen = runtime?.runsOnOpen === true;
  const page = useMemo(() => JSON.stringify(block), [block]);
  useEffect(() => {
    generation.current += 1;
    setState({ kind: "idle" });
    setErrors([]);
    if (runsOnOpen) void run();
  }, [page, run, runsOnOpen]);

  const stop = useCallback((why: RunStopReason) => {
    generation.current += 1;
    setState((current) =>
      current.kind === "running" || current.kind === "starting"
        ? { kind: "stopped", why }
        : current,
    );
  }, []);
  const reportError = useCallback((message: string) => {
    setErrors((current) => [...current, message].slice(-RUNNING_DESIGN_MAX_ERRORS));
  }, []);

  // The desktop's reserved shortcut is read before anything reaches the page,
  // and hands the keyboard to Stop.
  const leave = useCallback(() => stopButton.current?.focus(), []);

  const contained = runtime?.contained === true;
  const onDesktopSurface = runtime?.drawnIn === "desktop-surface";
  return (
    <section
      aria-label={`${block.title}, ${SIZE_NAME[block.size]} prototype`}
      aria-roledescription="design"
      className="canvas-design"
      data-canvas-design={String(block.blockId)}
    >
      <header className="canvas-design__header">
        <div className="canvas-design__heading">
          <h3 className="canvas-design__title">{block.title}</h3>
          <span className="canvas-design__meta">{`${SIZE_NAME[block.size]} · prototype`}</span>
        </div>
        <div className="canvas-design__run">
          {state.kind === "running" ? (
            <>
              <span className="canvas-design__running" role="status">
                <span aria-hidden="true" className="canvas-design__running-dot" />
                Running
              </span>
              <OctantButton
                onClick={() => {
                  stop({ kind: "stopped" });
                  runButton.current?.focus();
                }}
                ref={stopButton}
                size="sm"
                type="button"
                variant="secondary"
              >
                <Square aria-hidden="true" size={12} strokeWidth={2} />
                Stop
              </OctantButton>
            </>
          ) : runtime === undefined ? null : (
            <OctantButton
              disabled={state.kind === "starting"}
              onClick={() => void run()}
              ref={runButton}
              size="sm"
              type="button"
              variant="secondary"
            >
              <Play aria-hidden="true" size={12} strokeWidth={2} />
              {state.kind === "stopped" ? "Run again" : "Run"}
            </OctantButton>
          )}
        </div>
      </header>
      {runtime === undefined ? (
        <p className="canvas-design__notice">
          This prototype runs its own script, which runs only in Octant.
        </p>
      ) : null}
      {runtime !== undefined && !contained && state.kind !== "running" ? (
        <p className="canvas-design__notice">
          In a browser, a running prototype is not network-contained: if it loads another page, that
          page can reach the network before Octant stops it.
        </p>
      ) : null}
      {/* A page's policy does not cover a peer connection, and a browser has no
          way to stop one, so a prototype there can still connect to another
          computer. The desktop app runs the page in a process with no network
          and no resolver, and the preview browser has no route out either. */}
      {runtime === undefined ? null : contained ? (
        <p className="canvas-design__notice">A prototype runs with no network connection.</p>
      ) : (
        <p className="canvas-design__notice">
          A prototype&apos;s script can still connect to another computer and send what the
          prototype holds. Octant does not block that in a browser.
        </p>
      )}
      {state.kind === "stopped" ? (
        <p className="canvas-design__notice" role="status">
          {state.why.kind === "refused" ? state.why.reason : STOPPED_TEXT[state.why.kind]}
          {/* A browser keeps a spinning page's process for the next frame
              from the same host, so a re-run here can wait behind it. */}
          {state.why.kind === "unresponsive" && !contained
            ? " In a browser, it may not start again in this tab; open Octant in a new tab to run it."
            : null}
        </p>
      ) : null}
      {state.kind === "running" ? (
        <RunningFrame
          block={block}
          onDesktopSurface={onDesktopSurface}
          frameRef={frameRef}
          key={state.url}
          onError={reportError}
          onLeave={leave}
          onStop={stop}
          url={state.url}
        />
      ) : null}
      {errors.length === 0 ? null : (
        <ul aria-label="Prototype script errors" className="canvas-design__errors">
          {errors.map((message, index) => (
            <li key={`${String(index)}:${message}`}>{message}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The watch on a running page's bridge, whatever carries its messages: a page
 * that stops beating for too long, or posts more than a renderer can afford to
 * read, is stopped. `admit` counts one message and says whether to read it;
 * `heard` records a heartbeat.
 */
function useBridgeWatchdog(onStop: (why: RunStopReason) => void) {
  const account = useRef({
    lastBeat: 0,
    beating: false,
    windowStart: 0,
    received: 0,
    flooded: false,
  });
  useEffect(() => {
    const now = Date.now();
    account.current = {
      lastBeat: now,
      beating: false,
      windowStart: now,
      received: 0,
      flooded: false,
    };
    // A hidden tab slows every timer, the page's and this one, so a page is
    // only judged while it can be seen, and gets a full allowance on return.
    const watchdog = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        account.current.lastBeat = Date.now();
        return;
      }
      const allowance = account.current.beating
        ? RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS
        : RUNNING_DESIGN_FIRST_HEARTBEAT_MS;
      if (Date.now() - account.current.lastBeat > allowance) onStop({ kind: "unresponsive" });
    }, CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(watchdog);
  }, [onStop]);
  const admit = useCallback((): boolean => {
    const current = account.current;
    if (current.flooded) return false;
    // Counted before the message is read, so malformed messages flood too.
    const now = Date.now();
    if (now - current.windowStart >= 1_000) {
      current.windowStart = now;
      current.received = 0;
    }
    current.received += 1;
    if (current.received > RUNNING_DESIGN_MAX_MESSAGES_PER_SECOND) {
      current.flooded = true;
      onStop({ kind: "flooded" });
      return false;
    }
    return true;
  }, [onStop]);
  const heard = useCallback(() => {
    account.current.lastBeat = Date.now();
    account.current.beating = true;
  }, []);
  return { admit, heard };
}

/** How wide a running document's page is opened before its column is measured. */
const UNMEASURED_DOCUMENT_WIDTH = 640;

/**
 * The page a running design is drawn as, and its watchdog. In the desktop app
 * it is drawn from the prototype host, a process of its own with no network and
 * no resolver: this names only the host's ticketed page, the main process opens
 * nothing else, and the page's bridge messages arrive as the host's events. In
 * a browser it is a frame. A device size is drawn at its viewport and scaled to
 * the column; a document is as wide as the column and as tall as the page
 * says, within bounds. In a frame, the page's first load is its own; any later
 * load is a page it navigated to, which is removed. The prototype host refuses
 * every navigation itself.
 */
function RunningFrame({
  block,
  url,
  onDesktopSurface,
  frameRef,
  onStop,
  onError,
  onLeave,
}: {
  readonly block: CanvasDesignBlock;
  readonly url: string;
  readonly onDesktopSurface: boolean;
  readonly frameRef: RefObject<HTMLElement | null>;
  readonly onStop: (why: RunStopReason) => void;
  readonly onError: (message: string) => void;
  readonly onLeave: () => void;
}) {
  const [height, setHeight] = useState(RUNNING_DESIGN_MIN_HEIGHT);
  const loads = useRef(0);
  const [stageRef, stage] = useSize();
  const { admit, heard } = useBridgeWatchdog(onStop);
  const attach = useCallback(
    (node: HTMLElement | null) => {
      frameRef.current = node;
    },
    [frameRef],
  );
  const take = useCallback(
    (message: DesignBridgeMessage | undefined) => {
      if (message === undefined) return;
      if (message.type === "heartbeat") heard();
      else if (message.type === "size") setHeight(message.height);
      else onError(message.message);
    },
    [heard, onError],
  );
  const countLoad = useCallback(() => {
    loads.current += 1;
    if (loads.current > 1) onStop({ kind: "navigated" });
  }, [onStop]);

  // A frame in a browser posts to this window; only its own window counts.
  useEffect(() => {
    if (onDesktopSurface) return;
    const onMessage = (event: MessageEvent) => {
      const element = frameRef.current;
      const page = element instanceof HTMLIFrameElement ? element.contentWindow : null;
      if (page === null || event.source !== page || !admit()) return;
      take(readDesignBridgeMessage(event, page));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [admit, onDesktopSurface, frameRef, take]);

  // The prototype host has no window to post to: its page's bridge messages
  // arrive as the host's events, and so does a page that went away.
  const onBridge = useCallback(
    (payload: unknown) => {
      if (admit()) take(readDesignBridgePayload(payload));
    },
    [admit, take],
  );
  const onGone = useCallback(() => onStop({ kind: "unresponsive" }), [onStop]);

  const frame = (
    style: CSSProperties,
    className: string,
    page: { readonly width: number; readonly height: number },
  ) =>
    onDesktopSurface ? (
      <DesktopPrototypeSurface
        attach={attach}
        className={className}
        height={page.height}
        onBridge={onBridge}
        onGone={onGone}
        onLeave={onLeave}
        src={url}
        style={style}
        title={`${block.title}, running prototype`}
        width={page.width}
      />
    ) : (
      <iframe
        className={className}
        onLoad={countLoad}
        ref={attach}
        referrerPolicy="no-referrer"
        sandbox={RUNNING_DESIGN_SANDBOX}
        src={url}
        style={style}
        title={`${block.title}, running prototype`}
      />
    );

  if (block.size === "document") {
    const width = Math.round(stage?.width ?? UNMEASURED_DOCUMENT_WIDTH);
    return (
      <div ref={stageRef}>
        {frame(
          onDesktopSurface ? { width: "100%", height } : { height },
          "canvas-design__document",
          { width, height },
        )}
      </div>
    );
  }
  const viewport = CANVAS_DESIGN_VIEWPORT[block.size];
  const scale = stage === undefined ? 1 : Math.min(1, stage.width / viewport.width);
  return (
    <div className="canvas-design__stage" ref={stageRef}>
      <div
        className="canvas-design__preview"
        style={{ width: viewport.width * scale, height: viewport.height * scale }}
      >
        {frame(
          {
            width: viewport.width,
            height: viewport.height,
            transform: `scale(${String(scale)})`,
          },
          "canvas-design__page",
          viewport,
        )}
      </div>
    </div>
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
    // Increased contrast needs no listener of its own: the Settings toggle and
    // the system preference publish `data-octant-increased-contrast` on the
    // root, which the observer above sees. A system light/dark switch moves no
    // attribute while the theme follows the system, so that one is listened for.
    const systemDark =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : undefined;
    systemDark?.addEventListener("change", read);
    return () => {
      observer.disconnect();
      systemDark?.removeEventListener("change", read);
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
