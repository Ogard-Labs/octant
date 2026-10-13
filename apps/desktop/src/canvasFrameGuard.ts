import { CANVAS_DESIGN_PAGE_PATH } from "@octant/contracts/canvas";

/**
 * What the desktop holds the app window's frames to, now that a running Canvas
 * prototype is not drawn in one.
 *
 * A running prototype lives in a surface of its own with no route out (see
 * `canvasPrototypeSurface.ts`). The app window therefore never has a reason to
 * load the host's design page into a frame, and none may: a frame there would
 * run agent script with the window's own network. Every frame navigation to
 * that page is cancelled, so a renderer that fell back to a frame, or was made
 * to, shows nothing instead of an uncontained prototype.
 *
 * The renderer also refuses non-proxied UDP. It is not a boundary for a page
 * (it left a TCP route open), and a window that draws no prototype has no use
 * for peer connections.
 *
 * Electron 43 already runs a sandboxed frame out of the renderer's process, but
 * by default Chromium keeps every sandboxed frame of one site in one process.
 * One process per sandboxed document keeps a frame that spins from holding the
 * next one drawn from the same host.
 */

export const CANVAS_FRAME_PROCESS_FEATURE = "IsolateSandboxedIframes:grouping/per-document";

export interface CommandLinePort {
  readonly hasSwitch: (name: string) => boolean;
  readonly getSwitchValue: (name: string) => string;
  readonly appendSwitch: (name: string, value?: string) => void;
}

/** Gives each sandboxed document its own process, keeping any features already asked for. */
export function isolateEachCanvasFrameDocument(commandLine: CommandLinePort): void {
  const existing = commandLine.hasSwitch("enable-features")
    ? commandLine.getSwitchValue("enable-features")
    : "";
  commandLine.appendSwitch(
    "enable-features",
    existing === "" ? CANVAS_FRAME_PROCESS_FEATURE : `${existing},${CANVAS_FRAME_PROCESS_FEATURE}`,
  );
}

export interface CanvasFrameNavigation {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly preventDefault: () => void;
}

export interface CanvasFrameGuardWebContentsPort {
  readonly onFrameNavigate: (listener: (navigation: CanvasFrameNavigation) => void) => void;
  readonly setWebRTCIPHandlingPolicy: (policy: "disable_non_proxied_udp") => void;
}

export interface CanvasFrameGuardOptions {
  /** The host the renderer reaches now; it can change when the host restarts. */
  readonly serverUrl: () => string | undefined;
}

export function installCanvasFrameGuards(
  contents: CanvasFrameGuardWebContentsPort,
  options: CanvasFrameGuardOptions,
): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  const isDesignPage = (value: string): boolean => {
    const server = options.serverUrl();
    if (server === undefined) return false;
    try {
      const url = new URL(value);
      return url.origin === new URL(server).origin && url.pathname === CANVAS_DESIGN_PAGE_PATH;
    } catch {
      return false;
    }
  };
  contents.onFrameNavigate((navigation) => {
    // The top-level document has its own guard; this one is for frames.
    if (navigation.isMainFrame) return;
    if (isDesignPage(navigation.url)) navigation.preventDefault();
  });
}
