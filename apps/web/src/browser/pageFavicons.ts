import { isBrowserSurfaceFaviconDataUrl } from "@octant/contracts/browser-automation";

/**
 * The icons of pages the Browser has shown, by profile and site, kept in
 * memory only so a Recent row can show the icon of a page it opened before.
 * A site opened under two profiles keeps two entries: one profile's sign-in
 * or personalization must never dress the other's rows. Never written to
 * storage: closing the window forgets them, and a site's row shows the globe
 * until its page is open again.
 */
const MAX_REMEMBERED_SITES = 32;
const remembered = new Map<string, string>();

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function rememberPageFavicon(profile: string, pageUrl: string, dataUrl: string): void {
  const origin = originOf(pageUrl);
  // The same raster bound the IPC applies: a Recent row is no place for a
  // page's SVG markup or an unbounded payload.
  if (origin === undefined || !isBrowserSurfaceFaviconDataUrl(dataUrl)) return;
  const key = `${profile}\n${origin}`;
  remembered.delete(key);
  remembered.set(key, dataUrl);
  const oldest = remembered.keys().next().value;
  if (remembered.size > MAX_REMEMBERED_SITES && oldest !== undefined) remembered.delete(oldest);
}

export function recallPageFavicon(profile: string, pageUrl: string): string | undefined {
  const origin = originOf(pageUrl);
  return origin === undefined ? undefined : remembered.get(`${profile}\n${origin}`);
}

export function forgetPageFavicons(): void {
  remembered.clear();
}
