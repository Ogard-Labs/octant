import {
  decodeSideChatDraftReturnReferences,
  decodeCodeReviewFindingReferences,
  MAX_CODE_REVIEW_CORRECTION_FINDINGS,
  type CodeReviewCorrectionPrepared,
  type CodeReviewFindingReference,
  MAX_SIDE_CHAT_DRAFT_RETURNS,
  type SideChatDraftPrepared,
  type SideChatDraftReturnReference,
} from "@octant/contracts";
import {
  asQueueReceiptStorage,
  markQueueDraftChanged,
  purgeQueueReceipts,
} from "../messageQueue/threadMessageQueueReceipts";

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
  readonly sideChatReturns?: ReadonlyArray<SideChatDraftReturnReference>;
  readonly sideChatReturnsInvalid?: true;
  readonly reviewFindingReferences?: ReadonlyArray<CodeReviewFindingReference>;
  readonly reviewFindingReferencesInvalid?: true;
}

export type ComposerDraftPersistResult =
  | { readonly status: "ok" }
  | {
      readonly status: "unpersisted";
      readonly reason: "unavailable" | "write-failed" | "remove-failed";
    };

export interface ComposerThreadDraftStore {
  readonly appendReviewCorrection: (
    prepared: CodeReviewCorrectionPrepared,
  ) => ComposerDraftPersistResult | { readonly status: "refused"; readonly message: string };
  readonly appendSideChatReturn: (
    prepared: SideChatDraftPrepared,
  ) => ComposerDraftPersistResult | { readonly status: "refused"; readonly message: string };
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
  // Keys whose latest local edit has not reached storage, including clears.
  const unpersistedKeys = new Set<string>();
  let listenVersion = 0;
  const revisions = new Map<string, number>();
  const listeners = new Set<() => void>();

  function purgeReceipts(
    keep: (scope: { readonly mode: string; readonly threadId: string }) => boolean,
  ): ComposerDraftPersistResult | undefined {
    if (purgeQueueReceipts(keep, asQueueReceiptStorage(storage))) return undefined;
    persistError = COMPOSER_DRAFT_REMOVE_FAILED_NOTE;
    notify();
    return { status: "unpersisted", reason: "remove-failed" };
  }

  function bump(key: string): void {
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
  }

  function notify(): void {
    listenVersion += 1;
    for (const listener of listeners) listener();
  }

  /**
   * Re-reading the whole stored snapshot costs a parse of every draft for
   * every thread, so a merge runs at most once per window. The first write in
   * a window still re-reads, which is what keeps another window's concurrent
   * draft from being clobbered; between windows the in-memory snapshot is
   * authoritative, kept current by the storage event handler.
   */
  const STORAGE_REREAD_WINDOW_MS = 250;
  let lastStorageMergeAt = 0;

