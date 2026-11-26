const KEY = "octant.mobile.threads.readCursors.v1";

/** The browser stand-in's copy; a browser that keeps nothing starts over. */
export function loadReadCursors(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function keepReadCursors(text: string): void {
  try {
    globalThis.localStorage?.setItem(KEY, text);
  } catch {
    // The count starts over next time.
  }
}
