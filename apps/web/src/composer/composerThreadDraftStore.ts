/**
 * Unsent composer drafts live on the client that typed them.
 *
 * They are not journal events, not diagnostics, and not provider context. A
 * draft becomes a message only when the user sends it. Purging or deleting a
 * thread must drop its draft so unsent text cannot outlive the thread.
 */

export const COMPOSER_THREAD_DRAFTS_STORAGE_KEY = "octant.composer.thread-drafts.v1";

export const COMPOSER_STAGED_DROPPED_NOTE =
  "Attachments and extra selections were not kept with this draft. Attach them again before sending.";

export const COMPOSER_DRAFT_WRITE_FAILED_NOTE =
  "This draft could not be saved on this device. It will be lost if you close this window.";

export const COMPOSER_DRAFT_REMOVE_FAILED_NOTE =
  "This draft could not be removed from this device. It may come back after restart.";

export const COMPOSER_DRAFT_MODES = ["chat", "work", "code"] as const;
export type ComposerDraftMode = (typeof COMPOSER_DRAFT_MODES)[number];

export interface ComposerThreadDraft {
  readonly text: string;
  readonly caretIndex: number;
  readonly stagedDropped: boolean;
}

export type ComposerDraftPersistResult =
  | { readonly status: "ok" }
  | {
      readonly status: "unpersisted";
      readonly reason: "unavailable" | "write-failed" | "remove-failed";
    };

export interface ComposerThreadDraftStore {
  readonly read: (
    mode: ComposerDraftMode,
    threadId: string | undefined,
  ) => ComposerThreadDraft | undefined;
  readonly write: (
    mode: ComposerDraftMode,
    threadId: string | undefined,
    draft: ComposerThreadDraft,
  ) => ComposerDraftPersistResult;
  readonly clear: (
    mode: ComposerDraftMode,
    threadId: string | undefined,
  ) => ComposerDraftPersistResult;
  readonly markStagedDropped: (
    mode: ComposerDraftMode,
    threadId: string | undefined,
  ) => ComposerDraftPersistResult;
  readonly purgeThread: (threadId: string) => ComposerDraftPersistResult;
  readonly dropUnknownThreads: (
    mode: ComposerDraftMode,
    knownThreadIds: ReadonlyArray<string>,
  ) => ComposerDraftPersistResult;
  readonly clearAll: () => ComposerDraftPersistResult;
  readonly revision: (mode: ComposerDraftMode, threadId: string | undefined) => number;
  readonly persistError: () => string | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyMap<string, ComposerThreadDraft>;
  readonly getListenVersion: () => number;
  readonly reloadFromStorage: () => void;
}

export type ComposerDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const EMPTY_SNAPSHOT: ReadonlyMap<string, ComposerThreadDraft> = new Map();

export function composerDraftRecordKey(
  mode: ComposerDraftMode,
  threadId: string | undefined,
): string {
  return `${mode}:${threadId ?? ""}`;
}

export function clampComposerCaret(caretIndex: number, textLength: number): number {
  if (!Number.isFinite(caretIndex)) return textLength;
  return Math.max(0, Math.min(Math.trunc(caretIndex), textLength));
}

export function applyComposerCaret(
  element: Pick<HTMLTextAreaElement, "setSelectionRange"> | null,
  caretIndex: number,
  textLength: number,
): void {
  if (element === null) return;
  const caret = clampComposerCaret(caretIndex, textLength);
  element.setSelectionRange(caret, caret);
}

/**
 * Reading the property is itself the risk: a browser with site data blocked
 * throws `SecurityError` from the `localStorage` getter rather than from any
 * later call, so a default argument that names it would fail before this
 * store's own refusal handling could hold anything in memory.
 */
function defaultComposerDraftStorage(): ComposerDraftStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isBrowserLocalStorage(storage: ComposerDraftStorage | undefined): boolean {
  try {
    return storage !== undefined && storage === globalThis.localStorage;
  } catch {
    return false;
  }
}