  function persistMerged(
    mutate: (next: Map<string, ComposerThreadDraft>) => ReadonlyArray<string>,
    forceRead = false,
  ): ComposerDraftPersistResult {
    const now = Date.now();
    const reread = forceRead || unpersisted || now - lastStorageMergeAt >= STORAGE_REREAD_WINDOW_MS;
    const next = reread ? new Map(loadSnapshot(storage)) : new Map(snapshot);
    if (reread) {
      lastStorageMergeAt = now;
      if (unpersisted) {
        for (const key of unpersistedKeys) {
          const draft = snapshot.get(key);
          if (draft === undefined) next.delete(key);
          else next.set(key, draft);
        }
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
      unpersistedKeys.clear();
      persistError = undefined;
    } else {
      unpersisted = true;
      for (const key of changedKeys) unpersistedKeys.add(key);
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
      for (const key of unpersistedKeys) {
        const draft = snapshot.get(key);
        if (draft === undefined) next.delete(key);
        else next.set(key, draft);
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
        previous.stagedDropped !== current.stagedDropped ||
        JSON.stringify(previous.sideChatReturns ?? []) !==
          JSON.stringify(current.sideChatReturns ?? []) ||
        previous.sideChatReturnsInvalid !== current.sideChatReturnsInvalid ||
        JSON.stringify(previous.reviewFindingReferences ?? []) !==
          JSON.stringify(current.reviewFindingReferences ?? []) ||
        previous.reviewFindingReferencesInvalid !== current.reviewFindingReferencesInvalid
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
    appendReviewCorrection: (prepared) => {
      let incoming: ReadonlyArray<CodeReviewFindingReference>;
      try {
        incoming = decodeCodeReviewFindingReferences(prepared.references);
      } catch {
        return {
          status: "refused",
          message:
            "These review references are unavailable. Reopen Review to prepare the draft again.",
        };
      }
      if (
        incoming.length === 0 ||
        incoming.some(
          (ref) => ref.threadId !== prepared.threadId || ref.checkoutId !== prepared.checkoutId,
        )
      )
        return {
          status: "refused",
          message: "The review destination changed. Open Review from its owning task again.",
        };
      const key = composerDraftRecordKey("code", prepared.threadId);
      let refusal: string | undefined;
      let receiptSaved = true;
      const result = persistMerged((next) => {
        const current = next.get(key);
        if (current?.reviewFindingReferencesInvalid || current?.sideChatReturnsInvalid) {
          refusal =
            "This draft has an unavailable reference. Clear the draft or repair its source before adding review findings.";
          return [];
        }
        const previous = current?.reviewFindingReferences ?? [];
        if (previous.some((ref) => incoming.some((added) => added.findingId === ref.findingId))) {
          refusal =
            "A selected finding is already in the draft. Edit that request, or clear the draft before selecting it again.";
          return [];
        }
        if (previous.length + incoming.length > MAX_CODE_REVIEW_CORRECTION_FINDINGS) {
          refusal =
            "This draft already has too many review references. Send or clear it before adding more.";
          return [];
        }
        receiptSaved = markQueueDraftChanged(
          "code",
          prepared.threadId,
          asQueueReceiptStorage(storage),
        );
        const text =
          current !== undefined && current.text.length > 0
            ? `${current.text}\n\n${prepared.text}`
            : prepared.text;
        next.set(key, {
          ...current,
          text,
          caretIndex: current?.caretIndex ?? text.length,
          stagedDropped: current?.stagedDropped ?? false,
          reviewFindingReferences: [...previous, ...incoming],
        });
        return [key];
      }, true);
      if (refusal !== undefined) return { status: "refused", message: refusal };
      if (!receiptSaved) {
        persistError = COMPOSER_DRAFT_WRITE_FAILED_NOTE;
        notify();
        return { status: "unpersisted", reason: "write-failed" };
      }
      return result;
    },
    appendSideChatReturn: (prepared) => {
      const { destination, reference } = prepared;
      if (
        destination.threadId !== reference.sourceThreadId ||
        destination.mode !== reference.sourceMode
      )
        return {
          status: "refused",
          message: "The Side Chat destination changed. Open it again from its source.",
        };
      const key = composerDraftRecordKey(destination.mode, destination.threadId);
      let refusal: string | undefined;
      let receiptSaved = true;
      const result = persistMerged((next) => {
        const current = next.get(key);
        if (current?.sideChatReturnsInvalid || current?.reviewFindingReferencesInvalid) {
          refusal =
            "This draft has an unavailable Side Chat reference. Resolve or remove it before adding another.";
          return [];
        }
        const references = current?.sideChatReturns ?? [];
        if (references.some((item) => JSON.stringify(item) === JSON.stringify(reference))) {
          refusal = "This reply is already in the source draft. Edit the existing excerpt there.";
          return [];
        }
        if (references.length >= MAX_SIDE_CHAT_DRAFT_RETURNS) {
          refusal =
            "The source draft already has the maximum number of Side Chat replies. Send or clear that draft first.";
          return [];
        }
        receiptSaved = markQueueDraftChanged(
          destination.mode,
          destination.threadId,
          asQueueReceiptStorage(storage),
        );
        const text =
          current !== undefined && current.text.length > 0
            ? `${current.text}\n\n${prepared.text}`
            : prepared.text;
        next.set(key, {
          ...current,
          text,
          caretIndex: current?.caretIndex ?? text.length,
          stagedDropped: current?.stagedDropped ?? false,
          sideChatReturns: [...references, reference],
        });
        return [key];
      }, true);
      if (refusal !== undefined) return { status: "refused", message: refusal };
      if (!receiptSaved) {
        persistError = COMPOSER_DRAFT_WRITE_FAILED_NOTE;
        notify();
        return { status: "unpersisted", reason: "write-failed" };
      }
      return result;
    },
    read: (mode, threadId) => snapshot.get(composerDraftRecordKey(mode, threadId)),
    write: (mode, threadId, draft) => {
      const key = composerDraftRecordKey(mode, threadId);
      const normalized = normalizeDraft(draft);
      const receiptSaved =
        (snapshot.get(key)?.text === normalized?.text &&
          JSON.stringify(snapshot.get(key)?.sideChatReturns ?? []) ===
            JSON.stringify(normalized?.sideChatReturns ?? []) &&
          snapshot.get(key)?.sideChatReturnsInvalid === normalized?.sideChatReturnsInvalid &&
          JSON.stringify(snapshot.get(key)?.reviewFindingReferences ?? []) ===
            JSON.stringify(normalized?.reviewFindingReferences ?? []) &&
          snapshot.get(key)?.reviewFindingReferencesInvalid ===
            normalized?.reviewFindingReferencesInvalid) ||
        markQueueDraftChanged(mode, threadId, asQueueReceiptStorage(storage));
      const result = persistMerged((next) => {
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
          previous.stagedDropped === normalized.stagedDropped &&
          JSON.stringify(previous.sideChatReturns ?? []) ===
            JSON.stringify(normalized.sideChatReturns ?? []) &&
          previous.sideChatReturnsInvalid === normalized.sideChatReturnsInvalid &&
          JSON.stringify(previous.reviewFindingReferences ?? []) ===
            JSON.stringify(normalized.reviewFindingReferences ?? []) &&
          previous.reviewFindingReferencesInvalid === normalized.reviewFindingReferencesInvalid
        ) {
          return [];
        }
        next.set(key, normalized);
        return [key];
      });
      if (!receiptSaved) {
        persistError = COMPOSER_DRAFT_WRITE_FAILED_NOTE;
        notify();
        return { status: "unpersisted", reason: "write-failed" };
      }
      return result;
    },
    clear: (mode, threadId) => {
      const key = composerDraftRecordKey(mode, threadId);
      const receiptSaved =
        !snapshot.has(key) || markQueueDraftChanged(mode, threadId, asQueueReceiptStorage(storage));
      const result = persistMerged((next) => {
        if (!next.has(key) && !snapshot.has(key)) return [];
        next.delete(key);
        return [key];
      });
      if (!receiptSaved) {
        persistError = COMPOSER_DRAFT_REMOVE_FAILED_NOTE;
        notify();
        return { status: "unpersisted", reason: "remove-failed" };
      }
      return result;
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
      const refused = purgeReceipts((scope) => scope.threadId !== threadId);
      if (refused !== undefined) return refused;
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
      const refused = purgeReceipts((scope) => scope.mode !== mode || known.has(scope.threadId));
      if (refused !== undefined) return refused;
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
    clearAll: () => {
      const refused = purgeReceipts(() => false);
      if (refused !== undefined) return refused;
      return persistMerged((next) => {
        const changed = [...new Set([...next.keys(), ...snapshot.keys()])];
        next.clear();
        return changed;
      });
    },
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
  if (text.length === 0) return undefined;
  return {
    text,
    caretIndex: clampComposerCaret(draft.caretIndex, text.length),
    stagedDropped: draft.stagedDropped,
    ...(draft.sideChatReturns?.length ? { sideChatReturns: draft.sideChatReturns } : {}),
    ...(draft.sideChatReturnsInvalid ? { sideChatReturnsInvalid: true } : {}),
    ...(draft.reviewFindingReferences?.length
      ? { reviewFindingReferences: draft.reviewFindingReferences }
      : {}),
    ...(draft.reviewFindingReferencesInvalid ? { reviewFindingReferencesInvalid: true } : {}),
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
    const payload: Record<
      string,
      {
        text: string;
        caretIndex: number;
        stagedDropped?: boolean;
        sideChatReturns?: ReadonlyArray<SideChatDraftReturnReference>;
        sideChatReturnsInvalid?: true;
        reviewFindingReferences?: ReadonlyArray<CodeReviewFindingReference>;
        reviewFindingReferencesInvalid?: true;
      }
    > = {};
    for (const [key, draft] of snapshot) {
      payload[key] = {
        text: draft.text,
        caretIndex: draft.caretIndex,
        ...(draft.stagedDropped ? { stagedDropped: true } : {}),
        ...(draft.sideChatReturns?.length ? { sideChatReturns: draft.sideChatReturns } : {}),
        ...(draft.sideChatReturnsInvalid ? { sideChatReturnsInvalid: true } : {}),
        ...(draft.reviewFindingReferences?.length
          ? { reviewFindingReferences: draft.reviewFindingReferences }
          : {}),
        ...(draft.reviewFindingReferencesInvalid ? { reviewFindingReferencesInvalid: true } : {}),
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
  let sideChatReturns: ReadonlyArray<SideChatDraftReturnReference> | undefined;
  let invalid = "sideChatReturnsInvalid" in value && value.sideChatReturnsInvalid === true;
  if ("sideChatReturns" in value) {
    try {
      sideChatReturns = decodeSideChatDraftReturnReferences(value.sideChatReturns);
    } catch {
      invalid = true;
    }
  }
  let reviewFindingReferences: ReadonlyArray<CodeReviewFindingReference> | undefined;
  let invalidReview =
    "reviewFindingReferencesInvalid" in value && value.reviewFindingReferencesInvalid === true;
  if ("reviewFindingReferences" in value) {
    try {
      reviewFindingReferences = decodeCodeReviewFindingReferences(value.reviewFindingReferences);
    } catch {
      invalidReview = true;
    }
  }
  return normalizeDraft({
    text: value.text,
    caretIndex,
    stagedDropped,
    ...(sideChatReturns?.length ? { sideChatReturns } : {}),
    ...(invalid ? { sideChatReturnsInvalid: true } : {}),
    ...(reviewFindingReferences?.length ? { reviewFindingReferences } : {}),
    ...(invalidReview ? { reviewFindingReferencesInvalid: true } : {}),
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
      other.stagedDropped !== draft.stagedDropped ||
      JSON.stringify(other.sideChatReturns ?? []) !== JSON.stringify(draft.sideChatReturns ?? []) ||
      other.sideChatReturnsInvalid !== draft.sideChatReturnsInvalid ||
      JSON.stringify(other.reviewFindingReferences ?? []) !==
        JSON.stringify(draft.reviewFindingReferences ?? []) ||
      other.reviewFindingReferencesInvalid !== draft.reviewFindingReferencesInvalid
    ) {
      return false;
    }
  }
  return true;
}
