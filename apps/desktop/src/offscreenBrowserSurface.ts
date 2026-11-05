import {
  MAX_HUMAN_FRAME_WIDTH,
  MAX_HUMAN_FRAME_HEIGHT,
} from "@octant/contracts/browser-presentation";
import { BrowserWindow } from "electron";
import type { BrowserSurfaceHostOptions, BrowserSurfaceViewPort } from "./browserSurfaceHost";
import type { HumanBrowserSource } from "./browserPresentation";

/** The owning Stable process alone creates and opens the profile partition. */
export function createOffscreenBrowserSurface(
  options: Parameters<BrowserSurfaceHostOptions["createView"]>[0],
): BrowserSurfaceViewPort {
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: options.partition,
      ...options.webPreferences,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setFrameRate(15);
  let width = 800;
  let height = 600;
  const heldKeys = new Set<string>();
  const heldButtons = new Map<"left" | "middle" | "right", { x: number; y: number }>();
  const release = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    for (const keyCode of heldKeys) window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    for (const button of heldButtons.keys())
      window.webContents.sendInputEvent({ type: "mouseUp", button, x: -1, y: -1, clickCount: 1 });
    heldKeys.clear();
    heldButtons.clear();
  };
  const human: HumanBrowserSource = {
    frames(listener) {
      const paint = (
        _event: Electron.Event,
        _dirty: Electron.Rectangle,
        image: Electron.NativeImage,
      ) => {
        const raw = image.getSize();
        if (
          !Number.isInteger(raw.width) ||
          !Number.isInteger(raw.height) ||
          raw.width < 1 ||
          raw.height < 1 ||
          raw.width * raw.height > MAX_HUMAN_FRAME_WIDTH * MAX_HUMAN_FRAME_HEIGHT * 4
        )
          return;
        // Encode CSS-sized pixels; sendInputEvent uses these same CSS coordinates.
        const frame =
          raw.width === width && raw.height === height
            ? image
            : image.resize({ width, height, quality: "good" });
        try {
          listener(frame);
        } catch {
          console.warn("Octant could not retain an embedded Browser frame.");
        }
      };
      window.webContents.on("paint", paint);
      window.webContents.invalidate();
      return () => window.webContents.removeListener("paint", paint);
    },
    visible(visible) {
      if (window.isDestroyed()) return;
      if (visible) {
        window.webContents.startPainting();
        window.webContents.invalidate();
      } else {
        release();
        window.webContents.stopPainting();
      }
    },
    bounds(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      if (!window.isDestroyed()) window.setContentSize(width, height);
    },
    input(input) {
      if (input.type === "keyDown") heldKeys.add(input.keyCode);
      if (input.type === "keyUp") heldKeys.delete(input.keyCode);
      if (input.type === "mouseDown") heldButtons.set(input.button, { x: input.x, y: input.y });
      if (input.type === "mouseUp") heldButtons.delete(input.button);
      const { modifiers, ...event } = input;
      window.webContents.sendInputEvent({
        ...event,
        ...(modifiers === undefined ? {} : { modifiers: [...modifiers] }),
      });
    },
  };
  return {
    human,
    close: () => {
      if (!window.isDestroyed()) window.destroy();
    },
    setBounds(bounds) {
      human.bounds(bounds.width, bounds.height);
    },
    setVisible: human.visible,
    webContents: window.webContents,
  };
}
