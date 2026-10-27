/**
 * Agent control of a desktop that is only a screen: the `octant_computer`
 * commands translated onto its frames, its input, and a way to start a sent
 * file. Any driver whose desktop has no accessibility tree may use it; the
 * host-local and cloud drivers do.
 *
 * An app is a file the host sent into the desktop's inbox; it has one
 * "window", the whole screen, and an observation is a screenshot of that
 * screen with no elements. So clicks are points on the screenshot, typed
 * text and keys go to whatever the last click focused, and a command
 * addressed to an element refuses `unsupported`. Approvals, the session cap,
 * and journaling stay with the host; this only translates.
 */
import {
  decodeComputerControlResult,
  type ComputerControlCommand,
  type ComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import type { DesktopInputEvent, DesktopRecipe } from "@octant/contracts";
import type { DesktopFrameResult, DesktopInputResult } from "./desktopProvider";

/** How a desktop started a sent file, or why it could not. */
export type ScreenshotDesktopLaunch =
  | { readonly status: "launched"; readonly pid: number }
  | { readonly status: "failed" }
  | { readonly status: "unreachable" };

/** What control needs of one running desktop. */
export interface ScreenshotDesktopSurface {
  readonly screen: DesktopRecipe["screen"];
  /** Starts the sent file `appId` from the inbox, detached, and names its process. */
  readonly launch: (appId: string) => Promise<ScreenshotDesktopLaunch>;
  /** Whether the process a launch named still runs. */
  readonly alive: (pid: number) => Promise<"running" | "gone" | "unreachable">;
  readonly frame: () => Promise<DesktopFrameResult>;
  readonly input: (event: DesktopInputEvent) => Promise<DesktopInputResult>;
}

/** An app id is a sent file's name; only names the command set can carry are offered. */
export const SCREENSHOT_DESKTOP_APP_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
/** The one window an app has: the desktop's whole screen. */
const SCREEN_WINDOW_ID = 1;
/** Observations a desktop remembers; an older one answers `stale-observation`. */
const MAX_OBSERVATIONS = 64;
/** The most base64 an observation image may carry (`ComputerUseImage`). */
const MAX_IMAGE_BASE64 = 2_097_152;
/** Pixels one scroll step moves, as a Desktop tab's wheel does. */
const SCROLL_PIXELS_PER_STEP = 100;
/** Characters one text input carries (`DesktopInputEvent`). */
const MAX_TEXT_PER_INPUT = 4_096;

const refused = (reason: string, message: string): ComputerControlResult => ({
  kind: "refused",
  reason,
  message,
});
const failed = (reason: string, message: string): ComputerControlResult => ({
  kind: "failed",
  reason,
  message,
});
const NOT_RUNNING = refused(
  "app-not-running",
  "The app is not running. Launch it again, then observe it.",
);
const DESKTOP_UNREACHABLE = failed(
  "desktop-unavailable",
  "The desktop stopped answering. Release it and lease another.",
);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export class ScreenshotDesktopControl {
  readonly #surface: ScreenshotDesktopSurface;
  /** Files the host sent into the inbox; only these may launch. */
  readonly #sent = new Set<string>();
  /** Each launched app's process on the desktop. */
  readonly #launched = new Map<string, number>();
  /** Which app each recent observation showed. */
  readonly #observations = new Map<string, string>();

  constructor(surface: ScreenshotDesktopSurface) {
    this.#surface = surface;
  }

  /** A transfer landed in the inbox under `name`. */
  sent(name: string): void {
    this.#sent.add(name);
  }

  async control(command: ComputerControlCommand): Promise<ComputerControlResult> {
    switch (command.operation) {
      case "apps":
        return decodeComputerControlResult({
          kind: "apps",
          apps: [...this.#sent]
            .filter((name) => SCREENSHOT_DESKTOP_APP_ID.test(name))
            .slice(0, 256)
            .map((name) => ({ appId: name, name })),
        });
      case "launch":
        return this.#launch(command.appId);
      case "windows": {
        const alive = await this.#alive(command.appId);
        if (alive === "unreachable") return DESKTOP_UNREACHABLE;
        return this.#windows(command.appId, alive === "running");
      }
      case "observe": {
        if (command.windowId !== SCREEN_WINDOW_ID)
          return refused("stale-window", "List the app's windows again before observing.");
        const alive = await this.#alive(command.appId);
        if (alive === "unreachable") return DESKTOP_UNREACHABLE;
        if (alive === "gone") return NOT_RUNNING;
        return this.#observe(command.appId);
      }
      case "click":
      case "type":
      case "press":
      case "scroll":
        return this.#act(command);
      case "stop":
        return { kind: "stopped" };
    }
  }

  async #launch(appId: string): Promise<ComputerControlResult> {
    if (!this.#sent.has(appId) || !SCREENSHOT_DESKTOP_APP_ID.test(appId))
      return refused("not-sent", "Send the app with send-file before launching it.");
    const launched = await this.#surface.launch(appId);
    if (launched.status === "unreachable") return DESKTOP_UNREACHABLE;
    if (
      launched.status !== "launched" ||
      !Number.isSafeInteger(launched.pid) ||
      launched.pid < 1 ||
      launched.pid > 999_999_999
    )
      return failed("launch-failed", "The desktop could not start the app.");
    this.#launched.set(appId, launched.pid);
    return this.#windows(appId, true);
  }

  async #alive(appId: string): Promise<"running" | "gone" | "unreachable"> {
    const pid = this.#launched.get(appId);
    if (pid === undefined) return "gone";
    const alive = await this.#surface.alive(pid);
    if (alive === "gone") this.#launched.delete(appId);
    return alive;
  }

  #windows(appId: string, running: boolean): ComputerControlResult {
    return decodeComputerControlResult({
      kind: "windows",
      appId,
      windows: running
        ? [{ windowId: SCREEN_WINDOW_ID, title: `${appId} on the disposable desktop` }]
        : [],
    });
  }

  async #observe(appId: string): Promise<ComputerControlResult> {
    const frame = await this.#surface.frame();
    if (frame.status === "not-connected") return DESKTOP_UNREACHABLE;
    if (frame.status !== "frame")
      return failed("screenshot-unavailable", "The desktop could not take a screenshot.");
    const data = base64(frame.frame.bytes);
    if (data.length > MAX_IMAGE_BASE64)
      return failed("screenshot-too-large", "The desktop's screenshot is too large to return.");
    const observationId = globalThis.crypto.randomUUID();
    if (this.#observations.size >= MAX_OBSERVATIONS) {
      const oldest = this.#observations.keys().next().value;
      if (oldest !== undefined) this.#observations.delete(oldest);
    }
    this.#observations.set(observationId, appId);
    return decodeComputerControlResult({
      kind: "observation",
      observationId,
      appId,
      windowId: SCREEN_WINDOW_ID,
      elements: [],
      truncated: false,
      image: { mimeType: frame.frame.mediaType, data },
      imageWidth: frame.frame.width,
      imageHeight: frame.frame.height,
    });
  }

  async #act(
    command: Extract<ComputerControlCommand, { operation: "click" | "type" | "press" | "scroll" }>,
  ): Promise<ComputerControlResult> {
    if ("elementIndex" in command)
      return refused(
        "unsupported",
        "This desktop has no accessibility elements. Click with x and y on the screenshot, then type or press without elementIndex.",
      );
    const appId = this.#observations.get(String(command.observationId));
    if (appId === undefined)
      return refused("stale-observation", "Observe the app again before acting.");
    const alive = await this.#alive(appId);
    if (alive === "unreachable") return DESKTOP_UNREACHABLE;
    if (alive === "gone") return NOT_RUNNING;
    const events = this.#inputsFor(command);
    if (events === undefined)
      return refused("invalid-image-position", "Use a position inside the latest screenshot.");
    for (const event of events) {
      const sent = await this.#surface.input(event);
      if (sent.status === "not-connected") return DESKTOP_UNREACHABLE;
      if (sent.status !== "delivered")
        return failed("input-failed", "The desktop did not take the input.");
    }
    return this.#observe(appId);
  }

  #inputsFor(
    command: Exclude<
      Extract<ComputerControlCommand, { operation: "click" | "type" | "press" | "scroll" }>,
      { readonly elementIndex: number }
    >,
  ): ReadonlyArray<DesktopInputEvent> | undefined {
    const { width, height } = this.#surface.screen;
    switch (command.operation) {
      case "click":
        if (command.x >= width || command.y >= height) return undefined;
        return [
          { kind: "pointer", action: "move", x: command.x, y: command.y },
          { kind: "pointer", action: "down", button: "left", x: command.x, y: command.y },
          { kind: "pointer", action: "up", button: "left", x: command.x, y: command.y },
        ];
      case "type": {
        // One screen input carries at most this many characters, as a Desktop
        // tab's does; longer text crosses in order, a piece at a time.
        const characters = Array.from(command.text);
        const pieces: Array<DesktopInputEvent> = [];
        for (let start = 0; start < characters.length; start += MAX_TEXT_PER_INPUT) {
          pieces.push({
            kind: "text",
            text: characters.slice(start, start + MAX_TEXT_PER_INPUT).join(""),
          });
        }
        return pieces;
      }
      case "press": {
        // The screen takes the key names a Desktop tab sends; `Return` is Enter there.
        const key = command.key === "Return" ? "Enter" : command.key;
        return [
          { kind: "key", action: "down", key },
          { kind: "key", action: "up", key },
        ];
      }
      case "scroll": {
        const step = command.amount * SCROLL_PIXELS_PER_STEP;
        const delta = command.direction === "up" || command.direction === "left" ? -step : step;
        const vertical = command.direction === "up" || command.direction === "down";
        return [
          {
            kind: "scroll",
            x: Math.floor(width / 2),
            y: Math.floor(height / 2),
            deltaX: vertical ? 0 : delta,
            deltaY: vertical ? delta : 0,
          },
        ];
      }
    }
  }
}

