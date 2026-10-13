import { ipcRenderer } from "electron";

/**
 * The preload of a running Canvas prototype's surface. The page's bridge
 * script posts to `parent`, which in a surface of its own is the page's window;
 * this forwards those messages to the embedding window. It is the only thing
 * that runs here: no API is exposed to the page, and what it forwards is cut
 * down to the three fields a bridge message has, because the page can post
 * anything and the embedder bounds and checks each claim again.
 *
 * The strings repeat `CANVAS_DESIGN_BRIDGE_CHANNEL` and
 * `CANVAS_DESIGN_SURFACE_BRIDGE_EVENT`: a sandboxed preload cannot afford to load
 * the contracts package for two constants, and a test holds them equal.
 */
const PAGE_CHANNEL = "octant-design-frame@1";
const EMBEDDER_EVENT = "octant-canvas-prototype-bridge";
const MAX_TEXT = 1_000;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const record = data as Record<string, unknown>;
  if (record.channel !== PAGE_CHANNEL || typeof record.type !== "string") return;
  ipcRenderer.sendToHost(EMBEDDER_EVENT, {
    channel: PAGE_CHANNEL,
    type: record.type.slice(0, 32),
    ...(typeof record.height === "number" ? { height: record.height } : {}),
    ...(typeof record.message === "string" ? { message: record.message.slice(0, MAX_TEXT) } : {}),
  });
});
