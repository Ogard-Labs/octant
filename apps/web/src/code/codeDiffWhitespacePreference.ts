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
  } catch {
    // Best-effort: the pane keeps the in-memory choice.
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
