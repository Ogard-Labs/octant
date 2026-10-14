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
  ChatNavigationThread,
  ChatSubmissionId,
  ChatThread,
  ChatThreadId,
  ChatThreadView,
  ChatThreadWindow,
  ChatTurnId,
} from "@octant/contracts/chat";
import { decodeChatSubmissionId } from "@octant/contracts/chat";
import { decodeUtcTimestamp } from "@octant/contracts";
import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type { PreviewContextSelection } from "@octant/contracts/previews";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { MentionableThreadId } from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import { applyChatAttemptFrame } from "./chatStreamFrames";
import {
  appendChatPage,
  CHAT_WINDOW_PAGE_TURNS,
  holdsTurn,
  joinDetachedRange,
  prependChatPage,
  refreshChatTail,
  wholeThreadWindowState,
  type ChatTranscriptWindowState,
} from "./chatTranscriptWindow";
import type { ComposerThreadDraftStore } from "../composer/composerThreadDraftStore";
import { failureMessage } from "../lib/failureMessage";
import { waitForReconnect } from "../lib/waitForReconnect";
import {
  buildChatThreadNavigation,
  sameLiveTurn,
  type ChatThreadNavigationItem,
  type LiveTurnFacts,
} from "../shell/navigationModel";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import { createReadCursorStore, type ReadCursorStore } from "../threads/readCursorStore";

export type ChatControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";

/** What completing, reopening, snoozing, or waking a thread answered. */
export type ChatThreadRestOutcome =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly message: string };

/**
 * The longest a dropped stream waits before trying the host again. Long enough
 * that a machine asleep for hours is not asking every quarter second, short
 * enough that waking it up catches the thread back up while the user is still
 * looking at it.
 */
const MAX_RECONNECT_DELAY_MS = 10_000;

/** The first wait after a failed catch-up, before the delay starts doubling. */
const MIN_RECONNECT_BACKOFF_MS = 100;
const CHAT_UNAVAILABLE = "Octant Chat service is unavailable.";

/**
 * A stable identifier for one extension/skill selection. `ExtensionSelection`
 * has no single id field the way attachments and canvas/preview selections
 * do, so the fields that distinguish one selection from another are encoded
 * explicitly.
 */
function extensionSelectionKey(selection: ExtensionSelection): unknown {
  const origin = [selection.origin.kind, String(selection.origin.reference)];
  if (selection.kind === "skill") {
    return [
      "skill",
      String(selection.skillId),
      selection.packageVersion === undefined ? null : String(selection.packageVersion),
      String(selection.packageDigest),
      String(selection.catalogEpoch),
      origin,
    ];
  }
  return [
    "plugin",
    String(selection.extensionId),
    String(selection.packageId),
    selection.componentId === undefined ? null : String(selection.componentId),
    String(selection.packageVersion),
    String(selection.packageDigest),
    String(selection.catalogEpoch),
    origin,
  ];
}

/**
 * The identity a retry must match to be treated as "the same submission" by
 * the server's submissionId reconciliation. Keying off thread + text alone
 * let a retry that changed attachments, selections, extensions, or mentions
 * reuse the prior submissionId; the server then matched by submissionId plus
 * body text and handed back the original turn, silently discarding whatever
 * about the resend had actually changed. JSON-encoding the whole tuple, rather
 * than joining strings, keeps adjacent fields from bleeding into each other.
 */
function submissionIntentKey(
  threadId: string,
  prompt: string,
  attachmentIds: ReadonlyArray<ChatAttachmentId>,
  previewSelections: ReadonlyArray<PreviewContextSelection>,
  canvasSelections: ReadonlyArray<CanvasContextSelection>,
  extensionSelections: ReadonlyArray<ExtensionSelection>,
  threadMentionIds: ReadonlyArray<MentionableThreadId>,
): string {
  return JSON.stringify([
    threadId,
    prompt,
    attachmentIds.map((id) => String(id)),
    previewSelections.map((selection) => String(selection.id)),
    canvasSelections.map((selection) => String(selection.id)),
    extensionSelections.map(extensionSelectionKey),
    threadMentionIds.map((id) => String(id)),
  ]);
}

