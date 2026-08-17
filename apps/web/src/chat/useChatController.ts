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
import { buildChatThreadNavigation, type ChatThreadNavigationItem } from "../shell/navigationModel";

export type ChatControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";

export interface ChatControllerOptions {
  readonly activeThreadId?: ChatThreadId;
  readonly client?: ChatClient;
  readonly navigationRefreshMs?: number;
  readonly reconnectDelayMs?: number;
  readonly readCursorStore?: ChatReadCursorStore;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export interface ChatReadCursorStore {
  readonly getSnapshot: () => ReadonlyMap<string, number>;
  readonly mark: (threadId: ChatThreadId, sequence: number) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createChatReadCursorStore(): ChatReadCursorStore {
  let snapshot: ReadonlyMap<string, number> = new Map();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    mark: (threadId, sequence) => {
      const key = String(threadId);
      if (sequence <= (snapshot.get(key) ?? 0)) return;
      const next = new Map(snapshot);
      next.set(key, sequence);
      snapshot = next;
      for (const listener of listeners) listener();
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
  const [activeView, setActiveView] = useState<ChatThreadView | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [settingsMessage, setSettingsMessage] = useState<string | undefined>(undefined);
  const [pendingDraft, setPendingDraft] = useState("");
  const readCursors = useSyncExternalStore(
    readCursorStore.subscribe,
    readCursorStore.getSnapshot,
    readCursorStore.getSnapshot,
  );
  const [followUpByThread, setFollowUpByThread] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [sequenceByThread, setSequenceByThread] = useState<ReadonlyMap<string, number>>(new Map());
  const [updatedAtByThread, setUpdatedAtByThread] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const mounted = useRef(true);
  const activeThreadIdRef = useRef(options.activeThreadId);
  const bootstrapGeneration = useRef(0);
  const draftRevision = useRef(0);
  const threadGeneration = useRef(0);
  const streamAbort = useRef<AbortController | undefined>(undefined);
  const bootstrapped = useRef(false);

  const updatePendingDraft = useCallback((value: string) => {
    draftRevision.current += 1;
    setPendingDraft(value);
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

  const markThreadRead = useCallback(
    (threadId: ChatThreadId, sequence: number) => {
      readCursorStore.mark(threadId, sequence);
    },
    [readCursorStore],
  );

  const applyAuthoritativeView = useCallback(
    (view: ChatThreadView, markRead: boolean) => {
      recordSequence(view.thread.id, view.lastSequence);
      recordFollowUp(view.thread.id, view.followUp?.state === "open");
      recordUpdatedAt(view.thread.id, view.thread.updatedAt);
      setActiveView(view);
      if (markRead) markThreadRead(view.thread.id, view.lastSequence);
    },
    [markThreadRead, recordFollowUp, recordSequence, recordUpdatedAt],
  );

  const loadBootstrap = useCallback(async () => {
    const request = ++bootstrapGeneration.current;
    if (!bootstrapped.current) setStatus("loading");
    setErrorMessage(undefined);
    try {
      const next = await client.bootstrap();
      if (!mounted.current || request !== bootstrapGeneration.current) return false;
      bootstrapped.current = true;
      setBootstrap(next);
      setStatus("ready");
      return true;
    } catch (error) {
      if (!mounted.current || request !== bootstrapGeneration.current) return false;
      setStatus("disconnected");
      setErrorMessage(failureMessage(error));
      return false;
    }
  }, [client]);

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
              const recovered = await client.thread(threadId);
              if (!mounted.current || request !== threadGeneration.current) return;
              applyAuthoritativeView(recovered, true);
              cursor = recovered.lastSequence;
              await waitForReconnect(signal, reconnectDelayMs);
              continue;
            }
            await waitForReconnect(signal, reconnectDelayMs);
          } catch {
            if (!mounted.current || request !== threadGeneration.current || signal.aborted) {
              return;
            }
            const recovered = await client.thread(threadId);
            if (!mounted.current || request !== threadGeneration.current) return;
            applyAuthoritativeView(recovered, true);
            cursor = recovered.lastSequence;
            await waitForReconnect(signal, reconnectDelayMs);
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
    const refresh = async () => {
      if (inFlight) return;
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
    void refresh();
    const timer = setInterval(() => void refresh(), Math.max(10, navigationRefreshMs));
    return () => {
      cancelled = true;
      clearInterval(timer);
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
    return buildChatThreadNavigation(items);
  }, [bootstrap, followUpByThread, readCursors, sequenceByThread, updatedAtByThread]);

  async function execute(command: ChatCommand): Promise<ChatCommandResult | undefined> {
    const commandThreadId = "threadId" in command ? String(command.threadId) : undefined;
    setErrorMessage(undefined);
    if (command.kind === "update-chat-settings") setSettingsMessage(undefined);
    try {
      const result = await client.execute(command);
      if (!mounted.current) return undefined;
      if (result.kind === "follow-up-updated") {
        recordFollowUp(result.followUp.threadId, result.followUp.state === "open");
      }
      if (result.kind === "settings-updated") {
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
    updatePendingDraft("");
    const revision = draftRevision.current;
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
    if (result === undefined && draftRevision.current === revision) updatePendingDraft(prompt);
    return result !== undefined;
  }

  async function updateSettings(
    command: Extract<ChatCommand, { kind: "update-chat-settings" }>,
  ): Promise<boolean> {
    return (await execute(command))?.kind === "settings-updated";
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
    navigation,
    pendingDraft,
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
