/**
 * A thread view holds one contiguous run of turns that always ends at the
 * newest turn. These two rules keep that run contiguous when an earlier page
 * arrives and when the newest window is read again (after a reconnect, a
 * `snapshot-required` frame, or a poll), so a client never shows two runs with
 * a gap between them.
 */

/** Put an earlier page above the loaded turns, skipping any turn already loaded. */
export function prependEarlierTurns<T>(
  loaded: ReadonlyArray<T>,
  earlier: ReadonlyArray<T>,
  key: (turn: T) => string,
): ReadonlyArray<T> {
  const held = new Set(loaded.map(key));
  return [...earlier.filter((turn) => !held.has(key(turn))), ...loaded];
}

/**
 * The outcome of reading the newest window again. `spliced` kept the earlier
 * loaded turns because the window's first turn was among them; `replaced`
 * could not prove the two runs touch, so the earlier turns are released and
 * the caller takes its earlier-history bound from the new window.
 */
export type NewestTurnsRefresh<T> =
  | { readonly kind: "spliced"; readonly turns: ReadonlyArray<T> }
  | { readonly kind: "replaced"; readonly turns: ReadonlyArray<T> };

/**
 * Join a freshly read newest window onto what is loaded. When the window's
 * first turn is loaded, everything before it stays and everything from it on
 * is the window's: a loaded turn after that point that the window no longer
 * holds is dropped. Otherwise the window replaces what is loaded.
 */
export function refreshNewestTurns<T>(
  loaded: ReadonlyArray<T>,
  newest: ReadonlyArray<T>,
  key: (turn: T) => string,
): NewestTurnsRefresh<T> {
  const first = newest[0];
  if (first === undefined) return { kind: "replaced", turns: newest };
  const firstKey = key(first);
  const at = loaded.findIndex((turn) => key(turn) === firstKey);
  if (at === -1) return { kind: "replaced", turns: newest };
  return { kind: "spliced", turns: [...loaded.slice(0, at), ...newest] };
}
