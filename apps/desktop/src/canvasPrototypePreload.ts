import { ipcRenderer } from "electron";

/**
 * The preload of a running Canvas prototype's page in the prototype host. The
 * page's bridge script posts to `parent`, which for a page of its own is the
 * page's window; this forwards those messages to the host process. It is the
 * only thing that runs here: no API is exposed to the page, and what it
 * forwards is cut down to the three fields a bridge message has, because the
 * page can post anything and the app bounds and checks each claim again.
 *
 * The strings repeat `CANVAS_DESIGN_BRIDGE_CHANNEL` and
 * `CANVAS_PROTOTYPE_PAGE_BRIDGE_CHANNEL`: a sandboxed preload cannot afford to
 * load the contracts package for two constants, and a test holds them equal.
 */
const PAGE_CHANNEL = "octant-design-frame@1";
const HOST_CHANNEL = "octant-canvas-prototype-bridge";
const MAX_TEXT = 1_000;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const record = data as Record<string, unknown>;
  if (record.channel !== PAGE_CHANNEL || typeof record.type !== "string") return;
  ipcRenderer.send(HOST_CHANNEL, {
    channel: PAGE_CHANNEL,
    type: record.type.slice(0, 32),
    ...(typeof record.height === "number" ? { height: record.height } : {}),
    ...(typeof record.message === "string" ? { message: record.message.slice(0, MAX_TEXT) } : {}),
  });
});
