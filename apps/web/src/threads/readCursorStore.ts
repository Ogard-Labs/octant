/**
 * Per-thread record of activity the user has seen. It is shared by Chat and
 * Code: unread has the same product meaning in both surfaces.
 */
export interface ReadCursorStore<ThreadId> {
  readonly getSnapshot: () => ReadonlyMap<string, number>;
  readonly getMarkedUnread: () => ReadonlySet<string>;
  readonly mark: (threadId: ThreadId, sequence: number) => void;
  readonly markDeferred: (threadId: ThreadId, sequence: number) => void;
  readonly unmark: (threadId: ThreadId) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const MAX_TRACKED_THREADS = 500;
const PERSIST_DELAY_MS = 250;

interface CursorState {
  readonly cursors: Map<string, number>;
  readonly markedUnread: Set<string>;
  readonly order: string[];
}

type PendingChange =
  | { readonly kind: "mark"; readonly key: string; readonly sequence: number }
  | { readonly kind: "unmark"; readonly key: string };

function emptyState(): CursorState {
  return { cursors: new Map(), markedUnread: new Set(), order: [] };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restore(storage: Pick<Storage, "getItem"> | undefined, storageKey: string): CursorState {
  if (storage === undefined) return emptyState();
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return emptyState();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyState();
    const cursors = new Map<string, number>();
    if (isRecord(parsed.cursors)) {
      for (const [threadId, sequence] of Object.entries(parsed.cursors)) {
        if (typeof sequence === "number" && Number.isFinite(sequence))
          cursors.set(threadId, sequence);
      }
    }
    const markedUnread = new Set<string>();
    if (Array.isArray(parsed.markedUnread)) {
      for (const entry of parsed.markedUnread)
        if (typeof entry === "string") markedUnread.add(entry);
    }
    for (const key of markedUnread) cursors.delete(key);
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((entry): entry is string => typeof entry === "string")
      : [...cursors.keys(), ...markedUnread];
    return limitState({ cursors, markedUnread, order });
  } catch {
    return emptyState();
  }
}

function limitState(state: CursorState): CursorState {
  const keys = new Set([...state.cursors.keys(), ...state.markedUnread]);
  const order = state.order.filter((key) => keys.has(key));
  for (const key of keys) if (!order.includes(key)) order.push(key);
  const retained = new Set(order.slice(-MAX_TRACKED_THREADS));
  return {
    cursors: new Map([...state.cursors].filter(([key]) => retained.has(key))),
    markedUnread: new Set([...state.markedUnread].filter((key) => retained.has(key))),
    order: order.filter((key) => retained.has(key)),
  };
}

function touch(order: ReadonlyArray<string>, key: string): string[] {
  return [...order.filter((candidate) => candidate !== key), key];
}

function applyChange(state: CursorState, change: PendingChange): CursorState {
  const cursors = new Map(state.cursors);
  const markedUnread = new Set(state.markedUnread);
  if (change.kind === "mark") {
    if (change.sequence <= (cursors.get(change.key) ?? 0) && !markedUnread.has(change.key)) {
      return state;
    }
    if (change.sequence > (cursors.get(change.key) ?? 0)) cursors.set(change.key, change.sequence);
    markedUnread.delete(change.key);
  } else {
    cursors.delete(change.key);
    markedUnread.add(change.key);
  }
  return limitState({ cursors, markedUnread, order: touch(state.order, change.key) });
}

function sameState(first: CursorState, second: CursorState): boolean {
  if (
    first.cursors.size !== second.cursors.size ||
    first.markedUnread.size !== second.markedUnread.size
  ) {
    return false;
  }
  for (const [key, sequence] of first.cursors)
    if (second.cursors.get(key) !== sequence) return false;
  for (const key of first.markedUnread) if (!second.markedUnread.has(key)) return false;
  return true;
}

function changedKeys(first: CursorState, second: CursorState): ReadonlySet<string> {
  const keys = new Set([
    ...first.cursors.keys(),
    ...first.markedUnread,
    ...second.cursors.keys(),
    ...second.markedUnread,
  ]);
  const changed = new Set<string>();
  for (const key of keys) {
    if (
      first.cursors.get(key) !== second.cursors.get(key) ||
      first.markedUnread.has(key) !== second.markedUnread.has(key)
    ) {
      changed.add(key);
    }
  }
  return changed;
}

function encode(state: CursorState): string {
  return JSON.stringify({
    version: 2,
    cursors: Object.fromEntries(state.cursors),
    markedUnread: [...state.markedUnread],
    order: state.order,
  });
}

export function createReadCursorStore<ThreadId>(options: {
  readonly storageKey: string;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}): ReadCursorStore<ThreadId> {
  const usesDefaultStorage = !("storage" in options);
  const storage = (() => {
    if ("storage" in options) return options.storage;
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })();
  let persistedState = restore(storage, options.storageKey);
  let state = persistedState;
  const pending: PendingChange[] = [];
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const announce = () => {
    for (const listener of listeners) listener();
  };
  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (storage === undefined || pending.length === 0) return;
    try {
      let persisted = restore(storage, options.storageKey);
      for (const change of pending) persisted = applyChange(persisted, change);
      storage.setItem(options.storageKey, encode(persisted));
      persistedState = persisted;
      pending.length = 0;
    } catch {
      // Keeping the updates in memory is still correct; a later lifecycle
      // flush may persist them when browser storage becomes available again.
    }
  };
  const scheduleFlush = () => {
    if (timer === undefined) timer = setTimeout(flush, PERSIST_DELAY_MS);
  };
  const record = (change: PendingChange, immediately: boolean) => {
    const next = applyChange(state, change);
    if (next === state) return;
    state = next;
    const existing = pending.findIndex((candidate) => candidate.key === change.key);
    if (existing === -1) pending.push(change);
    else pending.splice(existing, 1, change);
    if (immediately) flush();
    else scheduleFlush();
    announce();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== options.storageKey || event.storageArea !== storage) return;
    const incoming = restore(storage, options.storageKey);
    const superseded = changedKeys(persistedState, incoming);
    if (superseded.size > 0) {
      const retained = pending.filter((change) => !superseded.has(change.key));
      pending.splice(0, pending.length, ...retained);
    }
    let next = incoming;
    for (const change of pending) next = applyChange(next, change);
    const changed = !sameState(state, next);
    persistedState = incoming;
    state = next;
    if (changed) announce();
  };
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") flush();
  };
  let listening = false;
  const beginListening = () => {
    if (!usesDefaultStorage || storage === undefined || listening) return;
    listening = true;
    globalThis.addEventListener("storage", onStorage);
    globalThis.addEventListener("pagehide", flush);
    globalThis.addEventListener("beforeunload", flush);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibility);
  };
  const stopListening = () => {
    if (!listening) return;
    listening = false;
    globalThis.removeEventListener("storage", onStorage);
    globalThis.removeEventListener("pagehide", flush);
    globalThis.removeEventListener("beforeunload", flush);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
  return {
    getSnapshot: () => state.cursors,
    getMarkedUnread: () => state.markedUnread,
    mark: (threadId, sequence) => record({ kind: "mark", key: String(threadId), sequence }, true),
    markDeferred: (threadId, sequence) =>
      record({ kind: "mark", key: String(threadId), sequence }, false),
    // Unlike a stream update, explicitly marking unread promises restart
    // visibility immediately, so it deliberately flushes synchronously.
    unmark: (threadId) => record({ kind: "unmark", key: String(threadId) }, true),
    subscribe: (listener) => {
      listeners.add(listener);
      beginListening();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopListening();
      };
    },
  };
}
