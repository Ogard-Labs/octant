/**
 * Per-thread record of the activity sequence the user has actually seen,
 * shared by Chat and Code because unread means the same thing in both.
 *
 * The record outlives the window that made it. A read cursor kept only in
 * memory turns every relaunch into a wall of unread threads the user already
 * dealt with, which is the opposite of what the mark is for: quitting the app
 * is not the same as forgetting what you read.
 *
 * Persistence is best-effort. Losing the stored record only re-shows a mark,
 * so no storage failure may ever block reading a thread.
 */
export interface ReadCursorStore<ThreadId> {
  readonly getSnapshot: () => ReadonlyMap<string, number>;
  /**
   * Thread ids the user explicitly asked to read as unread, over and above the
   * cursor comparison. A thread whose sequence never advanced has nothing for a
   * dropped cursor to resurface — zero over zero — so the explicit request is
   * held here until the next mark spends it.
   */
  readonly getMarkedUnread: () => ReadonlySet<string>;
  readonly mark: (threadId: ThreadId, sequence: number) => void;
  /**
   * Drops what the user has seen of a thread, so its activity reads as unread
   * again — and holds it unread even when no sequence advanced. The cursor only
   * ever moves forward on its own — a refresh must never spend a mark the user
   * did not see — but a person asking for the thread back in their unread list
   * is not the refresh path.
   */
  readonly unmark: (threadId: ThreadId) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Oldest threads fall off first so one long-lived window cannot grow the stored
 * record without bound. A thread that falls off reads as unread once more,
 * which is the same harmless outcome as storage being unavailable.
 */
const MAX_TRACKED_THREADS = 500;

interface StoredReadCursors {
  readonly cursors: Readonly<Record<string, number>>;
  readonly markedUnread: ReadonlyArray<string>;
}

function restore(
  storage: Pick<Storage, "getItem"> | undefined,
  storageKey: string,
): { cursors: Map<string, number>; markedUnread: Set<string> } {
  const empty = { cursors: new Map<string, number>(), markedUnread: new Set<string>() };
  if (storage === undefined) return empty;
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const stored = parsed as Partial<StoredReadCursors>;
    const cursors = new Map<string, number>();
    if (typeof stored.cursors === "object" && stored.cursors !== null) {
      for (const [threadId, sequence] of Object.entries(stored.cursors)) {
        if (typeof sequence === "number" && Number.isFinite(sequence)) {
          cursors.set(threadId, sequence);
        }
      }
    }
    const markedUnread = new Set<string>(
      Array.isArray(stored.markedUnread)
        ? stored.markedUnread.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    return {
      cursors: new Map([...cursors].slice(-MAX_TRACKED_THREADS)),
      markedUnread: new Set([...markedUnread].slice(-MAX_TRACKED_THREADS)),
    };
  } catch {
    return empty;
  }
}

/**
 * Writes one change onto whatever is stored right now rather than onto this
 * window's whole map. Octant runs many windows against one origin, so a
 * wholesale write would silently drop a thread the user read in another window.
 */
function persistChange(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  storageKey: string,
  change: (state: { cursors: Map<string, number>; markedUnread: Set<string> }) => void,
): void {
  if (storage === undefined) return;
  try {
    const state = restore(storage, storageKey);
    change(state);
    const stored: StoredReadCursors = {
      cursors: Object.fromEntries([...state.cursors].slice(-MAX_TRACKED_THREADS)),
      markedUnread: [...state.markedUnread].slice(-MAX_TRACKED_THREADS),
    };
    storage.setItem(storageKey, JSON.stringify(stored));
  } catch {
    // Persistence is a convenience; the read that got us here still counted.
  }
}

export function createReadCursorStore<ThreadId>(options: {
  readonly storageKey: string;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}): ReadCursorStore<ThreadId> {
  const storage = (() => {
    if ("storage" in options) return options.storage;
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })();
  const restored = restore(storage, options.storageKey);
  let snapshot: ReadonlyMap<string, number> = restored.cursors;
  let markedUnread: ReadonlySet<string> = restored.markedUnread;
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    getMarkedUnread: () => markedUnread,
    mark: (threadId, sequence) => {
      const key = String(threadId);
      // Reading a thread with no new sequence still spends an explicit unread
      // mark: the cursor has nowhere to move, but the user has now seen what
      // they asked to be reminded of.
      const spendsUnreadMark = markedUnread.has(key);
      if (spendsUnreadMark) {
        const nextMarked = new Set(markedUnread);
        nextMarked.delete(key);
        markedUnread = nextMarked;
      }
      if (sequence > (snapshot.get(key) ?? 0)) {
        const next = new Map(snapshot);
        next.set(key, sequence);
        snapshot = new Map([...next].slice(-MAX_TRACKED_THREADS));
      } else if (!spendsUnreadMark) {
        return;
      }
      persistChange(storage, options.storageKey, (state) => {
        if (sequence > (state.cursors.get(key) ?? 0)) state.cursors.set(key, sequence);
        state.markedUnread.delete(key);
      });
      announce();
    },
    unmark: (threadId) => {
      const key = String(threadId);
      if (!snapshot.has(key) && markedUnread.has(key)) return;
      if (snapshot.has(key)) {
        const next = new Map(snapshot);
        next.delete(key);
        snapshot = next;
      }
      const nextMarked = new Set(markedUnread);
      nextMarked.add(key);
      markedUnread = new Set([...nextMarked].slice(-MAX_TRACKED_THREADS));
      persistChange(storage, options.storageKey, (state) => {
        state.cursors.delete(key);
        state.markedUnread.add(key);
      });
      announce();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
