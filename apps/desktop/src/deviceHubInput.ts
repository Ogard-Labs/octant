import type { SimulatorInputCommand } from "@octant/contracts/computer-use-plugin";

/**
 * Xcode 27 shows a booted Simulator only through Device Hub, an agent app
 * whose device window carries the iOS accessibility bridge. These are the
 * pure parts of driving that window: where the screen sits inside it, which
 * elements belong to the device rather than to Device Hub's own chrome, and
 * how typed text and named keys become driver key presses.
 */
export const DEVICE_HUB_APP_ID = "com.apple.dt.Devices";
const DEVICE_HUB_APP_NAMES = new Set(["Device Hub", "DeviceHub"]);

export function deviceWindowUrl(udid: string): string {
  return `devices://device/open?id=${encodeURIComponent(udid)}`;
}

export function isDeviceHubWindow(
  window: Readonly<Record<string, unknown>>,
  deviceName: string,
): boolean {
  return (
    typeof window.app_name === "string" &&
    DEVICE_HUB_APP_NAMES.has(window.app_name) &&
    typeof window.title === "string" &&
    window.title.startsWith(deviceName) &&
    window.is_on_screen !== false
  );
}

export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

// Device Hub 27.0 draws a 52 px bar above and below the bezel, and the bezel
// is about 2 % of the screen height thick at any window size (16 px around a
// 793 px screen in a 429×929 window). Measured, not documented, so a tap is
// only ever resolved to an accessible element that contains the mapped point;
// a miss is a named refusal, never a blind pointer event.
const BAR_HEIGHT = 52;
const BEZEL_RATIO = 16 / 793;

/** Where the device screen sits inside the window, in window-local pixels. */
export function deviceScreenRect(window: Size, frame: Size): Rect {
  const aspect = frame.width / frame.height;
  const availableHeight = window.height - 2 * BAR_HEIGHT;
  let height = availableHeight / (1 + 2 * BEZEL_RATIO);
  let width = height * aspect;
  if (width * (1 + (2 * BEZEL_RATIO) / aspect) > window.width) {
    width = window.width / (1 + (2 * BEZEL_RATIO) / aspect);
    height = width / aspect;
  }
  const bezel = BEZEL_RATIO * height;
  return {
    x: (window.width - width) / 2,
    y: BAR_HEIGHT + bezel + (availableHeight - height - 2 * bezel) / 2,
    width,
    height,
  };
}

/** A screenshot pixel mapped into the window the screenshot's screen is drawn in. */
export function windowPointFor(
  point: { readonly x: number; readonly y: number },
  frame: Size,
  screen: Rect,
): { readonly x: number; readonly y: number } {
  return {
    x: screen.x + (point.x / frame.width) * screen.width,
    y: screen.y + (point.y / frame.height) * screen.height,
  };
}

export interface DeviceElement {
  readonly index: number;
  readonly role: string;
  readonly label: string;
  readonly frame: Rect;
}

