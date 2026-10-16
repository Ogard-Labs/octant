import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { getInjectedHostBridge } from "../../shell/hostBridge";

/**
 * A running prototype in the desktop app, drawn from the prototype host.
 *
 * The page runs in a process of its own with no network and no resolver (see
 * the desktop's prototype host). That process draws it offscreen and sends its
 * pixels here, through the main process, and this paints them on a canvas the
 * size of the page. The person's pointer, wheel, and keys on the canvas are
 * forwarded in the page's own pixels. Nothing here runs the page's script, so
 * the reserved shortcut is read before anything is forwarded and the page can
 * never keep the keyboard.
 */

/** What the prototype host reported for one prototype, once checked. */
export type DesktopPrototypeEvent =
  | {
      readonly kind: "frame";
      readonly frameWidth: number;
      readonly frameHeight: number;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly pixels: Uint8Array;
    }
  | { readonly kind: "bridge"; readonly payload: unknown }
  | { readonly kind: "cursor"; readonly cursor: string }
  | { readonly kind: "gone" };

/** A frame no larger than the largest page at twice its pixels. */
const MAX_FRAME_SIDE = 24_000;

function whole(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

/**
 * The event for this prototype, or `undefined` for another prototype's or a
 * malformed one. A frame's rectangle must lie inside the frame and carry
 * exactly its pixels.
 */
export function readDesktopPrototypeEvent(
  value: unknown,
  surfaceId: string,
): DesktopPrototypeEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.surfaceId !== surfaceId) return undefined;
  switch (event.kind) {
    case "gone":
      return { kind: "gone" };
    case "bridge":
      return { kind: "bridge", payload: event.payload };
    case "cursor":
      return typeof event.cursor === "string"
        ? { kind: "cursor", cursor: event.cursor }
        : undefined;
    case "frame": {
      const { frameWidth, frameHeight, x, y, width, height, pixels } = event;
      if (!whole(frameWidth, 1, MAX_FRAME_SIDE) || !whole(frameHeight, 1, MAX_FRAME_SIDE)) {
        return undefined;
      }
      if (!whole(x, 0, frameWidth) || !whole(y, 0, frameHeight)) return undefined;
      if (!whole(width, 0, frameWidth - x) || !whole(height, 0, frameHeight - y)) return undefined;
      if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 4) return undefined;
      return { kind: "frame", frameWidth, frameHeight, x, y, width, height, pixels };
    }
    default:
      return undefined;
  }
}

/**
 * Whether a message claims to be a frame of this prototype, well formed or
 * not. The host sends the next frame only once the window says it drew this
 * one, so even a frame that is not drawn is answered.
 */
function isFrameOf(value: unknown, surfaceId: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return event.kind === "frame" && event.surfaceId === surfaceId;
}

/** The cursors a page may show; anything else shows the default. */
const CURSORS: Readonly<Record<string, string>> = {
  default: "default",
  pointer: "pointer",
  hand: "pointer",
  text: "text",
  crosshair: "crosshair",
  wait: "wait",
  progress: "progress",
  help: "help",
  move: "move",
  grab: "grab",
  grabbing: "grabbing",
  "not-allowed": "not-allowed",
  nodrop: "no-drop",
  "col-resize": "col-resize",
  "row-resize": "row-resize",
  "ew-resize": "ew-resize",
  "ns-resize": "ns-resize",
  "e-resize": "e-resize",
  "w-resize": "w-resize",
  "n-resize": "n-resize",
  "s-resize": "s-resize",
  "zoom-in": "zoom-in",
  "zoom-out": "zoom-out",
  copy: "copy",
  cell: "cell",
  none: "none",
};

/** Keys whose DOM name differs from the name the prototype host takes. */
const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
};
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  ...Array.from({ length: 24 }, (_, index) => `F${String(index + 1)}`),
]);

