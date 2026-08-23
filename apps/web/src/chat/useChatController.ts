import {
  ChatClientFailure,
  createChatClient,
  type ChatAttachmentDiscard,
  type ChatAttachmentUpload,
  type ChatClient,
} from "@octant/client-runtime/chat-client";
import type {
  ChatBootstrap,
  ChatAttachmentId,
  ChatCommand,
  ChatCommandResult,
  ChatEventFrame,
  ChatThread,
  ChatThreadId,
  ChatThreadView,
} from "@octant/contracts/chat";
import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type { PreviewContextSelection } from "@octant/contracts/previews";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { MentionableThreadId } from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import type { ComposerThreadDraftStore } from "../composer/composerThreadDraftStore";
import { buildChatThreadNavigation, type ChatThreadNavigationItem } from "../shell/navigationModel";

export type ChatControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";

/**
 * The longest a dropped stream waits before trying the host again. Long enough
 * that a machine asleep for hours is not asking every quarter second, short
 * enough that waking it up catches the thread back up while the user is still
 * looking at it.
 */
const MAX_RECONNECT_DELAY_MS = 10_000;

/** The first wait after a failed catch-up, before the delay starts doubling. */
const MIN_RECONNECT_BACKOFF_MS = 100;

/** Background windows do not need to poll every thread while hidden. */
function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export interface ChatControllerOptions {
  readonly activeThreadId?: ChatThreadId;
  readonly client?: ChatClient;
  readonly navigationRefreshMs?: number;
  readonly reconnectDelayMs?: number;
  readonly readCursorStore?: ChatReadCursorStore;
  readonly draftStore?: ComposerThreadDraftStore;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export interface ChatReadCursorStore {
  readonly getSnapshot: () => ReadonlyMap<string, number>;
  /**
   * Thread ids the user explicitly asked to read as unread, over and above the
   * cursor comparison. A thread with no sequence advanced this sitting has
   * nothing for a dropped cursor to resurface — zero over zero — so the
   * explicit request is held here until the next mark spends it. Deliberately
   * shaped like Code's store: unread is the same sitting-scoped idea in both
   * modes.
   */
  readonly getMarkedUnread: () => ReadonlySet<string>;
  readonly mark: (threadId: ChatThreadId, sequence: number) => void;
  /**
   * Drops what this sitting has seen of a thread, so it reads as unread again
   * — and holds it unread even when no sequence advanced. The cursor only
   * ever moves forward on its own — a refresh must never spend a mark the user
   * did not see — but a person asking for the thread back in their unread list
   * is not the refresh path.
   */
  readonly unmark: (threadId: ChatThreadId) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createChatReadCursorStore(): ChatReadCursorStore {
  let snapshot: ReadonlyMap<string, number> = new Map();
  let markedUnread: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    getMarkedUnread: () => markedUnread,
    mark: (threadId, sequence) => {
      const key = String(threadId);
      // Reading a thread with no new sequence still spends an explicit unread
      // mark: the cursor has nowhere to move, but the user has now seen what
      // they asked to be reminded of.
      const spendsUnreadMark = markedUnread.has(key);
      if (spendsUnreadMark) {
        const nextMarked = new Set(markedUnread);
        nextMarked.delete(key);
        markedUnread = nextMarked;
      }
      if (sequence > (snapshot.get(key) ?? 0)) {
        const next = new Map(snapshot);
        next.set(key, sequence);
        snapshot = next;
      } else if (!spendsUnreadMark) {
        return;
      }
      announce();
    },
    unmark: (threadId) => {
      const key = String(threadId);
      if (!snapshot.has(key) && markedUnread.has(key)) return;
      if (snapshot.has(key)) {
        const next = new Map(snapshot);
        next.delete(key);
        snapshot = next;
      }
      const nextMarked = new Set(markedUnread);
      nextMarked.add(key);
      markedUnread = nextMarked;
      announce();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useChatController(options: ChatControllerOptions) {
  const navigationRefreshMs = options.navigationRefreshMs ?? 1_000;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  const client = useMemo(
    () =>
      options.client ??
      createChatClient({
        baseUrl: required(options.serverUrl),
        fetch: globalThis.fetch,
        windowCapability: required(options.windowCapability),
      }),
    [options.client, options.serverUrl, options.windowCapability],
  );
  const readCursorStore = useMemo(
    () => options.readCursorStore ?? createChatReadCursorStore(),
    [options.readCursorStore],
  );
  const [status, setStatus] = useState<ChatControllerStatus>("loading");
  const [bootstrap, setBootstrap] = useState<ChatBootstrap | undefined>(undefined);
  // A settings write carries the version it expects, and callers build that
  // command from a render. Two of them started before the first returns would
  // both claim the same version, and the server would reject the second — so
  // which one survived would be whichever arrived first, not the last choice
  // the user made. Settings writes queue, and each reads the version here as
  // it goes out. Updated wherever settings arrive, not during render, so a
  // queued write sees the previous one's result without waiting for React.
  const settingsVersion = useRef<ChatBootstrap["settings"]["version"] | undefined>(undefined);
  const settingsQueue = useRef<Promise<unknown>>(Promise.resolve());
  // A conflict means another window wrote these settings and the host reloaded
  // them. An update command carries the whole record, so a queued write
  // composed before that reload would be accepted at the new version and put
  // this window's stale research, endpoint, and personality values back over
  // the other window's. Queued writes check this and stand down instead.
  const settingsConflicts = useRef(0);
  const [activeView, setActiveView] = useState<ChatThreadView | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [settingsMessage, setSettingsMessage] = useState<string | undefined>(undefined);
  const composerDraft = useComposerThreadDraft({
    mode: "chat",
    threadId: options.activeThreadId === undefined ? undefined : String(options.activeThreadId),
    ...(options.draftStore === undefined ? {} : { store: options.draftStore }),
  });
  const pendingDraft = composerDraft.text;
  const readCursors = useSyncExternalStore(
    readCursorStore.subscribe,
    readCursorStore.getSnapshot,
    readCursorStore.getSnapshot,
  );
  const markedUnreadThreads = useSyncExternalStore(
    readCursorStore.subscribe,
    readCursorStore.getMarkedUnread,
    readCursorStore.getMarkedUnread,
  );
  const [followUpByThread, setFollowUpByThread] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [sequenceByThread, setSequenceByThread] = useState<ReadonlyMap<string, number>>(new Map());
  const [updatedAtByThread, setUpdatedAtByThread] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const mounted = useRef(true);
  const activeThreadIdRef = useRef(options.activeThreadId);
  const bootstrapGeneration = useRef(0);
  const threadGeneration = useRef(0);
  const streamAbort = useRef<AbortController | undefined>(undefined);
  const bootstrapped = useRef(false);
  const composerDraftRef = useRef(composerDraft);
  composerDraftRef.current = composerDraft;
  const knownDraftThreads = useRef<ReadonlySet<string> | undefined>(undefined);

  const reconcileDrafts = useCallback((threadIds: ReadonlyArray<string>) => {
    if (knownDraftThreads.current === undefined) {
      composerDraftRef.current.dropUnknown(threadIds);
    } else {
      for (const threadId of knownDraftThreads.current) {
        if (!threadIds.includes(threadId)) composerDraftRef.current.purge(threadId);
      }
    }
    knownDraftThreads.current = new Set(threadIds);
  }, []);

  const updatePendingDraft = useCallback((value: string, caretIndex?: number) => {
    if (caretIndex === undefined) composerDraftRef.current.setDraft(value);
    else composerDraftRef.current.setDraft(value, caretIndex);
  }, []);

  const setPendingDraftCaret = useCallback((caretIndex: number) => {
    composerDraftRef.current.setCaret(caretIndex);
  }, []);

  const reportError = useCallback((message: string) => {
    setErrorMessage(message);
  }, []);

  const recordSequence = useCallback((threadId: ChatThreadId, sequence: number) => {
    const key = String(threadId);
    setSequenceByThread((current) => {
      const previous = current.get(key) ?? 0;
      if (current.has(key) && sequence <= previous) return current;
      const next = new Map(current);
      next.set(key, sequence);
      return next;
    });
  }, []);

  const recordFollowUp = useCallback((threadId: ChatThreadId, open: boolean) => {
    const key = String(threadId);
    setFollowUpByThread((current) => {
      if (current.has(key) && current.get(key) === open) return current;
      const next = new Map(current);
      next.set(key, open);
      return next;
    });
  }, []);

  const recordUpdatedAt = useCallback((threadId: ChatThreadId, updatedAt: string) => {
    const key = String(threadId);
    setUpdatedAtByThread((current) => {
      if (current.get(key) === updatedAt) return current;
      const next = new Map(current);
      next.set(key, updatedAt);
      return next;
    });
  }, []);

  const applyAuthoritativeView = useCallback(
    (view: ChatThreadView, markRead: boolean) => {
      recordSequence(view.thread.id, view.lastSequence);
      recordFollowUp(view.thread.id, view.followUp?.state === "open");
      recordUpdatedAt(view.thread.id, view.thread.updatedAt);
      setActiveView(view);
      if (markRead) readCursorStore.mark(view.thread.id, view.lastSequence);
    },
    [readCursorStore, recordFollowUp, recordSequence, recordUpdatedAt],
  );

  /**
   * Record a thread as read at the newest sequence this window has heard of,
   * and spend any explicit unread mark, because the user asked — the row
   * menu's "Mark as read". The activation and stream marks stay tied to a
   * rendered view; this one is itself the user's gesture, so the freshest
   * summary this window holds is what they are declaring seen.
   */
  const markThreadRead = useCallback(
    (threadId: ChatThreadId) => {
      readCursorStore.mark(threadId, sequenceByThread.get(String(threadId)) ?? 0);
    },
    [readCursorStore, sequenceByThread],
  );

  const loadBootstrap = useCallback(async () => {
    const request = ++bootstrapGeneration.current;
    if (!bootstrapped.current) setStatus("loading");
    setErrorMessage(undefined);
    try {
      const next = await client.bootstrap();
      if (!mounted.current || request !== bootstrapGeneration.current) return false;
      bootstrapped.current = true;
      settingsVersion.current = next.settings.version;
      setBootstrap(next);
      reconcileDrafts(next.threads.map((thread) => String(thread.id)));
      setStatus("ready");
      return true;
    } catch (error) {
      if (!mounted.current || request !== bootstrapGeneration.current) return false;
      setStatus("disconnected");
      setErrorMessage(failureMessage(error));
      return false;
    }
  }, [client, reconcileDrafts]);

  const activateThread = useCallback(
    async (threadId: ChatThreadId) => {
      const request = ++threadGeneration.current;
      streamAbort.current?.abort();
      streamAbort.current = undefined;
      setErrorMessage(undefined);
      try {
        const view = await client.thread(threadId);
        if (!mounted.current || request !== threadGeneration.current) return;
        applyAuthoritativeView(view, true);
        setStatus("ready");

        const controller = new AbortController();
        const signal = controller.signal;
        streamAbort.current = controller;
        let cursor = view.lastSequence;
        let reconnectBackoffMs = MIN_RECONNECT_BACKOFF_MS;
        let reconnectFailed = false;

        /**
         * Catch up from the authoritative snapshot after the event stream
         * dropped, and wait before opening it again.
         *
         * A snapshot the client cannot fetch is exactly what a machine that
         * slept through the host's answer sees, so it is a reason to ask again
         * more slowly — never a reason to stop. Giving up here would freeze the
         * thread at whatever event happened to arrive last, with nothing on
         * screen saying so. The stream is only reopened once a snapshot has
         * actually been read, because the events after a gap mean nothing
         * without the state they continue from.
         */
        const resume = async (): Promise<"stop" | "again"> => {
          for (;;) {
            try {
              const recovered = await client.thread(threadId);
              if (!mounted.current || request !== threadGeneration.current) return "stop";
              applyAuthoritativeView(recovered, true);
              cursor = recovered.lastSequence;
              reconnectBackoffMs = MIN_RECONNECT_BACKOFF_MS;
              if (reconnectFailed) {
                reconnectFailed = false;
                setStatus("ready");
                setErrorMessage(undefined);
              }
              await waitForReconnect(signal, reconnectDelayMs);
              return "again";
            } catch (error) {
              if (!mounted.current || request !== threadGeneration.current || signal.aborted) {
                return "stop";
              }
              reconnectFailed = true;
              setStatus("disconnected");
              setErrorMessage(failureMessage(error));
              await waitForReconnect(signal, reconnectBackoffMs);
              if (!mounted.current || request !== threadGeneration.current || signal.aborted) {
                return "stop";
              }
              reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_RECONNECT_DELAY_MS);
            }
          }
        };

        for (;;) {
          if (!mounted.current || request !== threadGeneration.current || signal.aborted) {
            return;
          }
          try {
            let endedCleanly = true;
            const frames = openChatEventStream(client, threadId, cursor, signal);
            try {
              for (;;) {
                const next = await frames.next();
                if (next.done) break;
                const frame = next.value;
                if (!mounted.current || request !== threadGeneration.current || signal.aborted) {
                  return;
                }
                if (!acceptChatEventFrame(frame, threadId, cursor)) {
                  endedCleanly = false;
                  break;
                }
                recordSequence(threadId, frame.sequence);
                if (frame.event.kind === "follow-up-updated") {
                  recordFollowUp(threadId, frame.event.followUp.state === "open");
                }
                const refreshed = await client.thread(threadId);
                if (!mounted.current || request !== threadGeneration.current || signal.aborted) {
                  return;
                }
                applyAuthoritativeView(refreshed, true);
                cursor = refreshed.lastSequence;
              }
            } finally {
              await frames.return?.();
            }
            if (!endedCleanly) {
              if ((await resume()) === "stop") return;
              continue;
            }
            await waitForReconnect(signal, reconnectDelayMs);
          } catch {
            if (!mounted.current || request !== threadGeneration.current || signal.aborted) {
              return;
            }
            if ((await resume()) === "stop") return;
          }
        }
      } catch (error) {
        if (!mounted.current || request !== threadGeneration.current) return;
        setStatus("disconnected");
        setErrorMessage(failureMessage(error));
      }
    },
    [applyAuthoritativeView, client, reconnectDelayMs, recordFollowUp, recordSequence],
  );

  useEffect(() => {
    mounted.current = true;
    void loadBootstrap();
    return () => {
      mounted.current = false;
      bootstrapGeneration.current += 1;
      threadGeneration.current += 1;
      streamAbort.current?.abort();
    };
  }, [loadBootstrap]);

  useEffect(() => {
    if (bootstrap === undefined) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const refreshes: Array<Promise<void>> = [];
        for (const thread of bootstrap.threads) {
          if (thread.lifecycle === "active") {
            refreshes.push(
              (async () => {
                try {
                  const view = await client.thread(thread.id);
                  if (cancelled || !mounted.current) return;
                  recordSequence(view.thread.id, view.lastSequence);
                  recordFollowUp(view.thread.id, view.followUp?.state === "open");
                  recordUpdatedAt(view.thread.id, view.thread.updatedAt);
                } catch {
                  // Keep the indicator unknown or at its last authoritative value until refresh works.
                }
              })(),
            );
          }
        }
        await Promise.all(refreshes);
      } finally {
        inFlight = false;
      }
    };
    const schedule = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = documentIsVisible()
        ? setInterval(() => void refresh(), Math.max(10, navigationRefreshMs))
        : undefined;
    };
    const onVisibilityChange = () => {
      schedule();
      if (documentIsVisible()) void refresh();
    };
    schedule();
    if (documentIsVisible()) void refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [bootstrap, client, navigationRefreshMs, recordFollowUp, recordSequence, recordUpdatedAt]);

  useEffect(() => {
    activeThreadIdRef.current = options.activeThreadId;
    threadGeneration.current += 1;
    streamAbort.current?.abort();
    streamAbort.current = undefined;
    if (options.activeThreadId === undefined) {
      return;
    }
    void activateThread(options.activeThreadId);
  }, [activateThread, options.activeThreadId]);

  const navigation = useMemo((): ReadonlyArray<ChatThreadNavigationItem> => {
    if (bootstrap === undefined) return [];
    const items = [];
    for (const thread of bootstrap.threads) {
      if (thread.lifecycle === "active") {
        items.push({
          ...(followUpByThread.get(String(thread.id)) === undefined
            ? {}
            : { followUpOpen: followUpByThread.get(String(thread.id))! }),
          ...(sequenceByThread.get(String(thread.id)) === undefined
            ? {}
            : { lastSequence: sequenceByThread.get(String(thread.id))! }),
          ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
          readSequence: readCursors.get(String(thread.id)) ?? 0,
          threadId: String(thread.id),
          title: thread.title,
          updatedAt: updatedAtByThread.get(String(thread.id)) ?? thread.updatedAt,
        });
      }
    }
    const built = buildChatThreadNavigation(items);
    if (markedUnreadThreads.size === 0) return built;
    // The explicit unread mark wins over the cursor comparison, including for
    // a thread whose latest sequence this window has not heard yet.
    return built.map((item) =>
      markedUnreadThreads.has(item.threadId) ? { ...item, unread: true } : item,
    );
  }, [
    bootstrap,
    followUpByThread,
    markedUnreadThreads,
    readCursors,
    sequenceByThread,
    updatedAtByThread,
  ]);

  async function execute(command: ChatCommand): Promise<ChatCommandResult | undefined> {
    const commandThreadId = "threadId" in command ? String(command.threadId) : undefined;
    setErrorMessage(undefined);
    if (command.kind === "update-chat-settings") setSettingsMessage(undefined);
    try {
      const result = await client.execute(command);
      if (!mounted.current) return undefined;
      if (
        (result.kind === "deleted" || result.kind === "deletion-requested") &&
        "threadId" in command
      ) {
        composerDraftRef.current.purge(String(command.threadId));
      }
      if (result.kind === "follow-up-updated") {
        recordFollowUp(result.followUp.threadId, result.followUp.state === "open");
      }
      if (result.kind === "settings-updated") {
        settingsVersion.current = result.settings.version;
        setBootstrap((current) =>
          current === undefined || result.settings.version < current.settings.version
            ? current
            : { ...current, settings: result.settings },
        );
        setStatus("ready");
        return result;
      }
      const currentThreadId = activeThreadIdRef.current;
      if (
        currentThreadId !== undefined &&
        "threadId" in command &&
        String(command.threadId) === String(currentThreadId)
      ) {
        // A branch targets the active thread but mints a different one, so
        // reactivating the target alone would leave this controller's thread
        // list unaware of the thread the command just created.
        if (result.kind === "thread-created") void loadBootstrap();
        void activateThread(currentThreadId);
      } else {
        await loadBootstrap();
      }
      return result;
    } catch (error) {
      if (!mounted.current) return undefined;
      if (
        commandThreadId !== undefined &&
        String(activeThreadIdRef.current ?? "") !== commandThreadId
      ) {
        return undefined;
      }
      if (failureCategory(error) === "stale") {
        if (command.kind === "update-chat-settings") settingsConflicts.current += 1;
        setStatus("conflict-reload");
        const reloaded = await loadBootstrap();
        if (command.kind === "update-chat-settings") {
          setSettingsMessage(
            reloaded
              ? "Chat defaults changed elsewhere. Current authoritative values were loaded; review them and save again."
              : "Chat defaults changed elsewhere but could not be reloaded. Reconnect, reload the current values, and try again.",
          );
        }
        const currentThreadId = activeThreadIdRef.current;
        if (currentThreadId !== undefined) void activateThread(currentThreadId);
        return undefined;
      }
      setErrorMessage(failureMessage(error));
      if (command.kind === "update-chat-settings") setSettingsMessage(failureMessage(error));
      return undefined;
    }
  }

  async function sendTurn(
    prompt: string,
    attachmentIds: ReadonlyArray<ChatAttachmentId> = [],
    previewSelections: ReadonlyArray<PreviewContextSelection> = [],
    canvasSelections: ReadonlyArray<CanvasContextSelection> = [],
    extensionSelections: ReadonlyArray<ExtensionSelection> = [],
    /**
     * `#thread` mentions this turn points at. Ids only: the server resolves
     * each one against the sender's own authority when the turn runs, so the
     * mention is context for this turn and never part of the message.
     */
    threadMentionIds: ReadonlyArray<MentionableThreadId> = [],
    /**
     * The version a caller already knows the thread reached, for a send that
     * follows another command it issued. This closure holds the view from the
     * render that made it, so without this the send would present a version
     * the earlier command has already moved past and be refused as stale.
     */
    expectedVersion?: ChatThread["version"],
  ): Promise<boolean> {
    if (
      activeView === undefined ||
      String(activeView.thread.id) !== String(options.activeThreadId ?? "")
    ) {
      return false;
    }
    const sendingThreadId = String(activeView.thread.id);
    const previousDraft = composerDraftRef.current.readFor(sendingThreadId);
    composerDraftRef.current.clearFor(sendingThreadId);
    const revisionAfterClear = composerDraftRef.current.revisionFor(sendingThreadId);
    const result = await execute({
      kind: "send-chat-turn",
      threadId: activeView.thread.id,
      expectedVersion: expectedVersion ?? activeView.thread.version,
      prompt,
      ...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
      ...(previewSelections.length === 0 ? {} : { previewSelections: [...previewSelections] }),
      ...(canvasSelections.length === 0 ? {} : { canvasSelections: [...canvasSelections] }),
      ...(extensionSelections.length === 0
        ? {}
        : { extensionSelections: [...extensionSelections] }),
      ...(threadMentionIds.length === 0 ? {} : { threadMentionIds: [...threadMentionIds] }),
    });
    if (
      result === undefined &&
      composerDraftRef.current.revisionFor(sendingThreadId) === revisionAfterClear
    ) {
      composerDraftRef.current.restoreFor(sendingThreadId, {
        text: prompt,
        caretIndex: previousDraft?.caretIndex ?? prompt.length,
        stagedDropped: previousDraft?.stagedDropped === true,
      });
    }
    return result !== undefined;
  }

  async function updateSettings(
    command: Extract<ChatCommand, { kind: "update-chat-settings" }>,
  ): Promise<boolean> {
    const startedAt = settingsConflicts.current;
    const started = settingsQueue.current;
    const write = started
      .catch(() => undefined)
      .then(async () => {
        if (settingsConflicts.current !== startedAt) return false;
        const expectedVersion = settingsVersion.current ?? command.expectedVersion;
        const result = await execute({ ...command, expectedVersion });
        return result?.kind === "settings-updated";
      });
    settingsQueue.current = write;
    return await write;
  }

  async function upload(input: ChatAttachmentUpload) {
    setErrorMessage(undefined);
    try {
      const attachment = await client.upload(input);
      if (!mounted.current) return attachment;
      const currentThreadId = activeThreadIdRef.current;
      if (currentThreadId !== undefined && String(currentThreadId) === String(input.threadId)) {
        const refreshed = await client.thread(currentThreadId);
        if (
          mounted.current &&
          String(activeThreadIdRef.current ?? "") === String(currentThreadId)
        ) {
          applyAuthoritativeView(refreshed, true);
        }
      }
      return attachment;
    } catch (error) {
      if (!mounted.current) throw error;
      if (String(activeThreadIdRef.current ?? "") !== String(input.threadId)) throw error;
      setErrorMessage(failureMessage(error));
      throw error;
    }
  }

  async function discard(input: ChatAttachmentDiscard) {
    setErrorMessage(undefined);
    try {
      const attachment = await client.discard(input);
      if (!mounted.current) return attachment;
      const currentThreadId = activeThreadIdRef.current;
      if (currentThreadId !== undefined && String(currentThreadId) === String(input.threadId)) {
        const refreshed = await client.thread(currentThreadId);
        if (
          mounted.current &&
          String(activeThreadIdRef.current ?? "") === String(currentThreadId)
        ) {
          applyAuthoritativeView(refreshed, true);
        }
      }
      return attachment;
    } catch (error) {
      if (!mounted.current) throw error;
      if (String(activeThreadIdRef.current ?? "") !== String(input.threadId)) throw error;
      setErrorMessage(failureMessage(error));
      throw error;
    }
  }

  const visibleActiveView =
    activeView !== undefined &&
    String(activeView.thread.id) === String(options.activeThreadId ?? "")
      ? activeView
      : undefined;

  return {
    activeView: visibleActiveView,
    bootstrap,
    errorMessage,
    discard,
    execute,
    markThreadRead,
    navigation,
    pendingDraft,
    pendingDraftCaret: composerDraft.caretIndex,
    draftStagedDropped: composerDraft.stagedDropped,
    draftPersistError: composerDraft.persistError,
    markDraftStagedDropped: composerDraft.markStagedDropped,
    purgeThreadDraft: composerDraft.purge,
    /**
     * Reload the authoritative thread list. For a controller instance that
     * only feeds navigation (no active thread), this is how it learns of a
     * thread another instance created — e.g. a branch minted from a tab.
     */
    refreshNavigation: loadBootstrap,
    reportError,
    retry: () =>
      bootstrapped.current
        ? options.activeThreadId === undefined
          ? loadBootstrap()
          : activateThread(options.activeThreadId)
        : loadBootstrap(),
    sendTurn,
    settingsMessage,
    setPendingDraft: updatePendingDraft,
    setPendingDraftCaret,
    status,
    updateSettings,
    upload,
  };
}

function required(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Chat controller requires serverUrl and windowCapability.");
  return value;
}

function failureCategory(error: unknown): string | undefined {
  return error instanceof ChatClientFailure ? error.category : undefined;
}

function failureMessage(error: unknown): string {
  if (error instanceof ChatClientFailure) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Octant Chat service is unavailable.";
}

export type ChatController = ReturnType<typeof useChatController>;

export function acceptChatEventFrame(
  frame: ChatEventFrame,
  expectedThreadId: ChatThreadId,
  afterSequence: number,
): boolean {
  if (String(frame.threadId) !== String(expectedThreadId)) return false;
  return Number.isFinite(frame.sequence) && frame.sequence > afterSequence;
}

async function waitForReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, delayMs));
    signal.addEventListener("abort", finish, { once: true });
  });
}

function openChatEventStream(
  client: ChatClient,
  threadId: ChatThreadId,
  afterSequence: number,
  signal: AbortSignal,
): AsyncIterator<ChatEventFrame> {
  return client.subscribe(threadId, afterSequence, signal)[Symbol.asyncIterator]();
}
