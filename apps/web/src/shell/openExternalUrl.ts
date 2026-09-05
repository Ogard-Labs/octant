export interface ExternalUrlHost {
  readonly openBrowserExternal?: (url: string) => Promise<void>;
}

/**
 * Hands an already-validated address to the default browser.
 *
 * The desktop shell refuses every popup the renderer asks for, so a
 * `target="_blank"` link is inert there; the host's own open-external bridge
 * is the route that reaches the browser. A browser-hosted renderer has no
 * bridge and opens the address itself. Callers validate the address first —
 * this only chooses the door.
 */
export function openExternalUrl(host: ExternalUrlHost | undefined, url: string): void {
  if (host?.openBrowserExternal !== undefined) {
    void host.openBrowserExternal(url).catch(() => undefined);
    return;
  }
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
}