const CHROME_ROLES = new Set([
  "AXWindow",
  "AXToolbar",
  "AXMenuBar",
  "AXMenu",
  "AXMenuItem",
  "AXMenuBarItem",
  "AXMenuButton",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localFrame(
  element: Record<string, unknown>,
  windowOrigin: { readonly x: number; readonly y: number },
): Rect | undefined {
  const frame = element.frame;
  if (
    !record(frame) ||
    typeof frame.x !== "number" ||
    typeof frame.y !== "number" ||
    typeof frame.w !== "number" ||
    typeof frame.h !== "number"
  )
    return undefined;
  return {
    x: frame.x - windowOrigin.x,
    y: frame.y - windowOrigin.y,
    width: frame.w,
    height: frame.h,
  };
}

/**
 * The pressable elements the iOS bridge exposes, in window-local pixels.
 * Device Hub's own controls live in the 52 px bars above and below the bezel
 * (toolbar, Home, Screenshot, Record, Rotate) and are left out, so a device tap
 * can never start a recording.
 */
export function deviceElements(
  elements: ReadonlyArray<unknown>,
  window: Rect,
): ReadonlyArray<DeviceElement> {
  const records = elements.filter(record);
  const toolbars = new Set(
    records
      .filter((element) => element.role === "AXToolbar")
      .map((element) => element.element_index),
  );
  return records.flatMap((element) => {
    const frame = localFrame(element, window);
    if (
      typeof element.element_index !== "number" ||
      typeof element.role !== "string" ||
      CHROME_ROLES.has(element.role) ||
      toolbars.has(element.parent_index) ||
      !Array.isArray(element.actions) ||
      !element.actions.includes("AXPress") ||
      frame === undefined ||
      frame.y + frame.height <= BAR_HEIGHT ||
      frame.y >= window.height - BAR_HEIGHT
    )
      return [];
    return [
      {
        index: element.element_index,
        role: element.role,
        label: typeof element.label === "string" ? element.label : "",
        frame,
      },
    ];
  });
}

/** The smallest device element under a window-local point. */
export function elementAtPoint(
  elements: ReadonlyArray<DeviceElement>,
  point: { readonly x: number; readonly y: number },
): DeviceElement | undefined {
  return elements
    .filter(
      (element) =>
        point.x >= element.frame.x &&
        point.x <= element.frame.x + element.frame.width &&
        point.y >= element.frame.y &&
        point.y <= element.frame.y + element.frame.height,
    )
    .sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0];
}

/** An exact label match first, then the first element whose label contains the target. */
export function elementForTarget(
  elements: ReadonlyArray<DeviceElement>,
  target: string,
): DeviceElement | undefined {
  const wanted = target.trim().toLowerCase();
  return (
    elements.find((element) => element.label.trim().toLowerCase() === wanted) ??
    elements.find((element) => element.label.toLowerCase().includes(wanted))
  );
}

/**
 * Device Hub's own button of that label (its toolbar is English on every
 * locale seen). Only a button inside the bars above and below the bezel
 * counts: the device's tree comes first in a snapshot, and an app with its own
 * "Home" button must never be pressed in place of the hardware control.
 */
export function chromeButtonIndex(
  elements: ReadonlyArray<unknown>,
  window: Rect,
  label: string,
): number | undefined {
  const button = elements.filter(record).find((element) => {
    const frame = localFrame(element, window);
    return (
      element.role === "AXButton" &&
      element.label === label &&
      typeof element.element_index === "number" &&
      frame !== undefined &&
      (frame.y + frame.height <= BAR_HEIGHT || frame.y >= window.height - BAR_HEIGHT)
    );
  });
  return typeof button?.element_index === "number" ? button.element_index : undefined;
}

export interface KeyPress {
  readonly key: string;
  readonly modifiers?: ReadonlyArray<"shift">;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  return: "return",
  enter: "return",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  delete: "delete",
  backspace: "delete",
  space: "space",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
};

/** The device Home button is Device Hub chrome, not a keyboard key. */
export const HOME_KEY = "home";

export function driverKeyFor(key: string): string | undefined {
  return NAMED_KEYS[
    key
      .trim()
      .toLowerCase()
      .replace(/[-_\s]/g, "")
  ];
}

/**
 * Letters, digits, space and newline go as key presses, which is what a
 * hardware keyboard sends and what the bridge delivers on QWERTY hosts.
 * Anything else depends on the Mac's keyboard layout when synthesized (a
 * Norwegian layout turned "-" into "+"), so it is refused by name instead.
 */
export function keyPressesFor(text: string):
  | { readonly kind: "presses"; readonly presses: ReadonlyArray<KeyPress> }
  | {
      readonly kind: "unsupported";
      readonly characters: ReadonlyArray<string>;
    } {
  const presses: KeyPress[] = [];
  const unsupported = new Set<string>();
  for (const character of text) {
    if (/^[a-z0-9]$/.test(character)) presses.push({ key: character });
    else if (/^[A-Z]$/.test(character))
      presses.push({ key: character.toLowerCase(), modifiers: ["shift"] });
    else if (character === " ") presses.push({ key: "space" });
    else if (character === "\n") presses.push({ key: "return" });
    else unsupported.add(character);
  }
  if (unsupported.size > 0)
    return { kind: "unsupported", characters: [...unsupported].slice(0, 8) };
  return { kind: "presses", presses };
}

/**
 * What one key press costs end to end: the driver confirms each press before
 * the next, and nine presses took 12.7 s on the packaged app. Text that cannot
 * finish inside the action's deadline is refused before the first key.
 */
export const KEY_PRESS_COST_MS = 1_300;

export function fitsKeyPressBudget(presses: number, budgetMs: number): boolean {
  return presses * KEY_PRESS_COST_MS <= budgetMs;
}

export type SimulatorTap = Extract<SimulatorInputCommand, { readonly kind: "tap" }>;
