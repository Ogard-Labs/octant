import { useEffect } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { RENDERER_OVERLAY_SELECTOR } from "./rendererOverlaySelector";

/**
 * Tells the desktop host whenever renderer chrome that native views must not
 * cover opens or closes. The host closes an open extension popup and hides
 * the Code approval view while it is up: both are native windows the renderer
 * cannot paint over. Reports only transitions, and only on hosts that listen.
 */
export function useRendererOverlayReport(hostBridge: OctantHostBridge | undefined): void {
  useEffect(() => {
    const report = hostBridge?.setRendererOverlayOpen;
    if (report === undefined || typeof MutationObserver === "undefined") return;
    let open = false;
    const sync = () => {
      const next = document.querySelector(RENDERER_OVERLAY_SELECTOR) !== null;
      if (next === open) return;
      open = next;
      void report.call(hostBridge, next);
    };
    const observer = new MutationObserver(sync);
    // `hidden` covers the thread info panel, which toggles rather than mounts.
    observer.observe(document.body, {
      attributeFilter: ["hidden"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    sync();
    return () => {
      observer.disconnect();
      if (open) void report.call(hostBridge, false);
    };
  }, [hostBridge]);
}