export function createComposerThreadDraftStore(
  storage: ComposerDraftStorage | undefined = defaultComposerDraftStorage(),
): ComposerThreadDraftStore {
  let snapshot: ReadonlyMap<string, ComposerThreadDraft> = loadSnapshot(storage);
  let persistError: string | undefined;
  let unpersisted = false;
  let listenVersion = 0;
  const revisions = new Map<string, number>();
  const listeners = new Set<() => void>();

  function bump(key: string): void {
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
  }

  function notify(): void {
    listenVersion += 1;
    for (const listener of listeners) listener();
  }

  function persistMerged(
    mutate: (next: Map<string, ComposerThreadDraft>) => ReadonlyArray<string>,
  ): ComposerDraftPersistResult {
    const next = new Map(loadSnapshot(storage));
    if (unpersisted) {
      for (const [key, draft] of snapshot) {
        if (!next.has(key)) next.set(key, draft);
      }
    }
    const changedKeys = mutate(next);
    if (changedKeys.length === 0 && snapshotsEqual(snapshot, next) && !unpersisted) {
      return persistError === undefined
        ? { status: "ok" }
        : { status: "unpersisted", reason: "write-failed" };
    }
    for (const key of changedKeys) bump(key);
    const persist = persistSnapshot(storage, next);
    snapshot = next.size === 0 ? EMPTY_SNAPSHOT : next;
    if (persist.status === "ok") {
      unpersisted = false;
      persistError = undefined;
    } else {
      unpersisted = true;
      persistError =
        persist.reason === "remove-failed"
          ? COMPOSER_DRAFT_REMOVE_FAILED_NOTE
          : COMPOSER_DRAFT_WRITE_FAILED_NOTE;
    }
    notify();
    return persist;
  }

  function reloadFromStorage(): void {
    const incoming = loadSnapshot(storage);
    const next = new Map(incoming);
    if (unpersisted) {
      for (const [key, draft] of snapshot) {
        if (!next.has(key)) next.set(key, draft);
      }
    }
    if (snapshotsEqual(snapshot, next)) return;
    for (const key of next.keys()) {
      const previous = snapshot.get(key);
      const current = next.get(key);
      if (
        previous === undefined ||
        current === undefined ||
        previous.text !== current.text ||
        previous.caretIndex !== current.caretIndex ||
        previous.stagedDropped !== current.stagedDropped
      ) {
        bump(key);
      }
    }
    for (const key of snapshot.keys()) {
      if (!next.has(key)) bump(key);
    }
    snapshot = next.size === 0 ? EMPTY_SNAPSHOT : next;
    notify();
  }

  function onStorage(event: StorageEvent): void {
    if (event.key !== COMPOSER_THREAD_DRAFTS_STORAGE_KEY && event.key !== null) return;
    reloadFromStorage();
  }

  if (typeof window !== "undefined" && isBrowserLocalStorage(storage)) {
    window.addEventListener("storage", onStorage);
  }

  return {
    read: (mode, threadId) => snapshot.get(composerDraftRecordKey(mode, threadId)),
    write: (mode, threadId, draft) => {
      const key = composerDraftRecordKey(mode, threadId);
      const normalized = normalizeDraft(draft);
      return persistMerged((next) => {
        if (normalized === undefined) {
          if (!next.has(key) && !snapshot.has(key)) return [];
          next.delete(key);
          return [key];
        }
        const previous = next.get(key);
        if (
          previous !== undefined &&
          previous.text === normalized.text &&
          previous.caretIndex === normalized.caretIndex &&
          previous.stagedDropped === normalized.stagedDropped
        ) {
          return [];
        }
        next.set(key, normalized);
        return [key];
      });
    },
    clear: (mode, threadId) => {
      const key = composerDraftRecordKey(mode, threadId);
      return persistMerged((next) => {
        if (!next.has(key) && !snapshot.has(key)) return [];
        next.delete(key);
        return [key];
      });
    },
    markStagedDropped: (mode, threadId) => {
      const key = composerDraftRecordKey(mode, threadId);
      return persistMerged((next) => {
        const current = next.get(key) ?? snapshot.get(key);
        if (current === undefined || current.stagedDropped) return [];
        next.set(key, { ...current, stagedDropped: true });
        return [key];
      });
    },
    purgeThread: (threadId) => {
      const suffix = `:${threadId}`;
      return persistMerged((next) => {
        const changed: string[] = [];
        for (const key of new Set([...next.keys(), ...snapshot.keys()])) {
          if (!key.endsWith(suffix)) continue;
          next.delete(key);
          changed.push(key);
        }
        return changed;
      });
    },
    dropUnknownThreads: (mode, knownThreadIds) => {
      const prefix = `${mode}:`;
      const known = new Set(knownThreadIds);
      return persistMerged((next) => {
        const changed: string[] = [];
        for (const key of new Set([...next.keys(), ...snapshot.keys()])) {
          if (!key.startsWith(prefix)) continue;
          const threadId = key.slice(prefix.length);
          if (threadId === "" || known.has(threadId)) continue;
          next.delete(key);
          changed.push(key);
        }
        return changed;
      });
    },
    clearAll: () =>
      persistMerged((next) => {
        const changed = [...new Set([...next.keys(), ...snapshot.keys()])];
        next.clear();
        return changed;
      }),
    revision: (mode, threadId) => revisions.get(composerDraftRecordKey(mode, threadId)) ?? 0,
    persistError: () => persistError,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getListenVersion: () => listenVersion,
    reloadFromStorage,
  };
}

