import { useSyncExternalStore } from "react";

export const CODE_DIFF_IGNORE_WHITESPACE_STORAGE_KEY = "octant.code.diff-ignore-whitespace.v1";

/**
 * Whether this person reads diffs with whitespace ignored. It is one choice for
 * every thread, kept in this browser profile; missing or unreadable storage
 * means whitespace is shown.
 */
export function readCodeDiffIgnoreWhitespace(
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(CODE_DIFF_IGNORE_WHITESPACE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeCodeDiffIgnoreWhitespace(
  ignore: boolean,
  storage: Pick<Storage, "setItem"> | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(CODE_DIFF_IGNORE_WHITESPACE_STORAGE_KEY, String(ignore));
    unsaved = undefined;
  } catch {
    // Best-effort: the open views keep the in-memory choice.
    unsaved = ignore;
  }
  for (const listener of listeners) listener();
}

// Several diff views stay mounted at once (a hidden dock tool, a pane, an open
// commit), so one change has to reach all of them, not only the view whose
// toggle was clicked.
const listeners = new Set<() => void>();
let unsaved: boolean | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return unsaved ?? readCodeDiffIgnoreWhitespace();
}

/** The shared choice and its setter; every mounted view using this hook follows a change. */
export function useCodeDiffIgnoreWhitespace(): readonly [boolean, (ignore: boolean) => void] {
  const ignore = useSyncExternalStore(subscribe, snapshot, () => false);
  return [ignore, setIgnoreWhitespace] as const;
}

function setIgnoreWhitespace(ignore: boolean): void {
  writeCodeDiffIgnoreWhitespace(ignore);
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
