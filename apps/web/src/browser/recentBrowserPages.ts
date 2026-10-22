const STORAGE_KEY = "octant.browser.recent-pages.v1";
/** Enough to find the page from yesterday without the list becoming history. */
const MAX_RECENT_PAGES = 8;

export interface RecentBrowserPage {
  readonly url: string;
  readonly openedAt: string;
}

/**
 * The addresses a person opened in the Browser tool, newest first, kept in
 * this window's local storage so a new Browser can offer them. Best-effort by
 * design: losing the list only empties the start page's Recent section, so no
 * failure here may block opening a page.
 */
export function readRecentBrowserPages(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
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

/** Puts an opened address first; the same address opened again moves up rather than repeating. */
export function recordRecentBrowserPage(
  url: string,
  storage: Storage | undefined = globalThis.localStorage,
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