export const composerThreadDrafts = createComposerThreadDraftStore();

export function purgeComposerThreadDrafts(
  threadIds: ReadonlyArray<string>,
  store: ComposerThreadDraftStore = composerThreadDrafts,
): void {
  for (const threadId of threadIds) {
    if (threadId.trim() === "") continue;
    store.purgeThread(threadId);
  }
}

function normalizeDraft(draft: ComposerThreadDraft): ComposerThreadDraft | undefined {
  const text = draft.text;
  if (text.trim() === "") return undefined;
  return {
    text,
    caretIndex: clampComposerCaret(draft.caretIndex, text.length),
    stagedDropped: draft.stagedDropped,
  };
}

function loadSnapshot(
  storage: ComposerDraftStorage | undefined,
): ReadonlyMap<string, ComposerThreadDraft> {
  if (storage === undefined) return EMPTY_SNAPSHOT;
  try {
    const raw = storage.getItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return EMPTY_SNAPSHOT;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY_SNAPSHOT;
    }
    const next = new Map<string, ComposerThreadDraft>();
    for (const [key, value] of Object.entries(parsed)) {
      const draft = decodeDraft(value);
      if (draft === undefined) continue;
      if (!isDraftKey(key)) continue;
      next.set(key, draft);
    }
    return next.size === 0 ? EMPTY_SNAPSHOT : next;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

function persistSnapshot(
  storage: ComposerDraftStorage | undefined,
  snapshot: ReadonlyMap<string, ComposerThreadDraft>,
): ComposerDraftPersistResult {
  if (storage === undefined) return { status: "unpersisted", reason: "unavailable" };
  try {
    if (snapshot.size === 0) {
      storage.removeItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY);
      return { status: "ok" };
    }
    const payload: Record<string, { text: string; caretIndex: number; stagedDropped?: boolean }> =
      {};
    for (const [key, draft] of snapshot) {
      payload[key] = {
        text: draft.text,
        caretIndex: draft.caretIndex,
        ...(draft.stagedDropped ? { stagedDropped: true } : {}),
      };
    }
    storage.setItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY, JSON.stringify(payload));
    return { status: "ok" };
  } catch {
    return {
      status: "unpersisted",
      reason: snapshot.size === 0 ? "remove-failed" : "write-failed",
    };
  }
}

function decodeDraft(value: unknown): ComposerThreadDraft | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!("text" in value) || typeof value.text !== "string") return undefined;
  const caretIndex =
    "caretIndex" in value && typeof value.caretIndex === "number"
      ? value.caretIndex
      : value.text.length;
  const stagedDropped = "stagedDropped" in value && value.stagedDropped === true ? true : false;
  return normalizeDraft({
    text: value.text,
    caretIndex,
    stagedDropped,
  });
}

function isDraftKey(key: string): boolean {
  const separator = key.indexOf(":");
  if (separator < 1) return false;
  const mode = key.slice(0, separator);
  return mode === "chat" || mode === "work" || mode === "code";
}

function snapshotsEqual(
  left: ReadonlyMap<string, ComposerThreadDraft>,
  right: ReadonlyMap<string, ComposerThreadDraft>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, draft] of left) {
    const other = right.get(key);
    if (
      other === undefined ||
      other.text !== draft.text ||
      other.caretIndex !== draft.caretIndex ||
      other.stagedDropped !== draft.stagedDropped
    ) {
      return false;
    }
  }
  return true;
}
