import type { CodeDiffLayout, CodeThreadId } from "@octant/contracts/code";

export const CODE_DIFF_LAYOUT_STORAGE_KEY = "octant.code.diff-layout.v1";

/**
 * Each Code thread's Unified / Side by side choice lives in this window.
 * Missing or unreadable storage is the Settings default, not a hard failure.
 */
export function readCodeDiffLayout(
  threadId: CodeThreadId,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): CodeDiffLayout | undefined {
  const stored = readStoredLayouts(storage);
  if (stored === undefined) return undefined;
  const value = stored[String(threadId)];
  return value === "unified" || value === "side-by-side" ? value : undefined;
}

export function writeCodeDiffLayout(
  threadId: CodeThreadId,
  layout: CodeDiffLayout,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    const current = readStoredLayouts(storage) ?? {};
    storage.setItem(
      CODE_DIFF_LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...current, [String(threadId)]: layout }),
    );
  } catch {
    // Preference persistence is best-effort; Review still uses the in-memory choice.
  }
}

/**
 * Forgets the thread's choice, so it follows the Settings default again.
 * Storing the default instead would pin the thread to today's default.
 */
export function clearCodeDiffLayout(
  threadId: CodeThreadId,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    const current = readStoredLayouts(storage);
    if (current === undefined || !(String(threadId) in current)) return;
    const rest = Object.fromEntries(
      Object.entries(current).filter(([id]) => id !== String(threadId)),
    );
    storage.setItem(CODE_DIFF_LAYOUT_STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // Best-effort, as writing is.
  }
}

function readStoredLayouts(
  storage: Pick<Storage, "getItem"> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(CODE_DIFF_LAYOUT_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}