/** DOM key names a Desktop tab sends, as the X keysyms `xdotool` takes. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  " ": "space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  Shift: "Shift_L",
  Control: "Control_L",
  Alt: "Alt_L",
  Meta: "Super_L",
  CapsLock: "Caps_Lock",
  "-": "minus",
  "=": "equal",
  "[": "bracketleft",
  "]": "bracketright",
  ";": "semicolon",
  "'": "apostrophe",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  "`": "grave",
};

/**
 * The X keysym for a key name a Desktop tab sends, or undefined for one no X
 * desktop maps. The set is closed, so only known keysyms reach a desktop.
 */
export function x11Keysym(key: string): string | undefined {
  // An own property only: `constructor` or `toString` would otherwise name
  // an inherited function, whose source text would reach the desktop.
  if (Object.hasOwn(NAMED_KEYS, key)) return NAMED_KEYS[key];
  if (/^[A-Za-z0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  return undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Reads a PNG's dimensions from its header without decoding it, so a frame
 * larger than the screen is refused before anything parses its pixels.
 */
export function pngDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The most bytes one frame of `screen` may carry: an uncompressed 32-bit
 * image of the whole screen with its row filter bytes, plus room for PNG's
 * own framing.
 */
export function maxDesktopFrameBytes(screen: DesktopRecipe["screen"]): number {
  return screen.width * screen.height * 4 + screen.height + 1_048_576;
}
