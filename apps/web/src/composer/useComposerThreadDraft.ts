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
  readonly persistError: string | undefined;
  readonly setDraft: (text: string, caretIndex?: number) => void;
  readonly setCaret: (caretIndex: number) => void;
  readonly markStagedDropped: (threadId?: string) => void;
  readonly clear: () => void;
  readonly readFor: (threadId: string) => ComposerThreadDraft | undefined;
  readonly writeFor: (
    threadId: string,
    text: string,
    caretIndex?: number,
    stagedDropped?: boolean,
  ) => void;
  readonly restoreFor: (threadId: string, draft: ComposerThreadDraft) => void;
  readonly clearFor: (threadId: string) => void;
  readonly purge: (threadId: string) => void;
  readonly dropUnknown: (knownThreadIds: ReadonlyArray<string>) => void;
  readonly revisionFor: (threadId: string) => number;
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
  useSyncExternalStore(store.subscribe, store.getListenVersion, store.getListenVersion);
  const snapshot = store.getSnapshot();
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

  const markStagedDropped = useCallback(
    (threadId?: string) => {
      store.markStagedDropped(mode, threadId ?? threadIdRef.current);
    },
    [mode, store],
  );

  const clear = useCallback(() => {
    store.clear(mode, threadIdRef.current);
  }, [mode, store]);

  const readFor = useCallback((threadId: string) => store.read(mode, threadId), [mode, store]);

  const writeFor = useCallback(
    (threadId: string, text: string, caretIndex?: number, stagedDropped?: boolean) => {
      writeDraft(store, mode, threadId, text, caretIndex, stagedDropped);
    },
    [mode, store],
  );

  const restoreFor = useCallback(
    (threadId: string, draft: ComposerThreadDraft) => {
      store.write(mode, threadId, draft);
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

  const dropUnknown = useCallback(
    (knownThreadIds: ReadonlyArray<string>) => {
      store.dropUnknownThreads(mode, knownThreadIds);
    },
    [mode, store],
  );

  const revisionFor = useCallback(
    (threadId: string) => store.revision(mode, threadId),
    [mode, store],
  );

  return {
    text: current?.text ?? "",
    caretIndex: current?.caretIndex ?? 0,
    stagedDropped: current?.stagedDropped === true,
    persistError: store.persistError(),
    setDraft,
    setCaret,
    markStagedDropped,
    clear,
    readFor,
    writeFor,
    restoreFor,
    clearFor,
    purge,
    dropUnknown,
    revisionFor,
  };
}

function writeDraft(
  store: ComposerThreadDraftStore,
  mode: ComposerDraftMode,
  threadId: string | undefined,
  text: string,
  caretIndex: number | undefined,
  stagedDropped?: boolean,
): void {
  if (text.trim() === "") {
    store.clear(mode, threadId);
    return;
  }
  const previous = store.read(mode, threadId);
  store.write(mode, threadId, {
    text,
    caretIndex: caretIndex ?? previous?.caretIndex ?? text.length,
    stagedDropped: stagedDropped ?? previous?.stagedDropped === true,
  });
}
