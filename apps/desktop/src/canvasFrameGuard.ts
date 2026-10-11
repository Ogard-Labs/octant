/**
 * What the desktop holds a running Canvas prototype to, beyond its sandbox.
 *
 * A prototype's page runs agent script in a frame sandboxed to
 * `allow-scripts` alone, under a policy that loads nothing. Two things that
 * policy cannot govern are the frame setting its own `location`, which loads a
 * page under that page's own policy, and WebRTC, which no content policy
 * reaches. A web page cannot stop either; the desktop can, for its own
 * renderer:
 *
 * - every navigation of a running frame is cancelled except the first, to its
 *   ticketed page on this host. A frame is known by its frame tree node, which
 *   keeps its id when the page rewrites its own address with `history`;
 * - the renderer refuses non-proxied UDP, so a page cannot open a peer
 *   connection around the network policy;
 * - one shortcut is read before any frame sees the key: Command-Escape on
 *   macOS, Control-Escape elsewhere. While a running frame holds focus it is
 *   swallowed and the renderer moves focus to that frame's own controls, so a
 *   page that swallows Tab cannot keep the keyboard.
 *
 * Electron 43 already runs a sandboxed frame out of the renderer's process, so
 * a page in an infinite loop leaves Octant responsive. By default, though,
 * Chromium keeps every sandboxed frame of one site in one process, and
 * removing a looping frame does not end that process: the next prototype from
 * the host was put in the same spinning process and never loaded. One process
 * per sandboxed document lets Run again start clean.
 */

/** The page path a running prototype is served from on the host. */
const DESIGN_PAGE_PATH = "/api/canvas/design-page";

export const CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL = "octant:canvas:frame-focus-escape";

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

export interface CanvasFrameGuardFrame {
  readonly frameTreeNodeId: number;
  readonly url: string;
}

export interface CanvasFrameNavigation {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly frame: CanvasFrameGuardFrame | null;
  readonly preventDefault: () => void;
}

export interface CanvasFrameKeyInput {
  readonly type: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface CanvasFrameGuardWebContentsPort {
  readonly onFrameNavigate: (listener: (navigation: CanvasFrameNavigation) => void) => void;
  readonly onKeyInput: (
    listener: (event: { readonly preventDefault: () => void }, input: CanvasFrameKeyInput) => void,
  ) => void;
  readonly focusedFrame: () => CanvasFrameGuardFrame | null;
  readonly send: (channel: string) => void;
  readonly setWebRTCIPHandlingPolicy: (policy: "disable_non_proxied_udp") => void;
}

export interface CanvasFrameGuardOptions {
  /** The host the renderer reaches now; it can change when the host restarts. */
  readonly serverUrl: () => string | undefined;
  readonly platform: NodeJS.Platform;
}

export function installCanvasFrameGuards(
  contents: CanvasFrameGuardWebContentsPort,
  options: CanvasFrameGuardOptions,
): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  const running = new Set<number>();
  const hostUrl = (value: string): URL | undefined => {
    const server = options.serverUrl();
    if (server === undefined) return undefined;
    try {
      const url = new URL(value);
      return url.origin === new URL(server).origin ? url : undefined;
    } catch {
      return undefined;
    }
  };
  const isDesignPage = (value: string): boolean => hostUrl(value)?.pathname === DESIGN_PAGE_PATH;
  // Octant draws static designs from `srcdoc`, so a frame whose address is on
  // the host is a running page, wherever `history` has since moved it.
  const isRunning = (frame: CanvasFrameGuardFrame): boolean =>
    running.has(frame.frameTreeNodeId) || hostUrl(frame.url) !== undefined;

  contents.onFrameNavigate((navigation) => {
    // The top-level document has its own guard; this one is for frames.
    if (navigation.isMainFrame) return;
    const frame = navigation.frame;
    if (frame === null) {
      if (isDesignPage(navigation.url)) navigation.preventDefault();
      return;
    }
    if (isRunning(frame)) {
      navigation.preventDefault();
      return;
    }
    if (!isDesignPage(navigation.url)) return;
    // Only a frame that has loaded nothing yet may open a ticketed page, and
    // from then on it is a running frame.
    if (frame.url !== "" && frame.url !== "about:blank") {
      navigation.preventDefault();
      return;
    }
    running.add(frame.frameTreeNodeId);
  });

  contents.onKeyInput((event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape" || input.alt || input.shift) return;
    const reserved =
      options.platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
    if (!reserved) return;
    const focused = contents.focusedFrame();
    if (focused === null || !isRunning(focused)) return;
    event.preventDefault();
    contents.send(CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL);
  });
}
