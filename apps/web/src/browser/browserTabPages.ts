import { useSyncExternalStore } from "react";

/**
 * What each open Browser tab's pane last showed: the page's title and address.
 * A person who browses a native page in the desktop app changes neither on the
 * server, so the server's last read of the thread's pages is stale or empty for
 * it, and it never lists a tab that holds a page of its own. The pane knows the
 * live page; this window-local store carries that to the dock's tab labels
 * without a server round trip (maintainer request, 2026-11-16).
 */
export interface BrowserTabPage {
  readonly title: string | undefined;
  readonly url: string | undefined;
}

/** A title is page-authored text: kept to this many characters when stored. */
export const BROWSER_TAB_TITLE_LIMIT = 200;

type Pages = ReadonlyMap<string, BrowserTabPage>;

let pages: Pages = new Map();
const listeners = new Set<() => void>();

// Dock tab ids repeat across threads (every thread's first Browser tab has the
// same id), so a tab is keyed by its thread as well.
function keyOf(threadId: string, tabId: string): string {
  return `${threadId}\u0000${tabId}`;
}

function emit(next: Pages): void {
  pages = next;
  for (const listener of listeners) listener();
}

// Bidi controls let a title read as another site (U+202E) and leak into the
// text beside it; control characters have no place in a one-line label.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu;
const LINE_BREAKS = /[\t\n\v\f\r]/gu;
const CONTROLS = /\p{Cc}/gu;

/** A page's title as a one-line, trimmed string of at most 200 code points; undefined when nothing is left. */
export function cleanPageTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const flat = title
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
  // By code point, so the cut never leaves half of a surrogate pair.
  const capped = Array.from(flat).slice(0, BROWSER_TAB_TITLE_LIMIT).join("").trim();
  return capped === "" ? undefined : capped;
}

/**
 * The page a pane shows, from ONE source: the native page's own state when the
 * pane drives a native page (its title, even when empty, so the label falls to
 * the host of the same address), else the server's observation. With no active
 * context there is no page to report.
 */
export function livePageOf(input: {
  readonly activeContext: boolean;
  readonly native: { readonly title: string; readonly url: string } | undefined;
  readonly observation:
    | { readonly title?: string | undefined; readonly url?: string | undefined }
    | undefined;
}): { readonly title: string | undefined; readonly url: string | undefined } | undefined {
  if (!input.activeContext) return undefined;
  const source = input.native ?? input.observation;
  return source === undefined ? undefined : { title: source.title, url: source.url };
}

/** A page's host; an address that does not parse, or a blank page, has none. */
export function pageHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).host;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/** One tab's reported page, if its pane has reported one. */
export function browserTabPageOf(
  reported: Pages,
  threadId: string,
  tabId: string,
): BrowserTabPage | undefined {
  return reported.get(keyOf(threadId, tabId));
}

/** The pane reports its page. An unchanged report changes nothing. */
export function publishBrowserTabPage(
  threadId: string,
  tabId: string,
  page: { readonly title?: string | undefined; readonly url?: string | undefined },
): void {
  const key = keyOf(threadId, tabId);
  const title = cleanPageTitle(page.title);
  const url = page.url === undefined || page.url === "" ? undefined : page.url;
  // A pane that has nothing to report yet (its page state still loading) must
  // not wipe the name it earned before: only a closed tab or a new page clears.
  if (title === undefined && url === undefined) return;
  const before = pages.get(key);
  if (before?.title === title && before?.url === url) return;
  const next = new Map(pages);
  next.set(key, { title, url });
  emit(next);
}

/**
 * Forget the names of tabs the thread no longer holds. `stored` is the dock's
 * full stored tab list for the thread (not the displayed one, which leaves out
 * tabs the bottom panel holds); undefined while that state has not loaded,
 * when nothing is pruned.
 */
export function forgetClosedBrowserTabs(
  threadId: string,
  stored: ReadonlyArray<{ readonly id: string; readonly surface: string }> | undefined,
): void {
  if (stored === undefined) return;
  const open = new Set(
    stored.filter((tab) => tab.surface === "browser").map((tab) => keyOf(threadId, tab.id)),
  );
  const prefix = keyOf(threadId, "");
  let next: Map<string, BrowserTabPage> | undefined;
  for (const key of pages.keys()) {
    if (key.startsWith(prefix) && !open.has(key)) {
      next ??= new Map(pages);
      next.delete(key);
    }
  }
  if (next !== undefined) emit(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every reported page; re-renders when any tab's page changes. */
export function useBrowserTabPages(): Pages {
  return useSyncExternalStore(
    subscribe,
    () => pages,
    () => pages,
  );
}

/**
 * The name of a Browser tab: the live page's title, else its host; with no live
 * page, the server's last read (title, else host); "New tab" only with no page.
 */
export function browserTabName(
  live: BrowserTabPage | undefined,
  server: { readonly title?: string | undefined; readonly url?: string | undefined } | undefined,
): string {
  const fromLive = cleanPageTitle(live?.title) ?? pageHost(live?.url);
  if (fromLive !== undefined) return fromLive;
  return cleanPageTitle(server?.title) ?? pageHost(server?.url) ?? "New tab";
}

/** Test seam: forget everything. */
export function resetBrowserTabPages(): void {
  emit(new Map());
}