export interface ChatControllerOptions {
  readonly activeThreadId?: ChatThreadId;
  readonly client?: ChatClient;
  readonly navigationRefreshMs?: number;
  readonly changeRevision?: number;
  readonly reconnectDelayMs?: number;
  readonly readCursorStore?: ChatReadCursorStore;
  readonly draftStore?: ComposerThreadDraftStore;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

/** Chat keeps its own record, so Code's cursors never read as Chat's. */
const CHAT_READ_CURSOR_STORAGE_KEY = "octant.chat.readCursors.v1";

/**
 * Chat's read cursors. The store itself is shared with Code — unread is the
 * same idea in both modes — and survives a relaunch, so a thread the user read
 * yesterday does not come back unread today.
 */
export type ChatReadCursorStore = ReadCursorStore<ChatThreadId>;

export function createChatReadCursorStore(
  storage?: Pick<Storage, "getItem" | "setItem"> | undefined,
): ChatReadCursorStore {
  return createReadCursorStore<ChatThreadId>({
    storageKey: CHAT_READ_CURSOR_STORAGE_KEY,
    ...(storage === undefined ? {} : { storage }),
  });
}

/** Clients that already answered 404 for the window route; asked once per client. */
const clientsWithoutChatWindow = new WeakSet<ChatClient>();

/** A read of the newest turns: a window, or the whole thread from a host without one. */
type ChatTailRead =
  | { readonly kind: "window"; readonly window: ChatThreadWindow }
  | { readonly kind: "whole"; readonly view: ChatThreadView };

async function readChatTail(client: ChatClient, threadId: ChatThreadId): Promise<ChatTailRead> {
  // A test double or an older client may not carry the window read at all.
  if (typeof client.threadWindow === "function" && !clientsWithoutChatWindow.has(client)) {
    try {
      return {
        kind: "window",
        window: await client.threadWindow(threadId, { limit: CHAT_WINDOW_PAGE_TURNS }),
      };
    } catch (error) {
      if (!(error instanceof ChatClientFailure && error.status === 404)) throw error;
      clientsWithoutChatWindow.add(client);
    }
  }
  return { kind: "whole", view: await client.thread(threadId) };
}

function sameSnooze(
  left: ChatThread["snooze"] | undefined,
  right: ChatThread["snooze"] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.until === right.until && left.at === right.at && left.duringTurn === right.duringTurn;
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
  // The stream loop grows the view from consecutive frames faster than React
  // re-renders, so it reads the latest view here rather than from state: two
  // frames applied to the same rendered view would lose the first one's text.
  const activeViewRef = useRef<ChatThreadView | undefined>(undefined);
  // `activeView` holds the newest turns; this says what else is loaded or
  // offered. The ref serves async page reads the way `activeViewRef` does.
  const [transcriptWindow, setTranscriptWindow] = useState<ChatTranscriptWindowState | undefined>(
    undefined,
  );
  const transcriptWindowRef = useRef<ChatTranscriptWindowState | undefined>(undefined);
  // Set when the open thread changes: the next newest read replaces what is
  // loaded, so leaving a thread releases its earlier pages.
  const releaseLoadedPages = useRef(true);
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
  const [executingByThread, setExecutingByThread] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [liveTurnByThread, setLiveTurnByThread] = useState<ReadonlyMap<string, LiveTurnFacts>>(
    new Map(),
  );
  const [sequenceByThread, setSequenceByThread] = useState<ReadonlyMap<string, number>>(new Map());
  const [updatedAtByThread, setUpdatedAtByThread] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const mounted = useRef(true);
  const activeThreadIdRef = useRef(options.activeThreadId);
  const bootstrapGeneration = useRef(0);
  const navigationGeneration = useRef(0);
  const threadGeneration = useRef(0);
  const streamAbort = useRef<AbortController | undefined>(undefined);
  const pendingSubmissionIds = useRef(new Map<string, ChatSubmissionId>());
  const bootstrapped = useRef(false);
  const composerDraftRef = useRef(composerDraft);
  // Why a ref and not the error line: `execute` deliberately says nothing on
  // screen about a command aimed at a thread that is not open, and reloads a
  // stale one without a word. Both are still refusals the caller may need to
  // report, so the reason is kept here where recording it disturbs nothing.
  const lastExecuteError = useRef<string | undefined>(undefined);
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

  const applyNavigation = useCallback((threads: ReadonlyArray<ChatNavigationThread>) => {
    setSequenceByThread((current) => {
      let changed = false;
      const next = new Map(current);
      for (const thread of threads) {
        const key = String(thread.id);
        if (!current.has(key) || thread.lastSequence > (current.get(key) ?? 0)) {
          next.set(key, thread.lastSequence);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setFollowUpByThread((current) => {
      let changed = false;
      const next = new Map(current);
      for (const thread of threads) {
        const key = String(thread.id);
        if (current.get(key) !== thread.followUpOpen) {
          next.set(key, thread.followUpOpen);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setExecutingByThread((current) => {
      let changed = false;
      const next = new Map(current);
      for (const thread of threads) {
        const key = String(thread.id);
        if (current.get(key) !== thread.executing) {
          next.set(key, thread.executing);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setLiveTurnByThread((current) => {
      let changed = false;
      const next = new Map(current);
      for (const thread of threads) {
        const key = String(thread.id);
        const live =
          thread.turnStartedAt === undefined
            ? undefined
            : {
                turnStartedAt: thread.turnStartedAt,
                ...(thread.liveStep === undefined ? {} : { liveStep: thread.liveStep }),
              };
        if (sameLiveTurn(current.get(key), live)) continue;
        if (live === undefined) next.delete(key);
        else next.set(key, live);
        changed = true;
      }
      return changed ? next : current;
    });
    setUpdatedAtByThread((current) => {
      let changed = false;
      const next = new Map(current);
      for (const thread of threads) {
        const key = String(thread.id);
        if (current.get(key) !== thread.updatedAt) {
          next.set(key, thread.updatedAt);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    // A thread's rest can change without this window asking for it — a
    // message sent from another window reopens it, a wake command lands
    // elsewhere — so the navigation read is what keeps the bootstrap rows
    // honest about it, the way it already does for their activity.
    setBootstrap((current) => {
      if (current === undefined) return current;
      const byId = new Map(threads.map((thread) => [String(thread.id), thread] as const));
      let changed = false;
      const nextThreads = current.threads.map((thread) => {
        const reported = byId.get(String(thread.id));
        if (reported === undefined) return thread;
        if (
          thread.completedAt === reported.completedAt &&
          sameSnooze(thread.snooze, reported.snooze)
        ) {
          return thread;
        }
        changed = true;
        const { completedAt: _completedAt, snooze: _snooze, ...rest } = thread;
        return {
          ...rest,
          ...(reported.completedAt === undefined ? {} : { completedAt: reported.completedAt }),
          ...(reported.snooze === undefined ? {} : { snooze: reported.snooze }),
        };
      });
      return changed ? { ...current, threads: nextThreads } : current;
    });
  }, []);

  const applyAuthoritativeView = useCallback(
    (view: ChatThreadView, markRead: boolean) => {
      recordSequence(view.thread.id, view.lastSequence);
      recordFollowUp(view.thread.id, view.followUp?.state === "open");
      recordUpdatedAt(view.thread.id, view.thread.updatedAt);
      activeViewRef.current = view;
      setActiveView(view);
      if (markRead) readCursorStore.markDeferred(view.thread.id, view.lastSequence);
    },
    [readCursorStore, recordFollowUp, recordSequence, recordUpdatedAt],
  );

  const applyWindowState = useCallback((next: ChatTranscriptWindowState | undefined) => {
    transcriptWindowRef.current = next;
    setTranscriptWindow(next);
  }, []);

  /**
   * Publish a new run of newest turns. A detached range that now shares a
   * turn with it joins it, so the client never holds two runs that touch.
   */
  const applyTail = useCallback(
    (view: ChatThreadView, state: ChatTranscriptWindowState, markRead: boolean) => {
      let tail = view;
      let next = state;
      if (next.detached !== undefined) {
        const joined = joinDetachedRange(tail, next.hasEarlier, next.detached);
        if (joined !== undefined) {
          const { detached: _joined, ...rest } = next;
          tail = joined.view;
          next = { ...rest, hasEarlier: joined.hasEarlier };
        }
      }
      applyAuthoritativeView(tail, markRead);
      applyWindowState({ ...next, offerEarlier: next.offerEarlier || next.hasEarlier });
    },
    [applyAuthoritativeView, applyWindowState],
  );

  /**
   * Read the newest turns of the open thread and join them onto what is
   * loaded. Every read that refreshes the thread on screen goes through here,
   * so a reconnect, a frame the view cannot apply, or a command's answer
   * keeps the earlier pages the reader loaded while the two runs still touch.
   */
  const refreshTail = useCallback(
    async (
      threadId: ChatThreadId,
      isCurrent: () => boolean,
    ): Promise<ChatThreadView | undefined> => {
      const read = await readChatTail(client, threadId);
      if (!isCurrent()) return undefined;
      const threadKey = String(threadId);
      if (read.kind === "whole") {
        applyAuthoritativeView(read.view, true);
        applyWindowState(wholeThreadWindowState(read.view));
        releaseLoadedPages.current = false;
        return read.view;
      }
      const current = activeViewRef.current;
      const state = transcriptWindowRef.current;
      const release = releaseLoadedPages.current;
      releaseLoadedPages.current = false;
      const newest = read.window;
      if (
        release ||
        current === undefined ||
        state === undefined ||
        !state.windowed ||
        state.threadKey !== threadKey ||
        String(current.thread.id) !== threadKey
      ) {
        applyTail(
          newest.view,
          {
            threadKey,
            windowed: true,
            hasEarlier: newest.hasEarlier,
            offerEarlier: newest.hasEarlier,
            supersededTurnCount: newest.supersededTurnCount,
            earlier: "idle",
          },
          true,
        );
        return activeViewRef.current;
      }
      const refreshed = refreshChatTail(current, state.hasEarlier, newest);
      // An edit superseded turns since the last read; a detached range may
      // hold some of them, so it is let go and the newest turns show.
      const { detached, ...rest } = state;
      const keepDetached =
        detached !== undefined && newest.supersededTurnCount === state.supersededTurnCount;
      applyTail(
        refreshed.view,
        {
          ...rest,
          hasEarlier: refreshed.hasEarlier,
          supersededTurnCount: newest.supersededTurnCount,
          ...(keepDetached ? { detached } : {}),
        },
        true,
      );
      return activeViewRef.current;
    },
    [applyAuthoritativeView, applyTail, applyWindowState, client],
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
      setErrorMessage(failureMessage(error, CHAT_UNAVAILABLE));
      return false;
    }
  }, [client, reconcileDrafts]);

  const activateThread = useCallback(
    async (threadId: ChatThreadId) => {
      const request = ++threadGeneration.current;
      streamAbort.current?.abort();
      streamAbort.current = undefined;
      setErrorMessage(undefined);
      const isCurrent = () => mounted.current && request === threadGeneration.current;
      try {
        const view = await refreshTail(threadId, isCurrent);
        if (view === undefined) return;
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
              const recovered = await refreshTail(threadId, isCurrent);
              if (recovered === undefined) return "stop";
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
              setErrorMessage(failureMessage(error, CHAT_UNAVAILABLE));
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
                // A compaction changes what the model sees next, not the
                // thread: there is nothing to re-read and nothing unread.
                if (frame.event.kind === "compaction-settled") {
                  cursor = frame.sequence;
                  continue;
                }
                recordSequence(threadId, frame.sequence);
                if (frame.event.kind === "follow-up-updated") {
                  recordFollowUp(threadId, frame.event.followUp.state === "open");
                }
                // A streaming delta grows the view in place. Anything the
                // frame cannot settle on its own re-reads the thread, which
                // is what every frame did before frames carried their body.
                const grown = applyChatAttemptFrame(activeViewRef.current, frame);
                if (grown !== undefined) {
                  activeViewRef.current = grown;
                  setActiveView(grown);
                  readCursorStore.markDeferred(threadId, frame.sequence);
                  cursor = frame.sequence;
                  continue;
                }
                const refreshed = await refreshTail(threadId, () => isCurrent() && !signal.aborted);
                if (refreshed === undefined) return;
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
        setErrorMessage(failureMessage(error, CHAT_UNAVAILABLE));
      }
    },
    [client, readCursorStore, reconnectDelayMs, recordFollowUp, recordSequence, refreshTail],
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
    if (bootstrap === undefined || navigationRefreshMs <= 0) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      const request = ++navigationGeneration.current;
      try {
        try {
          const next = await client.navigation();
          if (cancelled || !mounted.current || request !== navigationGeneration.current) return;
          applyNavigation(next.threads);
        } catch {
          // Keep the indicator unknown or at its last authoritative value until refresh works.
        }
      } finally {
        inFlight = false;
      }
    };
    const stop = scheduleVisibleInterval(() => void refresh(), Math.max(10, navigationRefreshMs), {
      runImmediately: true,
    });
    return () => {
      cancelled = true;
      navigationGeneration.current += 1;
      stop();
    };
  }, [applyNavigation, bootstrap, client, navigationRefreshMs]);

  useEffect(() => {
    if (
      options.changeRevision === undefined ||
      options.changeRevision <= 0 ||
      bootstrap === undefined
    )
      return;
    let cancelled = false;
    const request = ++navigationGeneration.current;
    void client
      .navigation()
      .then((next) => {
        if (!cancelled && mounted.current && request === navigationGeneration.current) {
          applyNavigation(next.threads);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (request === navigationGeneration.current) navigationGeneration.current += 1;
    };
  }, [applyNavigation, bootstrap, client, options.changeRevision]);

  useEffect(() => {
    activeThreadIdRef.current = options.activeThreadId;
    releaseLoadedPages.current = true;
    // A jump requested while the previous thread's pages were still held must
    // wait for this thread's newest read, not act on the old run.
    applyWindowState(undefined);
    threadGeneration.current += 1;
    streamAbort.current?.abort();
    streamAbort.current = undefined;
    if (options.activeThreadId === undefined) {
      return;
    }
    void activateThread(options.activeThreadId);
  }, [activateThread, applyWindowState, options.activeThreadId]);

  const navigation = useMemo((): ReadonlyArray<ChatThreadNavigationItem> => {
    if (bootstrap === undefined) return [];
    const items = [];
    for (const thread of bootstrap.threads) {
      if (thread.lifecycle === "active") {
        items.push({
          ...(executingByThread.get(String(thread.id)) === true ? { executing: true } : {}),
          ...liveTurnByThread.get(String(thread.id)),
          ...(followUpByThread.get(String(thread.id)) === undefined
            ? {}
            : { followUpOpen: followUpByThread.get(String(thread.id))! }),
          ...(sequenceByThread.get(String(thread.id)) === undefined
            ? {}
            : { lastSequence: sequenceByThread.get(String(thread.id))! }),
          ...(thread.branchedFrom === undefined
            ? {}
            : { lineageParentThreadId: String(thread.branchedFrom.threadId) }),
          ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
          providerInstanceId: String(thread.providerInstanceId),
          readSequence: readCursors.get(String(thread.id)) ?? 0,
          threadId: String(thread.id),
          title: thread.title,
          updatedAt: updatedAtByThread.get(String(thread.id)) ?? thread.updatedAt,
          ...(thread.completedAt === undefined ? {} : { completedAt: thread.completedAt }),
          ...(thread.snooze === undefined ? {} : { snooze: thread.snooze }),
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
    executingByThread,
    followUpByThread,
    liveTurnByThread,
    markedUnreadThreads,
    readCursors,
    sequenceByThread,
    updatedAtByThread,
  ]);

  async function execute(command: ChatCommand): Promise<ChatCommandResult | undefined> {
    const commandThreadId = "threadId" in command ? String(command.threadId) : undefined;
    setErrorMessage(undefined);
    lastExecuteError.current = undefined;
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
        const currentView = activeViewRef.current;
        if (
          command.kind === "change-chat-provider" &&
          result.kind === "thread-updated" &&
          currentView !== undefined &&
          String(currentView.thread.id) === String(result.thread.id)
        ) {
          // The picker waits on this command. Publish its confirmed pairing
          // before returning; the background snapshot can arrive later.
          applyAuthoritativeView({ ...currentView, thread: result.thread }, false);
        }
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
      lastExecuteError.current = failureMessage(error, CHAT_UNAVAILABLE);
      if (
        commandThreadId !== undefined &&
        String(activeThreadIdRef.current ?? "") !== commandThreadId
      ) {
        // A command for another thread must not disturb the open one, so
        // nothing here is shown or reloaded. The reason is still recorded
        // above, for a caller that has somewhere of its own to report it.
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
      setErrorMessage(failureMessage(error, CHAT_UNAVAILABLE));
      if (command.kind === "update-chat-settings")
        setSettingsMessage(failureMessage(error, CHAT_UNAVAILABLE));
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
    /**
     * Whether this send consumes the composer's draft. A turn the composer did
     * not write, such as asking the agent to fill a new Canvas, keeps it: the
     * person's unsent text is neither cleared on success nor replaced by the
     * turn's own text on a refusal.
     */
    sendOptions: { readonly composerDraft: "consume" | "keep" } = { composerDraft: "consume" },
  ): Promise<boolean> {
    if (
      activeView === undefined ||
      String(activeView.thread.id) !== String(options.activeThreadId ?? "")
    ) {
      return false;
    }
    const sendingThreadId = String(activeView.thread.id);
    // The reply arrives after the newest turn, so a reader looking at an
    // earlier run is brought back to the newest turns first.
    jumpToLatest();
    const submissionKey = submissionIntentKey(
      sendingThreadId,
      prompt,
      attachmentIds,
      previewSelections,
      canvasSelections,
      extensionSelections,
      threadMentionIds,
    );
    const submissionId =
      pendingSubmissionIds.current.get(submissionKey) ??
      decodeChatSubmissionId(globalThis.crypto.randomUUID());
    pendingSubmissionIds.current.set(submissionKey, submissionId);
    const consumesDraft = sendOptions.composerDraft === "consume";
    const previousDraft = composerDraftRef.current.readFor(sendingThreadId);
    if (consumesDraft) composerDraftRef.current.clearFor(sendingThreadId);
    const revisionAfterClear = composerDraftRef.current.revisionFor(sendingThreadId);
    const result = await execute({
      kind: "send-chat-turn",
      threadId: activeView.thread.id,
      expectedVersion: expectedVersion ?? activeView.thread.version,
      prompt,
      submissionId,
      ...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
      ...(previewSelections.length === 0 ? {} : { previewSelections: [...previewSelections] }),
      ...(canvasSelections.length === 0 ? {} : { canvasSelections: [...canvasSelections] }),
      ...(extensionSelections.length === 0
        ? {}
        : { extensionSelections: [...extensionSelections] }),
      ...(threadMentionIds.length === 0 ? {} : { threadMentionIds: [...threadMentionIds] }),
    });
    if (
      consumesDraft &&
      result === undefined &&
      composerDraftRef.current.revisionFor(sendingThreadId) === revisionAfterClear
    ) {
      composerDraftRef.current.restoreFor(sendingThreadId, {
        text: prompt,
        caretIndex: previousDraft?.caretIndex ?? prompt.length,
        stagedDropped: previousDraft?.stagedDropped === true,
      });
    }
    if (result !== undefined) pendingSubmissionIds.current.delete(submissionKey);
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
        await refreshTail(
          currentThreadId,
          () =>
            mounted.current && String(activeThreadIdRef.current ?? "") === String(currentThreadId),
        );
      }
      return attachment;
    } catch (error) {
      if (!mounted.current) throw error;
      if (String(activeThreadIdRef.current ?? "") !== String(input.threadId)) throw error;
      setErrorMessage(failureMessage(error, CHAT_UNAVAILABLE));
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
        await refreshTail(
          currentThreadId,
          () =>
            mounted.current && String(activeThreadIdRef.current ?? "") === String(currentThreadId),
        );
      }
      return attachment;
    } catch (error) {
      if (!mounted.current) throw error;
      if (String(activeThreadIdRef.current ?? "") !== String(input.threadId)) throw error;
      setErrorMessage(failureMessage(error, CHAT_UNAVAILABLE));
      throw error;
    }
  }

  /**
   * The page before the oldest loaded turn, of the newest turns or of the
   * detached range. A page anchored on a turn an edit has since superseded
   * answers `stale`: the newest turns are read again and the earlier pages
   * and any detached range are let go.
   */
  const loadEarlier = useCallback(async () => {
    const threadId = activeThreadIdRef.current;
    const state = transcriptWindowRef.current;
    const tail = activeViewRef.current;
    if (threadId === undefined || state === undefined || !state.windowed) return;
    const threadKey = String(threadId);
    if (state.threadKey !== threadKey || tail === undefined) return;
    const detached = state.detached;
    const run = detached?.view ?? tail;
    const oldest = run.turns[0];
    const hasEarlier = detached?.hasEarlier ?? state.hasEarlier;
    const pending = detached?.earlier ?? state.earlier;
    if (oldest === undefined || !hasEarlier || pending === "loading") return;
    const isCurrent = () =>
      mounted.current &&
      String(activeThreadIdRef.current ?? "") === threadKey &&
      transcriptWindowRef.current?.threadKey === threadKey;
    const mark = (earlier: ChatTranscriptWindowState["earlier"]) => {
      const current = transcriptWindowRef.current;
      if (current === undefined || current.threadKey !== threadKey) return;
      if (detached === undefined) applyWindowState({ ...current, earlier });
      else if (current.detached !== undefined) {
        applyWindowState({ ...current, detached: { ...current.detached, earlier } });
      }
    };
    mark("loading");
    try {
      const page = await client.threadWindow(threadId, {
        limit: CHAT_WINDOW_PAGE_TURNS,
        before: oldest.id,
      });
      if (!isCurrent()) return;
      const current = transcriptWindowRef.current;
      const currentTail = activeViewRef.current;
      if (current === undefined || currentTail === undefined) return;
      if (detached === undefined) {
        // A newest read that could not prove it touched this run replaced
        // it while the page loaded; the page belongs to a run that is gone.
        if (String(currentTail.turns[0]?.id ?? "") !== String(oldest.id)) {
          applyWindowState({ ...current, earlier: "idle" });
          return;
        }
        applyTail(
          prependChatPage(currentTail, page.view),
          {
            ...current,
            hasEarlier: page.hasEarlier,
            supersededTurnCount: page.supersededTurnCount,
            earlier: "idle",
          },
          false,
        );
        return;
      }
      if (
        current.detached === undefined ||
        String(current.detached.view.turns[0]?.id ?? "") !== String(oldest.id)
      ) {
        return;
      }
      applyTail(
        currentTail,
        {
          ...current,
          supersededTurnCount: page.supersededTurnCount,
          detached: {
            ...current.detached,
            view: prependChatPage(current.detached.view, page.view),
            hasEarlier: page.hasEarlier,
            earlier: "idle",
          },
        },
        false,
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (failureCategory(error) === "stale") {
        releaseLoadedPages.current = true;
        try {
          await refreshTail(threadId, isCurrent);
          return;
        } catch {
          if (!isCurrent()) return;
        }
      }
      mark("failed");
    }
  }, [applyTail, applyWindowState, client, refreshTail]);

  /** The page after the newest turn of the detached range; it joins the newest turns once they meet. */
  const loadLater = useCallback(async () => {
    const threadId = activeThreadIdRef.current;
    const state = transcriptWindowRef.current;
    const detached = state?.detached;
    if (threadId === undefined || state === undefined || detached === undefined) return;
    const threadKey = String(threadId);
    const newest = detached.view.turns.at(-1);
    if (state.threadKey !== threadKey || newest === undefined || detached.later === "loading") {
      return;
    }
    const isCurrent = () =>
      mounted.current &&
      String(activeThreadIdRef.current ?? "") === threadKey &&
      String(transcriptWindowRef.current?.detached?.view.turns.at(-1)?.id ?? "") ===
        String(newest.id);
    applyWindowState({ ...state, detached: { ...detached, later: "loading" } });
    try {
      const page = await client.threadWindow(threadId, {
        limit: CHAT_WINDOW_PAGE_TURNS,
        after: newest.id,
      });
      if (!isCurrent()) return;
      const current = transcriptWindowRef.current;
      const tail = activeViewRef.current;
      if (current?.detached === undefined || tail === undefined) return;
      applyTail(
        tail,
        {
          ...current,
          supersededTurnCount: page.supersededTurnCount,
          detached: {
            ...current.detached,
            view: appendChatPage(current.detached.view, page.view),
            hasLater: page.hasLater,
            later: "idle",
          },
        },
        false,
      );
    } catch (error) {
      if (!isCurrent()) return;
      const current = transcriptWindowRef.current;
      if (current?.detached === undefined) return;
      if (failureCategory(error) === "stale") {
        // The run this page continued is no longer the conversation.
        const { detached: _gone, ...rest } = current;
        applyWindowState(rest);
        return;
      }
      applyWindowState({ ...current, detached: { ...current.detached, later: "failed" } });
    }
  }, [applyTail, applyWindowState, client]);

  /** Leave the detached range and show the newest turns again. */
  const jumpToLatest = useCallback(() => {
    const current = transcriptWindowRef.current;
    if (current?.detached === undefined) return;
    const { detached: _left, ...rest } = current;
    applyWindowState(rest);
  }, [applyWindowState]);

  /**
   * Bring a turn on screen for a jump such as a search hit. A turn already
   * loaded needs nothing read; otherwise the page that ends with it becomes
   * the detached range, or joins the newest turns when it touches them. A
   * turn the conversation no longer holds (an edit superseded it) is left
   * alone, as it was before transcripts loaded in pages.
   */
  const revealTurn = useCallback(
    async (turnId: ChatTurnId) => {
      const threadId = activeThreadIdRef.current;
      const state = transcriptWindowRef.current;
      const tail = activeViewRef.current;
      if (threadId === undefined || state === undefined || tail === undefined) return;
      const threadKey = String(threadId);
      if (state.threadKey !== threadKey || String(tail.thread.id) !== threadKey) return;
      const key = String(turnId);
      if (holdsTurn(tail, key)) {
        jumpToLatest();
        return;
      }
      if (!state.windowed || holdsTurn(state.detached?.view, key)) return;
      try {
        const page = await client.threadWindow(threadId, {
          limit: CHAT_WINDOW_PAGE_TURNS,
          through: turnId,
        });
        if (!mounted.current || String(activeThreadIdRef.current ?? "") !== threadKey) return;
        const current = transcriptWindowRef.current;
        const currentTail = activeViewRef.current;
        if (current === undefined || currentTail === undefined) return;
        applyTail(
          currentTail,
          {
            ...current,
            supersededTurnCount: page.supersededTurnCount,
            detached: {
              view: page.view,
              hasEarlier: page.hasEarlier,
              hasLater: page.hasLater,
              earlier: "idle",
              later: "idle",
            },
          },
          false,
        );
      } catch {
        // A superseded or unreachable target stays where the reader is.
      }
    },
    [applyTail, client, jumpToLatest],
  );

  /**
   * The whole thread as the host holds it, for readers that must not stop at
   * the loaded pages: the Markdown export, and the thread's totals.
   */
  const readWholeThread = useCallback(
    (threadId: ChatThreadId) => client.thread(threadId),
    [client],
  );

  const visibleActiveView =
    activeView !== undefined &&
    String(activeView.thread.id) === String(options.activeThreadId ?? "")
      ? activeView
      : undefined;

  /**
   * Complete, reopen, snooze, and wake carry the thread's current version,
   * read from the host first: the navigation read keeps a row's rest current
   * but not its version, so a change made in another window would otherwise
   * make the next command stale. Whether completing or snoozing would hide
   * work in flight is the host's call, so the answer is a value the caller
   * must handle: these run from a sidebar row, where nothing else reports a
   * failure. The controller's own error line is read only while Chat is
   * disconnected, and a command for a thread that is not open sets no line at
   * all, so a refusal that is not returned here reaches the person as a click
   * that did nothing.
   */
  const restCommand = useCallback(
    async (
      threadId: ChatThreadId,
      command: (expectedVersion: ChatThread["version"]) => ChatCommand,
    ): Promise<ChatThreadRestOutcome> => {
      const listed = bootstrap?.threads.find(
        (candidate) => String(candidate.id) === String(threadId),
      );
      if (listed === undefined) {
        return { status: "refused", message: "This thread is no longer in the list." };
      }
      const current = await client.thread(threadId).catch(() => undefined);
      const result = await execute(command(current?.thread.version ?? listed.version));
      if (result !== undefined) return { status: "ok" };
      return {
        status: "refused",
        message: lastExecuteError.current ?? "The host could not change this thread.",
      };
    },
    [bootstrap, client, execute],
  );
  const completeThread = useCallback(
    (threadId: ChatThreadId) =>
      restCommand(threadId, (expectedVersion) => ({
        kind: "complete-chat-thread",
        threadId,
        expectedVersion,
      })),
    [restCommand],
  );
  const reopenThread = useCallback(
    (threadId: ChatThreadId) =>
      restCommand(threadId, (expectedVersion) => ({
        kind: "reopen-chat-thread",
        threadId,
        expectedVersion,
      })),
    [restCommand],
  );
  const snoozeThread = useCallback(
    (threadId: ChatThreadId, until: string) =>
      restCommand(threadId, (expectedVersion) => ({
        kind: "snooze-chat-thread",
        threadId,
        expectedVersion,
        until: decodeUtcTimestamp(until),
      })),
    [restCommand],
  );
  const wakeThread = useCallback(
    (threadId: ChatThreadId) =>
      restCommand(threadId, (expectedVersion) => ({
        kind: "wake-chat-thread",
        threadId,
        expectedVersion,
      })),
    [restCommand],
  );
  /**
   * One more turn on a finished thread that is not open, from the Review page.
   * It is the ordinary send command with the thread's current version, and a
   * refusal comes back as a value for the same reason the rest commands'
   * do: nothing else reports it.
   */
  const sendBackTurn = useCallback(
    (threadId: ChatThreadId, prompt: string) =>
      restCommand(threadId, (expectedVersion) => ({
        kind: "send-chat-turn",
        threadId,
        expectedVersion,
        prompt,
      })),
    [restCommand],
  );

  const visibleTranscriptWindow =
    visibleActiveView !== undefined &&
    transcriptWindow?.threadKey === String(visibleActiveView.thread.id)
      ? transcriptWindow
      : undefined;

  return {
    activeView: visibleActiveView,
    /** What else of the open thread is loaded or offered beside `activeView`'s newest turns. */
    transcriptWindow: visibleTranscriptWindow,
    loadEarlier,
    loadLater,
    jumpToLatest,
    revealTurn,
    readWholeThread,
    bootstrap,
    completeThread,
    reopenThread,
    snoozeThread,
    wakeThread,
    errorMessage,
    // Failures on a thread that is not open never reach errorMessage; a
    // caller acting on a thread it just created reads the reason here.
    lastExecuteError,
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
    sendBackTurn,
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

export type ChatController = ReturnType<typeof useChatController>;

export function acceptChatEventFrame(
  frame: ChatEventFrame,
  expectedThreadId: ChatThreadId,
  afterSequence: number,
): boolean {
  if (String(frame.threadId) !== String(expectedThreadId)) return false;
  return Number.isFinite(frame.sequence) && frame.sequence > afterSequence;
}

function openChatEventStream(
  client: ChatClient,
  threadId: ChatThreadId,
  afterSequence: number,
  signal: AbortSignal,
): AsyncIterator<ChatEventFrame> {
  return client.subscribe(threadId, afterSequence, signal)[Symbol.asyncIterator]();
}
