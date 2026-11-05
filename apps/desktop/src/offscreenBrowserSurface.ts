import {
  MAX_HUMAN_FRAME_WIDTH,
  MAX_HUMAN_FRAME_HEIGHT,
} from "@octant/contracts/browser-presentation";
import { BrowserWindow } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_EDITABLE_PRELOAD_FILENAME } from "./runtimePaths";
import { ownBrowserTextInput } from "./browserTextInput";
import { readBrowserEditableTarget } from "./browserEditableTarget";
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
      preload: resolve(dirname(fileURLToPath(import.meta.url)), BROWSER_EDITABLE_PRELOAD_FILENAME),
      offscreen: false,
      backgroundThrottling: false,
    },
  });
  const caret = ownBrowserTextInput(window);
  let shown = false;
  let generation = 0;
  let capturing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frameListener: Parameters<HumanBrowserSource["frames"]>[0] | undefined;
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
  const capture = () => {
    if (
      !shown ||
      frameListener === undefined ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      capturing
    )
      return;
    capturing = true;
    const epoch = generation;
    void window.webContents
      .capturePage({ x: 0, y: 0, width, height }, { stayHidden: true, stayAwake: true })
      .then((image) => {
        if (epoch !== generation || !shown || frameListener === undefined) return;
        const raw = image.getSize();
        if (
          !Number.isInteger(raw.width) ||
          !Number.isInteger(raw.height) ||
          raw.width < 1 ||
          raw.height < 1 ||
          raw.width * raw.height > MAX_HUMAN_FRAME_WIDTH * MAX_HUMAN_FRAME_HEIGHT * 4
        )
          return;
        const frame =
          raw.width === width && raw.height === height
            ? image
            : image.resize({ width, height, quality: "good" });
        try {
          frameListener(frame);
        } catch {
          console.warn("Octant could not retain an embedded Browser frame.");
        }
      })
      .catch(() => {})
      .finally(() => {
        capturing = false;
        if (shown && frameListener !== undefined && !window.isDestroyed())
          timer = setTimeout(capture, 100);
      });
  };
  const human: HumanBrowserSource = {
    frames(listener) {
      frameListener = listener;
      capture();
      return () => {
        if (frameListener === listener) frameListener = undefined;
      };
    },
    visible(visible) {
      if (window.isDestroyed()) return;
      shown = visible;
      generation++;
      clearTimeout(timer);
      if (visible) {
        window.webContents.focus();
        capture();
      } else release();
    },
    async editor() {
      if (!shown || window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
      const epoch = generation;
      const target = await readBrowserEditableTarget((world, scripts) =>
        window.webContents.executeJavaScriptInIsolatedWorld(world, [...scripts]),
      );
      if (target === undefined || epoch !== generation || !shown) return undefined;
      const rect = caret.read(target.selectionStart, target.selectionEnd);
      // The public range lookup can round-trip through Chromium. Re-observe
      // the same field and selection after it, without reading field contents.
      const after = await readBrowserEditableTarget((world, scripts) =>
        window.webContents.executeJavaScriptInIsolatedWorld(world, [...scripts]),
      );
      if (
        rect === undefined ||
        after?.id !== target.id ||
        after.selectionStart !== target.selectionStart ||
        after.selectionEnd !== target.selectionEnd ||
        epoch !== generation ||
        !shown
      )
        return undefined;
      return { ...target, caret: rect };
    },
    bounds(nextWidth, nextHeight) {
      generation++;
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
      shown = false;
      generation++;
      clearTimeout(timer);
      frameListener = undefined;
      caret.close();
      if (!window.isDestroyed()) window.destroy();
    },
    setBounds(bounds) {
      human.bounds(bounds.width, bounds.height);
    },
    setVisible: human.visible,
    webContents: window.webContents,
  };
}
