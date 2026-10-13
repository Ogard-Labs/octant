import type { CanvasClient, CanvasDesignRunStart } from "@octant/client-runtime/canvas-client";
import {
  CANVAS_DESIGN_BRIDGE_CHANNEL,
  CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH,
  CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS,
  type CanvasId,
} from "@octant/contracts/canvas";
import {
  getInjectedHostBridge,
  type CanvasPrototypeSurfacePreparation,
} from "../../shell/hostBridge";

/**
 * How a running design is held.
 *
 * The page is served by the host under a policy that runs its inline script
 * and loads nothing. In a browser it is drawn in a frame that repeats the
 * sandbox: `allow-scripts` and no other token, so the page's origin is opaque
 * and it cannot reach Octant's page, storage, or cookies, navigate the app,
 * open a window, submit a form, or raise a dialog. In the desktop app it is
 * drawn in a surface of its own with no route out instead (see the desktop's
 * prototype surface), because a page policy does not cover WebRTC. The page
 * talks back only through a bridge the host wrote first in it; every message is
 * a claim the page could forge, so each is checked and bounded here and none of
 * them can do anything but resize the frame, report an error, or keep it alive.
 */
export const RUNNING_DESIGN_SANDBOX = "allow-scripts";

/** A page that has sent no heartbeat for this long is stopped. */
export const RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS = 5 * CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS;
/** A new page has this long to send its first heartbeat, while it loads. */
export const RUNNING_DESIGN_FIRST_HEARTBEAT_MS = 10 * CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS;
export const RUNNING_DESIGN_MIN_HEIGHT = 48;
export const RUNNING_DESIGN_MAX_HEIGHT = 12_000;
/** How many of a page's latest script errors are kept on screen. */
export const RUNNING_DESIGN_MAX_ERRORS = 3;
/**
 * A page that sends more bridge messages than this in a second is stopped.
 * Every message is handled on Octant's own renderer thread, so a page posting
 * in a loop could starve the window that holds Stop, although its own frame
 * runs elsewhere. A page that resizes and reports an error on every animation
 * frame stays well under it.
 */
export const RUNNING_DESIGN_MAX_MESSAGES_PER_SECOND = 250;

/**
 * How a surface reaches the host to run a design, and two separate facts about
 * it.
 *
 * `contained` is what the person is told: the prototype has no route out, so
 * there is no warning about connecting to another computer. The desktop app and
 * the agent's preview browser are contained.
 *
 * `drawnIn` is how the page is drawn, which is not the same question. The
 * desktop app draws it on its own surface (`desktop-surface`), a webview its
 * main process makes and holds to the host's page; the preview browser and a
 * web browser draw a frame (`frame`), because only the desktop app has that
 * surface. A runtime that draws on the desktop surface is never run before the
 * desktop has prepared it, whoever built the runtime.
 *
 * `runsOnOpen` lets the sidebar start a prototype as soon as it is shown; the
 * thread waits for Run.
 */
export interface DesignRunRuntime {
  readonly start: (blockId: string, frameId?: string) => Promise<CanvasDesignRunStart>;
  readonly contained: boolean;
  readonly drawnIn: DesignDrawnIn;
  readonly runsOnOpen: boolean;
}

export type DesignDrawnIn = "desktop-surface" | "frame";

/**
 * Where a prototype is drawn in the client this code runs in: the desktop
 * app's own surface there, a frame anywhere else. The one place that decides,
 * so a runtime built for a snapshot cannot disagree with one built for a live
 * Canvas.
 */
export function designDrawnInHere(): DesignDrawnIn {
  return runsInDesktopApp() ? "desktop-surface" : "frame";
}

/**
 * The run runtime for one Canvas version on a surface, or `undefined` when the
 * host cannot serve prototypes. Only the desktop app can close a prototype's
 * network, so only there is one contained, and there it is drawn on the
 * desktop's surface, never in a frame.
 */
export function designRunRuntimeFor(
  client: Pick<CanvasClient, "runDesign"> | undefined,
  input: { readonly canvasId: CanvasId; readonly versionId: string; readonly runsOnOpen: boolean },
): DesignRunRuntime | undefined {
  if (client?.runDesign === undefined) return undefined;
  const drawnIn = designDrawnInHere();
  return {
    start: async (blockId, frameId) => {
      const started = await client.runDesign?.({
        canvasId: input.canvasId,
        versionId: input.versionId,
        blockId,
        ...(frameId === undefined ? {} : { frameId }),
      });
      return started ?? { kind: "refused", reason: "This host does not run prototypes." };
    },
    contained: drawnIn === "desktop-surface",
    drawnIn,
    runsOnOpen: input.runsOnOpen,
  };
}

/**
 * Asks the desktop to close the network of the surface a prototype is drawn
 * on. Any failure is a refusal with its reason; nothing falls back to a frame.
 */
export async function prepareDesktopSurface(): Promise<CanvasPrototypeSurfacePreparation> {
  const unavailable = (reason: string): CanvasPrototypeSurfacePreparation => ({
    status: "unavailable",
    reason,
  });
  try {
    const prepare = getInjectedHostBridge()?.prepareCanvasPrototypeSurface;
    if (prepare === undefined) {
      return unavailable("This version of Octant cannot contain a prototype, so it does not run.");
    }
    return await prepare();
  } catch {
    return unavailable("Octant could not start the prototype surface, so it does not run.");
  }
}

export function runsInDesktopApp(): boolean {
  try {
    return getInjectedHostBridge() !== undefined;
  } catch {
    return false;
  }
}

export type DesignBridgeMessage =
  | { readonly type: "heartbeat" }
  | { readonly type: "size"; readonly height: number }
  | { readonly type: "error"; readonly message: string };

/**
 * The bridge message a frame's page sent, or `undefined` for anything else.
 * Only a message from this frame's own window counts, posted by an opaque
 * origin, on the bridge's channel, with a known type and fields of the right
 * kind; a height is clamped and an error's text is cut to length.
 */
export function readDesignBridgeMessage(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  frame: Window | null | undefined,
): DesignBridgeMessage | undefined {
  if (frame === null || frame === undefined || event.source !== frame) return undefined;
  if (event.origin !== "null") return undefined;
  return readDesignBridgePayload(event.data);
}

/**
 * The bridge message in a payload, whoever delivered it: the channel, a known
 * type, and fields of the right kind. In the desktop app the surface's preload
 * delivers it, so there is no window or origin to check; the payload is still
 * only a claim the page made.
 */
export function readDesignBridgePayload(data: unknown): DesignBridgeMessage | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.channel !== CANVAS_DESIGN_BRIDGE_CHANNEL) return undefined;
  switch (record.type) {
    case "heartbeat":
      return { type: "heartbeat" };
    case "size": {
      const height = record.height;
      if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
      return {
        type: "size",
        height: Math.min(
          RUNNING_DESIGN_MAX_HEIGHT,
          Math.max(RUNNING_DESIGN_MIN_HEIGHT, Math.ceil(height)),
        ),
      };
    }
    case "error": {
      const message = record.message;
      if (typeof message !== "string") return undefined;
      const trimmed = message.trim();
      return {
        type: "error",
        message:
          trimmed.length === 0
            ? "Script error"
            : trimmed.length > CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH
              ? `${trimmed.slice(0, CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH - 1)}…`
              : trimmed,
      };
    }
    default:
      return undefined;
  }
}
