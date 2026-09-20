/** A pointer position in the window's own coordinates, and when it was there. */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  readonly atMs: number;
}

/** Where the device's screen is drawn in the window. */
export interface DrawnScreen {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type DevicePoint = { readonly x: number; readonly y: number };

export type SimulatorGesture =
  | { readonly kind: "tap"; readonly point: DevicePoint }
  | {
      readonly kind: "swipe";
      readonly from: DevicePoint;
      readonly to: DevicePoint;
      readonly durationMs: number;
    };

/** A finger that moved less than this between press and release meant a tap. */
const TAP_SLOP_PX = 10;
const SHORTEST_SWIPE_MS = 80;
const LONGEST_SWIPE_MS = 2_000;

/**
 * What a press and a release on the drawn screen mean to the device. Both are
 * given in the device's own pixels: frames are scaled for the pane, so the
 * drawn size says nothing about where a point is on the device.
 */
export function gestureFrom(
  down: PointerSample,
  up: PointerSample,
  drawn: DrawnScreen,
  screen: { readonly width: number; readonly height: number },
): SimulatorGesture | undefined {
  if (drawn.width <= 0 || drawn.height <= 0) return undefined;
  const inside =
    down.x >= drawn.left &&
    down.x <= drawn.left + drawn.width &&
    down.y >= drawn.top &&
    down.y <= drawn.top + drawn.height;
  // A press that began beside the screen was not a touch on the device.
  if (!inside) return undefined;
  const onDevice = (sample: PointerSample): DevicePoint => ({
    x: Math.round((clamp(sample.x - drawn.left, 0, drawn.width) / drawn.width) * screen.width),
    y: Math.round((clamp(sample.y - drawn.top, 0, drawn.height) / drawn.height) * screen.height),
  });
  if (Math.hypot(up.x - down.x, up.y - down.y) < TAP_SLOP_PX) {
    return { kind: "tap", point: onDevice(down) };
  }
  return {
    kind: "swipe",
    from: onDevice(down),
    // A drag that ran off the screen ends where the finger left it.
    to: onDevice(up),
    durationMs: Math.round(clamp(up.atMs - down.atMs, SHORTEST_SWIPE_MS, LONGEST_SWIPE_MS)),
  };
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "return",
  Backspace: "delete",
  Escape: "escape",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * What a key pressed on the focused screen means to the device, or nothing
 * when the key belongs to the app: a shortcut, a bare modifier, or Tab, which
 * has to keep moving focus out of the screen.
 */
export function keyIntentFor(event: {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}):
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "key"; readonly key: string }
  | undefined {
  if (event.metaKey === true || event.ctrlKey === true) return undefined;
  const named = NAMED_KEYS[event.key];
  if (named !== undefined) return { kind: "key", key: named };
  if ([...event.key].length === 1) return { kind: "text", text: event.key };
  return undefined;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
