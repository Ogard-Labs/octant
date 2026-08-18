import { useEffect, useRef, useState } from "react";
import type { BrowserSurfaceState, OctantHostBridge } from "../shell/hostBridge";

/**
 * Integer bounds for the native surface that never leave the window: the
 * host refuses a view whose edge lies outside its content area, and rounding
 * each side independently can push the right or bottom edge one pixel past it.
 * The top stays below the traffic-light strip the host reserves.
 */
export function boundsInsideViewport(
  rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
  viewportWidth: number,
  viewportHeight: number,
) {
  const maxRight = Math.max(1, Math.floor(viewportWidth));
  const maxBottom = Math.max(37, Math.floor(viewportHeight));
  const x = Math.min(Math.max(0, Math.floor(rect.left)), maxRight - 1);
  const y = Math.min(Math.max(36, Math.floor(rect.top)), maxBottom - 1);
  const right = Math.min(Math.max(x + 1, Math.floor(rect.right)), maxRight);
  const bottom = Math.min(Math.max(y + 1, Math.floor(rect.bottom)), maxBottom);
  return { x, y, width: right - x, height: bottom - y };
}

export interface NativeBrowserSurfaceInput {
  readonly hostBridge?: OctantHostBridge;
  /** The context to show, or undefined while there is nothing to attach. */
  readonly contextId?: string;
  readonly threadId?: string;
  /** Whether this surface should be on screen at all right now. */
  readonly enabled: boolean;
  /**
   * Renderer chrome that must not be covered. A native view is a sibling of
   * the whole window rather than a node in the document, so nothing the
   * renderer draws can be painted over it; while any of these is up the
   * surface leaves the window instead of sitting on top of a dialog.
   */
  readonly overlaySelector: string;
}

export interface NativeBrowserSurface {
  /** Attach the element this ref lands on; its rectangle places the page. */
  readonly mount: React.RefObject<HTMLDivElement | null>;
  readonly state: BrowserSurfaceState | undefined;
  readonly failed: boolean;
  readonly retry: () => void;
  /** Adopt a state the caller got back from a command, such as a tab switch. */
  readonly adopt: (state: BrowserSurfaceState) => void;
}

/**
 * Keep a native browsing surface sitting exactly where a renderer element is.
 *
 * The page is a real window-level view placed by absolute bounds, so it has to
 * be told where the element went on every resize, scroll, and layout change,
 * and taken out of the window entirely whenever the element is not on screen.
 * Attaching can also finish after the element is gone, so an attach that lands
 * late detaches instead of leaving a page floating over the shell.
 */
export function useNativeBrowserSurface(input: NativeBrowserSurfaceInput): NativeBrowserSurface {
  const mount = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserSurfaceState>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const bridge = input.hostBridge;
  const contextId = input.contextId;
  const threadId = input.threadId;

  useEffect(() => {
    if (bridge?.subscribeBrowserSurfaceState === undefined) return;
    return bridge.subscribeBrowserSurfaceState((next) => {
      if (next.contextId === contextId) setState(next);
    });
  }, [bridge, contextId]);

  useEffect(() => {
    const element = mount.current;
    const attach = bridge?.attachBrowserSurface;
    const update = bridge?.updateBrowserSurfaceBounds;
    const detach = bridge?.detachBrowserSurface;
    if (
      !input.enabled ||
      attach === undefined ||
      update === undefined ||
      detach === undefined ||
      element === null ||
      contextId === undefined ||
      threadId === undefined
    ) {
      return;
    }
    let disposed = false;
    let attached = false;
    const request = () => ({
      contextId,
      threadId,
      bounds: boundsInsideViewport(
        element.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      ),
    });
    const shouldDetach = () =>
      element.getClientRects().length === 0 ||
      document.querySelector(input.overlaySelector) !== null;
    const sync = async () => {
      if (disposed) return;
      if (shouldDetach()) {
        if (attached) {
          attached = false;
          await detach({ contextId, threadId }).catch(() => undefined);
        }
        return;
      }
      try {
        if (!attached) {
          const attachedState = await attach(request());
          if (disposed || shouldDetach()) {
            await detach({ contextId, threadId }).catch(() => undefined);
            return;
          }
          attached = true;
          setState(attachedState);
        } else {
          await update(request());
        }
        if (!disposed) setFailed(false);
      } catch {
        attached = false;
        if (!disposed) setFailed(true);
      }
    };
    const resize = new ResizeObserver(() => void sync());
    const visibility = new IntersectionObserver(() => void sync());
    const overlays = new MutationObserver(() => void sync());
    resize.observe(element);
    visibility.observe(element);
    overlays.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", sync);
    void sync();
    return () => {
      disposed = true;
      resize.disconnect();
      visibility.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", sync);
      if (attached) void detach({ contextId, threadId }).catch(() => undefined);
    };
  }, [attempt, bridge, contextId, input.enabled, input.overlaySelector, threadId]);

  return {
    mount,
    state,
    failed,
    retry: () => setAttempt((previous) => previous + 1),
    adopt: setState,
  };
}
