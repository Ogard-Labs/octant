import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  composerDraftRecordKey,
  composerThreadDrafts,
  type ComposerDraftMode,
  type ComposerThreadDraft,
  type ComposerThreadDraftStore,
} from "./composerThreadDraftStore";

export interface ComposerThreadDraftController {
  readonly text: string;
  readonly caretIndex: number;
  readonly stagedDropped: boolean;
  readonly setDraft: (text: string, caretIndex?: number) => void;
  readonly setCaret: (caretIndex: number) => void;
  readonly markStagedDropped: () => void;
  readonly clear: () => void;
  readonly readFor: (threadId: string) => ComposerThreadDraft | undefined;
  readonly writeFor: (threadId: string, text: string, caretIndex?: number) => void;
  readonly clearFor: (threadId: string) => void;
  readonly purge: (threadId: string) => void;
}

/**
 * One unsent composer draft for the thread currently on screen.
 *
 * The store is the source of truth, so leaving the thread, closing the tab, or
 * restarting the app restores the same text and caret. Empty text is a clear.
 */
export function useComposerThreadDraft(options: {
  readonly mode: ComposerDraftMode;
  readonly threadId: string | undefined;
  readonly store?: ComposerThreadDraftStore;
}): ComposerThreadDraftController {
  const store = options.store ?? composerThreadDrafts;
  const mode = options.mode;
  const threadIdRef = useRef(options.threadId);
  threadIdRef.current = options.threadId;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const current = snapshot.get(composerDraftRecordKey(mode, options.threadId));

  const setDraft = useCallback(
    (text: string, caretIndex?: number) => {
      writeDraft(store, mode, threadIdRef.current, text, caretIndex);
    },
    [mode, store],
  );

  const setCaret = useCallback(
    (caretIndex: number) => {
      const current = store.read(mode, threadIdRef.current);
      if (current === undefined) return;
      store.write(mode, threadIdRef.current, { ...current, caretIndex });
    },
    [mode, store],
  );

  const markStagedDropped = useCallback(() => {
    store.markStagedDropped(mode, threadIdRef.current);
  }, [mode, store]);

  const clear = useCallback(() => {
    store.clear(mode, threadIdRef.current);
  }, [mode, store]);

  const readFor = useCallback((threadId: string) => store.read(mode, threadId), [mode, store]);

  const writeFor = useCallback(
    (threadId: string, text: string, caretIndex?: number) => {
      writeDraft(store, mode, threadId, text, caretIndex);
    },
    [mode, store],
  );

  const clearFor = useCallback(
    (threadId: string) => {
      store.clear(mode, threadId);
    },
    [mode, store],
  );

  const purge = useCallback(
    (threadId: string) => {
      store.purgeThread(threadId);
    },
    [store],
  );

  return {
    text: current?.text ?? "",
    caretIndex: current?.caretIndex ?? 0,
    stagedDropped: current?.stagedDropped === true,
    setDraft,
    setCaret,
    markStagedDropped,
    clear,
    readFor,
    writeFor,
    clearFor,
    purge,
  };
}

function writeDraft(
  store: ComposerThreadDraftStore,
  mode: ComposerDraftMode,
  threadId: string | undefined,
  text: string,
  caretIndex: number | undefined,
): void {
  if (text.trim() === "") {
    store.clear(mode, threadId);
    return;
  }
  const previous = store.read(mode, threadId);
  store.write(mode, threadId, {
    text,
    caretIndex: caretIndex ?? previous?.caretIndex ?? text.length,
    stagedDropped: previous?.stagedDropped === true,
  });
}