/** The key the host takes for a DOM key, or `undefined` for a modifier or an unknown key. */
export function prototypeKeyCode(key: string): string | undefined {
  const renamed = KEY_NAMES[key];
  if (renamed !== undefined) return renamed;
  if (NAMED_KEYS.has(key)) return key;
  return [...key].length === 1 ? key : undefined;
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

/** Command-Escape on macOS, Control-Escape elsewhere: it leaves the prototype. */
export function isReservedPrototypeKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac = isMac(),
): boolean {
  if (event.key !== "Escape" || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

const EDIT_KEYS: Readonly<Record<string, string>> = {
  c: "copy",
  x: "cut",
  v: "paste",
  a: "selectAll",
  z: "undo",
};

function modifiersOf(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): ReadonlyArray<string> {
  return [
    ...(event.shiftKey ? ["shift"] : []),
    ...(event.ctrlKey ? ["control"] : []),
    ...(event.altKey ? ["alt"] : []),
    ...(event.metaKey ? ["meta"] : []),
  ];
}

const BUTTONS = ["left", "middle", "right"] as const;

/** The pixels each wheel line stands for, when the wheel counts lines. */
const WHEEL_LINE_PX = 16;

export function DesktopPrototypeSurface({
  src,
  width,
  height,
  className,
  style,
  title,
  attach,
  onBridge,
  onGone,
  onLeave,
}: {
  readonly src: string;
  /** The page's size in its own pixels. */
  readonly width: number;
  readonly height: number;
  readonly className: string;
  readonly style: CSSProperties;
  readonly title: string;
  readonly attach: (node: HTMLElement | null) => void;
  readonly onBridge: (payload: unknown) => void;
  readonly onGone: () => void;
  /** The person pressed the reserved shortcut to leave the prototype. */
  readonly onLeave: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [surfaceId] = useState(() => crypto.randomUUID());
  const [cursor, setCursor] = useState("default");
  // The latest callbacks and size, so a new render does not reopen the page.
  const latest = useRef({ onBridge, onGone, width, height });
  latest.current = { onBridge, onGone, width, height };

  // Opening redeems the page's single-use ticket, so the page is opened once
  // for this element. An effect that is cleaned up and run again at once, as
  // React's development checks do, keeps it open rather than asking again.
  const openedSrc = useRef<string | undefined>(undefined);
  const closing = useRef(false);
  useEffect(() => {
    const bridge = getInjectedHostBridge();
    const subscribe = bridge?.subscribeCanvasPrototypeEvents;
    const open = bridge?.openCanvasPrototype;
    if (subscribe === undefined || open === undefined) {
      latest.current.onGone();
      return;
    }
    let live = true;
    closing.current = false;
    const unsubscribe = subscribe((value) => {
      if (!live) return;
      const event = readDesktopPrototypeEvent(value, surfaceId);
      if (event?.kind === "gone") latest.current.onGone();
      else if (event?.kind === "bridge") latest.current.onBridge(event.payload);
      else if (event?.kind === "cursor") setCursor(CURSORS[event.cursor] ?? "default");
      else if (event?.kind === "frame") paint(canvasRef.current, event);
      if (isFrameOf(value, surfaceId)) {
        void bridge?.acknowledgeCanvasPrototypeFrame?.(surfaceId).catch(() => undefined);
      }
    });
    if (openedSrc.current !== src) {
      openedSrc.current = src;
      const scaleFactor = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
      void open({
        surfaceId,
        src,
        width: Math.round(latest.current.width),
        height: Math.round(latest.current.height),
        scaleFactor,
      }).then(
        (result) => {
          if (!closing.current && result.status !== "open") latest.current.onGone();
        },
        () => {
          if (!closing.current) latest.current.onGone();
        },
      );
    }
    return () => {
      live = false;
      unsubscribe();
      closing.current = true;
      queueMicrotask(() => {
        if (!closing.current) return;
        openedSrc.current = undefined;
        void bridge?.closeCanvasPrototype?.(surfaceId).catch(() => undefined);
      });
    };
  }, [src, surfaceId]);

  // The page grows with what it reports, as a frame does.
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    void getInjectedHostBridge()
      ?.resizeCanvasPrototype?.(surfaceId, Math.round(width), Math.round(height))
      .catch(() => undefined);
  }, [surfaceId, width, height]);

  const send = (input: Record<string, unknown>) => {
    void getInjectedHostBridge()
      ?.sendCanvasPrototypeInput?.(surfaceId, input)
      .catch(() => undefined);
  };

  /** A point on the canvas in the page's own pixels, whatever the canvas is scaled to. */
  const at = (event: Pick<MouseEvent, "clientX" | "clientY">) => {
    const box = canvasRef.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0 || box.height === 0) {
      return { x: event.clientX, y: event.clientY };
    }
    return {
      x: ((event.clientX - box.left) * width) / box.width,
      y: ((event.clientY - box.top) * height) / box.height,
    };
  };

  const pointer =
    (type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseEnter" | "mouseLeave") =>
    (event: MouseEvent<HTMLCanvasElement>) => {
      send({
        type,
        ...at(event),
        button: BUTTONS[event.button] ?? "left",
        clickCount: type === "mouseDown" || type === "mouseUp" ? Math.min(3, event.detail) : 0,
        modifiers: modifiersOf(event),
      });
    };

  // A wheel over the prototype scrolls the prototype, not the Canvas around it,
  // which needs a listener React does not make passive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : 1;
      send({
        type: "mouseWheel",
        ...at(event),
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        modifiers: modifiersOf(event),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (isReservedPrototypeKey(event)) {
      onLeave();
      return;
    }
    const command = isMac() ? event.metaKey : event.ctrlKey;
    const edit = command ? EDIT_KEYS[event.key.toLowerCase()] : undefined;
    if (edit !== undefined) {
      send({ type: "edit", command: edit === "undo" && event.shiftKey ? "redo" : edit });
      return;
    }
    const keyCode = prototypeKeyCode(event.key);
    if (keyCode === undefined) return;
    const modifiers = modifiersOf(event);
    send({ type: "keyDown", keyCode, modifiers });
    // A printable key also types its character, unless a shortcut modifier
    // makes it a command.
    if ([...event.key].length === 1 && !event.ctrlKey && !event.metaKey) {
      send({ type: "char", keyCode: event.key, modifiers });
    }
  };
  const onKeyUp = (event: KeyboardEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const keyCode = prototypeKeyCode(event.key);
    if (keyCode !== undefined) send({ type: "keyUp", keyCode, modifiers: modifiersOf(event) });
  };

  return (
    <canvas
      aria-label={title}
      aria-roledescription="running prototype"
      className={className}
      onBlur={() => send({ type: "blur" })}
      onContextMenu={(event) => event.preventDefault()}
      onFocus={() => send({ type: "focus" })}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onMouseDown={pointer("mouseDown")}
      onMouseEnter={pointer("mouseEnter")}
      onMouseLeave={pointer("mouseLeave")}
      onMouseMove={pointer("mouseMove")}
      onMouseUp={pointer("mouseUp")}
      ref={(node) => {
        canvasRef.current = node;
        attach(node);
      }}
      role="application"
      style={{ ...style, cursor }}
      tabIndex={0}
      title={title}
    />
  );
}

/** Paints a changed rectangle; a frame of a new size starts the canvas over. */
function paint(
  canvas: HTMLCanvasElement | null,
  frame: Extract<DesktopPrototypeEvent, { kind: "frame" }>,
): void {
  if (canvas === null || frame.width === 0 || frame.height === 0) return;
  if (canvas.width !== frame.frameWidth || canvas.height !== frame.frameHeight) {
    canvas.width = frame.frameWidth;
    canvas.height = frame.frameHeight;
  }
  const context = canvas.getContext("2d");
  if (context === null) return;
  const pixels = new Uint8ClampedArray(frame.pixels);
  context.putImageData(new ImageData(pixels, frame.width, frame.height), frame.x, frame.y);
}
