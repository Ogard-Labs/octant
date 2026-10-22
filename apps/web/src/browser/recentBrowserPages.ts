const STORAGE_KEY = "octant.browser.recent-pages.v1";
/** Enough to find the page from yesterday without the list becoming history. */
const MAX_RECENT_PAGES = 8;

export interface RecentBrowserPage {
  readonly url: string;
  readonly openedAt: string;
}

/**
 * The renderer's local storage, or undefined where it is refused. Merely
 * reading `localStorage` throws when a client blocks site data, and a default
 * argument is evaluated before the function body's guard could catch it.
 */
function rendererStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The pages the Browser tool showed, newest first, kept in the renderer's
 * local storage so a new Browser can offer them. The renderer's windows share
 * that storage, so the list is the person's on this computer, like a
 * browser's history, rather than one window's. Best-effort by design: losing
 * the list only empties the start page's Recent section, so no failure here
 * may block opening a page.
 */
export function readRecentBrowserPages(
  storage: Pick<Storage, "getItem"> | undefined = rendererStorage(),
): ReadonlyArray<RecentBrowserPage> {
  if (storage === undefined) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentBrowserPage =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { url?: unknown }).url === "string" &&
        typeof (entry as { openedAt?: unknown }).openedAt === "string",
    );
  } catch {
    return [];
  }
}

/** Puts a shown address first; the same address shown again moves up rather than repeating. */
export function recordRecentBrowserPage(
  url: string,
  storage: Storage | undefined = rendererStorage(),
  now: Date = new Date(),
): ReadonlyArray<RecentBrowserPage> {
  const existing = readRecentBrowserPages(storage).filter((entry) => entry.url !== url);
  const next = [{ url, openedAt: now.toISOString() }, ...existing].slice(0, MAX_RECENT_PAGES);
  if (storage === undefined) return next;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence is a convenience; the page that got us here still opened.
  }
  return next;
}
