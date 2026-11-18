/**
 * The icons of pages the Browser has shown, by site, kept in memory only so a
 * Recent row can show the icon of a page it opened before. Never written to
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

export function rememberPageFavicon(pageUrl: string, dataUrl: string): void {
  const origin = originOf(pageUrl);
  if (origin === undefined || !dataUrl.startsWith("data:image/")) return;
  remembered.delete(origin);
  remembered.set(origin, dataUrl);
  const oldest = remembered.keys().next().value;
  if (remembered.size > MAX_REMEMBERED_SITES && oldest !== undefined) remembered.delete(oldest);
}

export function recallPageFavicon(pageUrl: string): string | undefined {
  const origin = originOf(pageUrl);
  return origin === undefined ? undefined : remembered.get(origin);
}

export function forgetPageFavicons(): void {
  remembered.clear();
}
