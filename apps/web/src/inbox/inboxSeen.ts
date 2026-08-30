const STORAGE_KEY = "octant.inbox.seen.v1";
/** Oldest entries fall off first; the list never grows without bound. */
const MAX_SEEN_ENTRIES = 500;

/**
 * Which inbox items the user has already opened, kept in this window's local
 * storage. Best-effort by design: losing the set only re-shows an unseen dot,
 * so no failure here may ever block the inbox itself.
 */
export function readSeenInboxKeys(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ReadonlySet<string> {
  if (storage === undefined) return new Set();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

export function markInboxKeySeen(
  key: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  if (storage === undefined) return;
  try {
    const existing = [...readSeenInboxKeys(storage)].filter((entry) => entry !== key);
    const next = [...existing, key].slice(-MAX_SEEN_ENTRIES);
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence is a convenience; the click that got us here still worked.
  }
}
