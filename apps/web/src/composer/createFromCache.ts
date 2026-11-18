/**
 * What the "Create from…" popup shows is read before the popup opens and kept
 * here, so opening it paints rows at once and refreshes them behind the
 * person's back instead of drawing an empty box that fills in. Each list is
 * remembered per client (one per host connection) and per key, and a read that
 * is already under way is shared by whoever asks for the same list.
 *
 * The cache holds the answer exactly as the server gave it. Whoever shows it
 * decides what it means, so a stale answer is never turned into a claim.
 */
export const CREATE_FROM_FRESH_MS = 20_000;

interface Entry {
  readonly value: unknown;
  readonly at: number;
}

const stored = new WeakMap<object, Map<string, Entry>>();
const reading = new WeakMap<object, Map<string, Promise<unknown>>>();

function entriesFor(scope: object): Map<string, Entry> {
  const found = stored.get(scope);
  if (found !== undefined) return found;
  const created = new Map<string, Entry>();
  stored.set(scope, created);
  return created;
}

function readsFor(scope: object): Map<string, Promise<unknown>> {
  const found = reading.get(scope);
  if (found !== undefined) return found;
  const created = new Map<string, Promise<unknown>>();
  reading.set(scope, created);
  return created;
}

export interface CachedList<T> {
  readonly value: T;
  /** True while the answer is recent enough that nothing needs asking again. */
  readonly fresh: boolean;
}

export function peekList<T>(scope: object, key: string): CachedList<T> | undefined {
  const entry = stored.get(scope)?.get(key);
  if (entry === undefined) return undefined;
  // The value was stored by `loadList<T>` under this same key.
  return { value: entry.value as T, fresh: Date.now() - entry.at < CREATE_FROM_FRESH_MS };
}

/**
 * Reads a list and remembers the answer. A read already under way for the same
 * key is shared, and an answer that is still fresh is returned without asking.
 */
export function loadList<T>(
  scope: object,
  key: string,
  read: () => Promise<T>,
  options: {
    readonly force?: boolean;
    /** False for an answer that must not be kept, such as "unavailable": asking again must ask. */
    readonly keep?: (value: T) => boolean;
  } = {},
): Promise<T> {
  if (options.force !== true) {
    const cached = peekList<T>(scope, key);
    if (cached?.fresh === true) return Promise.resolve(cached.value);
  }
  const reads = readsFor(scope);
  const under = reads.get(key);
  if (under !== undefined && options.force !== true) return under as Promise<T>;
  const pending = read().then(
    (value) => {
      if (options.keep?.(value) !== false) entriesFor(scope).set(key, { value, at: Date.now() });
      if (reads.get(key) === pending) reads.delete(key);
      return value;
    },
    (error: unknown) => {
      if (reads.get(key) === pending) reads.delete(key);
      throw error;
    },
  );
  reads.set(key, pending);
  return pending;
}
