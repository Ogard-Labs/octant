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

export const COMPOSER_DRAFT_MODES = ["chat", "work", "code"] as const;
export type ComposerDraftMode = (typeof COMPOSER_DRAFT_MODES)[number];

export interface ComposerThreadDraft {
  readonly text: string;
  readonly caretIndex: number;
  readonly stagedDropped: boolean;
}

export interface ComposerThreadDraftStore {
  readonly read: (
    mode: ComposerDraftMode,
    threadId: string | undefined,
  ) => ComposerThreadDraft | undefined;
  readonly write: (
    mode: ComposerDraftMode,
    threadId: string | undefined,
    draft: ComposerThreadDraft,
  ) => void;
  readonly clear: (mode: ComposerDraftMode, threadId: string | undefined) => void;
  readonly markStagedDropped: (mode: ComposerDraftMode, threadId: string | undefined) => void;
  readonly purgeThread: (threadId: string) => void;
  readonly clearAll: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyMap<string, ComposerThreadDraft>;
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

export function createComposerThreadDraftStore(
  storage: ComposerDraftStorage | undefined = globalThis.localStorage,
): ComposerThreadDraftStore {
  let snapshot: ReadonlyMap<string, ComposerThreadDraft> = loadSnapshot(storage);
  const listeners = new Set<() => void>();

  function emit(next: ReadonlyMap<string, ComposerThreadDraft>): void {
    snapshot = next.size === 0 ? EMPTY_SNAPSHOT : next;
    persistSnapshot(storage, snapshot);
    for (const listener of listeners) listener();
  }

  return {
    read: (mode, threadId) => snapshot.get(composerDraftRecordKey(mode, threadId)),
    write: (mode, threadId, draft) => {
      const key = composerDraftRecordKey(mode, threadId);
      const normalized = normalizeDraft(draft);
      if (normalized === undefined) {
        if (!snapshot.has(key)) return;
        const next = new Map(snapshot);
        next.delete(key);
        emit(next);
        return;
      }
      const previous = snapshot.get(key);
      if (
        previous !== undefined &&
        previous.text === normalized.text &&
        previous.caretIndex === normalized.caretIndex &&
        previous.stagedDropped === normalized.stagedDropped
      ) {
        return;
      }
      const next = new Map(snapshot);
      next.set(key, normalized);
      emit(next);
    },
    clear: (mode, threadId) => {
      const key = composerDraftRecordKey(mode, threadId);
      if (!snapshot.has(key)) return;
      const next = new Map(snapshot);
      next.delete(key);
      emit(next);
    },
    markStagedDropped: (mode, threadId) => {
      const key = composerDraftRecordKey(mode, threadId);
      const current = snapshot.get(key);
      if (current === undefined || current.stagedDropped) return;
      const next = new Map(snapshot);
      next.set(key, { ...current, stagedDropped: true });
      emit(next);
    },
    purgeThread: (threadId) => {
      const suffix = `:${threadId}`;
      let changed = false;
      const next = new Map(snapshot);
      for (const key of snapshot.keys()) {
        if (!key.endsWith(suffix)) continue;
        next.delete(key);
        changed = true;
      }
      if (changed) emit(next);
    },
    clearAll: () => {
      if (snapshot.size === 0) return;
      emit(EMPTY_SNAPSHOT);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
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
): void {
  if (storage === undefined) return;
  try {
    if (snapshot.size === 0) {
      storage.removeItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY);
      return;
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
  } catch {
    // Ordinary client storage is best-effort; the in-memory snapshot still holds.
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
