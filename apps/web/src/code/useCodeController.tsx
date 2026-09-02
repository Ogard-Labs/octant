import {
  CodeClientSnapshotRequiredError,
  createCodeClient,
  type CodeClient,
} from "@octant/client-runtime/code-client";
import type {
  CodeBootstrap,
  CodeNavigation,
  CodeCommand,
  CodeCommandResult,
  CodeEventFrame,
  CodeFailure,
  CodeCheckoutId,
  CodeExternalEditor,
  CodeThread,
  CodeThreadId,
  CodeThreadView,
} from "@octant/contracts/code";
import { decodeCodeThread } from "@octant/contracts/code";
import {
  decodeCodeOperationId,
  decodeProviderSessionId,
  type CodeApprovalId,
  type CodeCheckpoint,
  type CodeConversationTurn,
  MAX_CODE_EVIDENCE_BATCH_ITEMS,
  type CodeProviderLimit,
  type CodeEvidenceContentId,
  type CodeOperationEvent,
  type CodeOperationId,
  type CodeThreadCheckoutRebindOutcome,
  type CodeThreadFollowUpView,
  type CodeAttachmentId,
  type CodeAttachmentReference,
  type MentionableThreadId,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import type { ComposerThreadDraftStore } from "../composer/composerThreadDraftStore";
import {
  EMPTY_TURN_ACTIVITY,
  appendReasoning,
  applyActivityEvent,
  type CodeTurnActivity,
} from "./transcriptActivity";
import { samePollingData } from "../polling/samePollingData";
import {
  documentIsVisible,
  scheduleVisibleInterval,
  waitUntilDocumentVisible,
} from "../polling/documentVisibility";
import { markInteraction } from "../polling/interactionTrace";
import { createReadCursorStore, type ReadCursorStore } from "../threads/readCursorStore";

export type CodeControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";
export type CodeTurnStatus = "idle" | "sending" | "running" | "waiting" | "failed";

/**
 * A question the running provider turn asked the user and is blocked on:
 * either a yes/no approval for a tool it wants to run, or free-form input.
 * The host mints these from the provider stream; the renderer only relays
 * the user's answer back through `answer-provider-*` operations.
 */
export type CodeProviderRequest =
  | {
      readonly kind: "approval";
      readonly approvalId: CodeApprovalId;
      readonly summary: string;
    }
  | {
      readonly kind: "input";
      readonly requestId: string;
      readonly prompt: string;
      readonly options: ReadonlyArray<string>;
    };

export type CodeProviderAnswer =
  | {
      readonly kind: "approval";
      readonly approvalId: CodeApprovalId;
      readonly decision: "approved" | "denied";
    }
  | { readonly kind: "input"; readonly requestId: string; readonly response: string };

function providerRequestFromEvent(event: CodeOperationEvent): CodeProviderRequest | undefined {
  if (event.kind === "approval-requested") {
    return { kind: "approval", approvalId: event.approvalId, summary: event.summary };
  }
  if (event.kind === "input-requested") {
    return {
      kind: "input",
      requestId: event.requestId,
      prompt: event.prompt,
      options: event.options,
    };
  }
  return undefined;
}

export interface CodeConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly operationId?: CodeOperationId;
  readonly providerInstanceId?: CodeThread["providerInstanceId"];
  readonly modelId?: CodeThread["modelId"];
  readonly status?: "waiting" | "completed" | "interrupted" | "failed" | "incomplete";
  /** Images this message carried, as the turn's start event recorded them. */
  readonly attachments?: ReadonlyArray<CodeAttachmentReference>;
  /**
   * The checkout as it stood before this turn ran. Present on a user message
   * whose turn the host managed to checkpoint, and what the transcript's
   * restore control acts on.
   */
  readonly checkpoint?: CodeCheckpoint;
  /**
   * The posture this turn ran under, as the host recorded it. Absent on a
   * message whose turn was journaled before the host started recording it.
   */
  readonly executionPolicy?: ProviderExecutionPolicy;
}

export interface CodeThreadNavigationItem {
  readonly checkoutChip?: {
    readonly checkoutKind: "managed-worktree";
    readonly label: string;
  };
  readonly executing?: boolean;
  readonly executionPolicy: CodeThread["executionPolicy"];
  readonly lifecycle: CodeThread["lifecycle"];
  readonly projectId: CodeThread["projectId"];
  readonly providerInstanceId: CodeThread["providerInstanceId"];
  readonly threadId: CodeThreadId;
  readonly title: string;
  readonly updatedAt?: CodeThread["updatedAt"];
  /**
   * Whether a durable follow-up obligation is currently open on this thread.
   * Deliberately independent of unread and runtime status; only an explicit
   * completion clears it.
   */
  readonly followUp?: boolean;
  /**
   * Whether the thread's journaled activity advanced since the user last had it
   * open — including a provider turn that ran entirely in the background.
   * Kept across restarts like Chat's: quitting the app is not the same as
   * having read a thread, and dropping the cursor on launch made every thread
   * with journaled activity read as unread again.
   */
  readonly unread?: boolean;
  /** Whether the user pinned this thread to the top of the list. */
  readonly pinned?: boolean;
  /**
   * The visible thread this one was forked from. Absent when the thread
   * started on its own.
   */
  readonly lineageParentThreadId?: string;
}

function refreshActiveThreadView(
  current: CodeThreadView | undefined,
  next: CodeBootstrap,
): CodeThreadView | undefined {
  if (current === undefined) return current;
  const checkout = next.checkouts.find(
    (candidate) => String(candidate.id) === String(current.checkout.id),
  );
  const refreshedThread = next.threads.find(
    (candidate) => String(candidate.id) === String(current.thread.id),
  );
  if (checkout === undefined && refreshedThread === undefined) return current;
  if (
    (checkout === undefined || samePollingData(checkout, current.checkout)) &&
    (refreshedThread === undefined || samePollingData(refreshedThread, current.thread))
  ) {
    return current;
  }
  return {
    ...current,
    ...(checkout === undefined ? {} : { checkout }),
    ...(refreshedThread === undefined ? {} : { thread: refreshedThread }),
  };
}

/** Code keeps its own record, so Chat's cursors never read as Code's. */
const CODE_READ_CURSOR_STORAGE_KEY = "octant.code.readCursors.v1";

/**
 * Code's read cursors.
 *
 * The sequence is the host's, from the bootstrap: a thread's own version cannot
 * stand in for it, because a provider turn is journaled on a different
 * aggregate and moves neither the version nor `updatedAt`.
 *
 * The store itself is shared with Chat — unread is the same idea in both modes
 * — and survives a relaunch, so a thread the user read yesterday does not come
 * back unread today.
 */
export type CodeReadCursorStore = ReadCursorStore<CodeThreadId>;

export function createCodeReadCursorStore(
  storage?: Pick<Storage, "getItem" | "setItem"> | undefined,
): CodeReadCursorStore {
  return createReadCursorStore<CodeThreadId>({
    storageKey: CODE_READ_CURSOR_STORAGE_KEY,
    ...(storage === undefined ? {} : { storage }),
  });
}

/**
 * The longest a dropped stream waits before trying the host again. Long enough
 * that a machine asleep for hours is not asking every quarter second, short
 * enough that waking it up catches the thread back up while the user is still
 * looking at it.
 */
const MAX_CODE_RECONNECT_DELAY_MS = 10_000;

/**
 * The one turn error the controller owns rather than relays. Activation sets
 * it when replay fails and clears exactly it when a later activation succeeds,
 * so a retried thread does not keep wearing a stale history banner.
 */
const HISTORY_UNAVAILABLE_MESSAGE = "Conversation history could not be loaded.";

/** The first wait after a failed catch-up, before the delay starts doubling. */
const MIN_CODE_RECONNECT_BACKOFF_MS = 100;

/**
 * What a Code thread has consumed, and the provider usage windows it last
 * heard about. Every figure comes from the provider: a provider that reports
 * no cost leaves `costUsd` absent rather than showing a derived number.
 */
export interface CodeThreadUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
  readonly limits: ReadonlyArray<CodeProviderLimit>;
}

const EMPTY_THREAD_USAGE: CodeThreadUsage = { inputTokens: 0, outputTokens: 0, limits: [] };

interface CodeTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number | undefined;
}

/**
 * Add up what each turn reported.
 *
 * The thread's figure is the sum over turns, never the sum over reports: a
 * provider may report a turn's usage repeatedly as it runs, and each report is
 * that turn's total so far, not an amount to add to the one before it. Keeping
 * a figure per turn is what makes the live number agree with the one the
 * journal projects when the thread is reopened.
 */
function totalTurnUsage(byOperation: ReadonlyMap<string, CodeTurnUsage>): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  for (const usage of byOperation.values()) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    if (usage.costUsd !== undefined) costUsd = (costUsd ?? 0) + usage.costUsd;
  }
  return { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) };
}

export interface CodeControllerOptions {
  readonly activeThreadId?: CodeThreadId;
  readonly client?: CodeClient;
  readonly draftStore?: ComposerThreadDraftStore;
  readonly readCursorStore?: CodeReadCursorStore;
  /**
   * How often the sidebar re-reads the thread list. Only the thread in view
   * streams its own events, so without this a thread finishing in the
   * background would show no unread mark until something else reloaded.
   */
  readonly navigationRefreshMs?: number;
  readonly changeRevision?: number;
  readonly reconnectDelayMs?: number;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export function useCodeController(options: CodeControllerOptions) {
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  const navigationRefreshMs = options.navigationRefreshMs ?? 2_000;
  const readCursorStore = useMemo(
    () => options.readCursorStore ?? createCodeReadCursorStore(),
    [options.readCursorStore],
  );
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
  const client = useMemo(
    () =>
      options.client ??
      createCodeClient({
        baseUrl: required(options.serverUrl),
        fetch: globalThis.fetch,
        windowCapability: required(options.windowCapability),
      }),
    [options.client, options.serverUrl, options.windowCapability],
  );
  const [status, setStatus] = useState<CodeControllerStatus>("loading");
  const [bootstrap, setBootstrap] = useState<CodeBootstrap>();
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;
  const [activeView, setActiveView] = useState<CodeThreadView>();
  const [errorCategory, setErrorCategory] = useState<CodeFailure["category"]>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const composerDraft = useComposerThreadDraft({
    mode: "code",
    threadId: options.activeThreadId === undefined ? undefined : String(options.activeThreadId),
    ...(options.draftStore === undefined ? {} : { store: options.draftStore }),
  });
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
  const [conversation, setConversation] = useState<ReadonlyArray<CodeConversationMessage>>([]);
  /*
   * Whether an empty transcript is still loading, authoritatively empty, or
   * unavailable. Only the loaded state is an invitation to start something.
   */
  const [conversationHistory, setConversationHistory] = useState<
    "loading" | "loaded" | "unavailable"
  >("loading");
  const [followUps, setFollowUps] = useState<ReadonlyMap<string, CodeThreadFollowUpView>>(
    () => new Map(),
  );
  const [turnStatus, setTurnStatus] = useState<CodeTurnStatus>("idle");
  const [turnError, setTurnError] = useState<string>();
  const [providerRequests, setProviderRequests] = useState<ReadonlyArray<CodeProviderRequest>>([]);

  const noteProviderRequest = useCallback((event: CodeOperationEvent) => {
    const request = providerRequestFromEvent(event);
    if (request !== undefined) setProviderRequests((current) => [...current, request]);
  }, []);
  const [turnActivity, setTurnActivity] = useState<ReadonlyMap<string, CodeTurnActivity>>(
    () => new Map(),
  );
  // What this thread has consumed and how much of the provider's usage windows
  // is left. Both are the provider's own figures; nothing here is derived from
  // a price list or a limit Octant assumed.
  const [threadUsage, setThreadUsage] = useState<CodeThreadUsage>(EMPTY_THREAD_USAGE);
  // The way back from this thread's last restore, as the host recorded it. It
  // lives here rather than in the surface that ran the restore because that
  // surface is unmounted the moment the user opens another tab, and the only
  // copy of the state the restore overwrote would go with it.
  const [restoreUndo, setRestoreUndo] = useState<CodeCheckpoint>();
  /**
   * Carry what a restore just replaced, so the offer appears without waiting
   * for the thread to be reopened. The host has already recorded it; this only
   * keeps the renderer level with the journal it will read back next time.
   */
  const noteRestoreUndo = useCallback((checkpoint: CodeCheckpoint | undefined) => {
    setRestoreUndo(checkpoint);
  }, []);
  const usageByOperation = useRef(new Map<string, CodeTurnUsage>());
  const noteUsage = useCallback((operationId: CodeOperationId, event: CodeOperationEvent) => {
    if (event.kind === "usage") {
      const { inputTokens, outputTokens, costUsd } = event;
      usageByOperation.current.set(String(operationId), {
        inputTokens,
        outputTokens,
        ...(costUsd === undefined ? {} : { costUsd }),
      });
      setThreadUsage((current) => ({
        ...totalTurnUsage(usageByOperation.current),
        limits: current.limits,
      }));
      return;
    }
    if (event.kind !== "provider-limit") return;
    const limit = {
      window: event.window,
      status: event.status,
      ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
      ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
    };
    setThreadUsage((current) => ({
      ...current,
      limits: [...current.limits.filter((entry) => entry.window !== limit.window), limit],
    }));
  }, []);
  const noteActivity = useCallback((operationId: CodeOperationId, event: CodeOperationEvent) => {
    setTurnActivity((current) => {
      const key = String(operationId);
      const existing = current.get(key) ?? EMPTY_TURN_ACTIVITY;
      const next = applyActivityEvent(existing, event);
      if (next === existing) return current;
      const updated = new Map(current);
      updated.set(key, next);
      return updated;
    });
  }, []);
  const noteReasoning = useCallback((operationId: CodeOperationId, chunk: string) => {
    setTurnActivity((current) => {
      const key = String(operationId);
      const existing = current.get(key) ?? EMPTY_TURN_ACTIVITY;
      const next = appendReasoning(existing, chunk);
      if (next === existing) return current;
      const updated = new Map(current);
      updated.set(key, next);
      return updated;
    });
  }, []);
  const editorDraftValues = useRef(new Map<string, string>());
  const firstTurnFailures = useRef(
    new Map<string, Readonly<{ prompt: string; message: string }>>(),
  );
  const activeTurnOperations = useRef(
    new Map<
      string,
      { readonly operationId: CodeOperationId; readonly status: "running" | "waiting" }
    >(),
  );
  const turnAbort = useRef<AbortController | undefined>(undefined);
  const editorDrafts = useMemo(
    () => ({
      clear: (key: string) => editorDraftValues.current.delete(key),
      read: (key: string) => editorDraftValues.current.get(key),
      write: (key: string, value: string) => editorDraftValues.current.set(key, value),
    }),
    [],
  );
  const mounted = useRef(true);
  const bootstrapGeneration = useRef(0);
  /**
   * Apply a navigation read only when nothing newer has already landed.
   *
   * Several paths read the bootstrap concurrently — the timed refresh, the
   * seen-activity read, and a full load — and the host does not answer them in
   * the order they were asked. A read that observed a checkout still `waiting`
   * could therefore complete after one that had already recovered it as
   * `available` and put the stale state back, which left the thread's terminal
   * attached to a checkout the UI believed was still coming up.
   */
  const navigationReadSequence = useRef(0);
  const appliedNavigationRead = useRef(0);

  const nextNavigationRead = useCallback(() => ++navigationReadSequence.current, []);

  /* Cancels a bootstrap that is still waiting to ask again when the hook goes. */
  const bootstrapAbort = useRef(new AbortController());
  const threadGeneration = useRef(0);
  const streamAbort = useRef<AbortController | undefined>(undefined);
  const activeThreadId = useRef(options.activeThreadId);
  const lastExecuteError = useRef<
    { category: CodeFailure["category"]; message: string } | undefined
  >(undefined);

  // Drafts are kept per thread so moving between threads never loses what was
  // typed and never carries one thread's prompt into another's composer. A
  // draft is renderer-local by design: it is not a message until the user
  // sends it, so the journal records nothing here.
  const pendingDraft = composerDraft.text;
  const setPendingDraft = useCallback((value: string, caretIndex?: number) => {
    if (caretIndex === undefined) composerDraftRef.current.setDraft(value);
    else composerDraftRef.current.setDraft(value, caretIndex);
  }, []);
  const setPendingDraftCaret = useCallback((caretIndex: number) => {
    composerDraftRef.current.setCaret(caretIndex);
  }, []);
  const writePendingDraftFor = useCallback((threadId: string, value: string) => {
    composerDraftRef.current.writeFor(threadId, value);
  }, []);

  const clearFailure = useCallback(() => {
    setErrorCategory(undefined);
    setErrorMessage(undefined);
  }, []);

  const fail = useCallback((error: unknown) => {
    const failure = codeFailure(error);
    setErrorCategory(failure.category);
    setErrorMessage(failure.message);
    if (failure.category === "disconnected" || failure.category === "unavailable") {
      setStatus("disconnected");
    } else {
      setStatus("ready");
    }
  }, []);

  const refreshFollowUp = useCallback(
    async (threadId: CodeThreadId): Promise<CodeThreadFollowUpView | undefined> => {
      try {
        const view = await client.readFollowUp(threadId);
        if (!mounted.current) return undefined;
        setFollowUps((current) => {
          const next = new Map(current);
          next.set(String(threadId), view);
          return next;
        });
        return view;
      } catch {
        // Follow-up is a supplementary durable signal; a transient read failure
        // must never block thread activation or invalidate other state.
        return undefined;
      }
    },
    [client],
  );

  const loadBootstrap = useCallback(
    async (reason: "bootstrap" | "retry" | "conflict" = "retry") => {
      const request = ++bootstrapGeneration.current;
      setStatus(reason === "conflict" ? "conflict-reload" : "loading");
      clearFailure();
      let backoffMs = MIN_CODE_RECONNECT_BACKOFF_MS;
      for (;;) {
        try {
          const next = await client.bootstrap();
          if (!mounted.current || request !== bootstrapGeneration.current) return false;
          bootstrapRef.current = next;
          appliedNavigationRead.current = ++navigationReadSequence.current;
          setBootstrap(next);
          setActiveView((current) => refreshActiveThreadView(current, next));
          reconcileDrafts(next.threads.map((thread) => String(thread.id)));
          clearFailure();
          setStatus("ready");
          return true;
        } catch (error) {
          if (!mounted.current || request !== bootstrapGeneration.current) return false;
          fail(error);
          /*
           * A host the renderer cannot reach yet is a host to wait for: this
           * window routinely asks for the bootstrap while the local service is
           * still coming up, and one refusal there used to leave Code
           * disconnected for the rest of the session on a machine that was
           * healthy a second later — with no transcript and no new thread
           * behind that state. The thread stream already waits this way. Any
           * other category is an answer the host meant, and asking again would
           * only collect it twice.
           */
          if (!worthAskingAgain(error)) return false;
          await waitForReconnect(bootstrapAbort.current.signal, backoffMs);
          if (!mounted.current || request !== bootstrapGeneration.current) return false;
          if (bootstrapAbort.current.signal.aborted) return false;
          backoffMs = Math.min(backoffMs * 2, MAX_CODE_RECONNECT_DELAY_MS);
        }
      }
    },
    [clearFailure, client, fail, reconcileDrafts],
  );

  // How far each thread's journaled activity had reached the last time the host
  // said so, readable from the stream callbacks that decide a thread has been
  // seen. Those run outside render, so the derived map below is mirrored here.
  const observedActivity = useRef<ReadonlyMap<string, number>>(new Map());

  /**
   * Record what the host has already reported for a thread as seen.
   *
   * Only call this once the thread's own evidence has reached the transcript.
   * The sequence is the host's, and a read cursor is monotonic, so marking one
   * that never rendered spends the only chance the activity had to become an
   * unread mark.
   */
  const markRenderedActivity = useCallback(
    (threadId: CodeThreadId) => {
      readCursorStore.markDeferred(threadId, observedActivity.current.get(String(threadId)) ?? 0);
    },
    [readCursorStore],
  );

  const applyNavigationRefresh = useCallback(
    (next: CodeNavigation, read: number) => {
      if (read <= appliedNavigationRead.current) return;
      appliedNavigationRead.current = read;
      const currentBootstrap = bootstrapRef.current;
      if (currentBootstrap !== undefined) {
        if (
          !(
            samePollingData(currentBootstrap.threads, next.threads) &&
            samePollingData(currentBootstrap.activity, next.activity) &&
            samePollingData(currentBootstrap.runtime, next.runtime)
          )
        ) {
          bootstrapRef.current = {
            ...currentBootstrap,
            threads: next.threads,
            activity: next.activity,
            runtime: next.runtime,
          };
        }
      }
      setBootstrap((current) => {
        if (current === undefined) return current;
        if (
          samePollingData(current.threads, next.threads) &&
          samePollingData(current.activity, next.activity) &&
          samePollingData(current.runtime, next.runtime)
        ) {
          return current;
        }
        return {
          ...current,
          threads: next.threads,
          activity: next.activity,
          runtime: next.runtime,
        };
      });
      setActiveView((current) => {
        if (current === undefined) return current;
        const refreshedThread = next.threads.find(
          (candidate) => String(candidate.id) === String(current.thread.id),
        );
        if (refreshedThread === undefined || samePollingData(refreshedThread, current.thread)) {
          return current;
        }
        return { ...current, thread: refreshedThread };
      });
      reconcileDrafts(next.threads.map((thread) => String(thread.id)));
    },
    [reconcileDrafts],
  );

  /**
   * Read the host's own activity sequence for a thread and record it as seen.
   *
   * A turn that just rendered is journaled ahead of the timed navigation
   * refresh, so the last observed sequence still describes the thread as it was
   * before the turn ran. Recording that number would leave the turn the user
   * watched finish looking unread the moment the next refresh reports the
   * higher one — including after they have moved to another thread, where
   * nothing would mark it again. Reading the host here closes that window; a
   * refresh that fails falls back to the last sequence actually observed.
   */
  const recordSeenActivity = useCallback(
    async (threadId: CodeThreadId, immediately = false) => {
      try {
        const read = nextNavigationRead();
        const next = await client.navigation();
        if (!mounted.current) return;
        applyNavigationRefresh(next, read);
        const seen = next.activity.find(
          (entry) => String(entry.threadId) === String(threadId),
        )?.lastSequence;
        const sequence = Number(seen ?? 0);
        if (immediately) readCursorStore.mark(threadId, sequence);
        else readCursorStore.markDeferred(threadId, sequence);
      } catch {
        if (!mounted.current) return;
        markRenderedActivity(threadId);
      }
    },
    [applyNavigationRefresh, client, markRenderedActivity, nextNavigationRead, readCursorStore],
  );

  /**
   * Record everything the host has journaled for a thread as read, and spend
   * any explicit unread mark, because the user asked — from the row's menu or
   * by bringing the thread's already-open view back in front. Distinct from
   * the render-driven marks above: those must never run for a thread nobody is
   * looking at, while this one is itself the user's gesture.
   */
  const markThreadRead = useCallback(
    (threadId: CodeThreadId) => {
      markInteraction("renderer", "code-thread-read");
      void recordSeenActivity(threadId, true);
    },
    [recordSeenActivity],
  );

  const installView = useCallback(
    (view: CodeThreadView) => {
      const resolvedView =
        bootstrapRef.current === undefined
          ? view
          : (refreshActiveThreadView(view, bootstrapRef.current) ?? view);
      setActiveView(resolvedView);
      setBootstrap((current) =>
        current === undefined
          ? current
          : {
              ...current,
              checkouts: replaceById(current.checkouts, resolvedView.checkout),
              threads: replaceById(current.threads, resolvedView.thread),
            },
      );
      setStatus("ready");
      clearFailure();
    },
    [clearFailure],
  );

  const hydrateConversation = useCallback(
    async (threadId: CodeThreadId, request: number, signal: AbortSignal) => {
      let cursor = 0;
      let nextCursor = 0;
      let pageCount = 0;
      const turns: CodeConversationTurn[] = [];
      const messages: CodeConversationMessage[] = [];
      let pageLimits: ReadonlyArray<CodeProviderLimit> = [];
      let pageRestoreUndo: CodeCheckpoint | undefined;
      usageByOperation.current = new Map();
      for (;;) {
        const page = await client.conversation(threadId, cursor, 50, signal);
        if (!isActive(request, threadGeneration, mounted) || page.threadId !== threadId)
          return undefined;
        const evidence = await readConversationEvidence(client, threadId, page.turns, signal);
        if (!isActive(request, threadGeneration, mounted)) return undefined;
        const projected = await projectConversationTurns(
          client,
          threadId,
          page.turns,
          evidence,
          signal,
        );
        if (!isActive(request, threadGeneration, mounted)) return undefined;
        turns.push(...page.turns);
        messages.push(...projected.messages);
        for (const turn of page.turns) {
          if (turn.usage !== undefined) {
            usageByOperation.current.set(String(turn.operationId), turn.usage);
          }
        }
        if (page.limits !== undefined) pageLimits = page.limits;
        pageRestoreUndo = page.restoreUndo;
        nextCursor = page.nextCursor;
        setThreadUsage({ ...totalTurnUsage(usageByOperation.current), limits: pageLimits });
        setRestoreUndo(pageRestoreUndo);
        setConversation([...messages]);
        if (projected.activity.size > 0) {
          setTurnActivity((current) => new Map([...current, ...projected.activity]));
        }
        if (!page.hasMore) break;
        if (page.nextCursor <= cursor || (pageCount += 1) >= 100) {
          throw new Error("Code conversation pagination did not advance.");
        }
        cursor = page.nextCursor;
      }
      const latestTurn = turns.at(-1);
      const incomplete = latestTurn?.status === "incomplete";
      const waiting = latestTurn?.status === "waiting";
      if (latestTurn !== undefined && (incomplete || waiting)) {
        activeTurnOperations.current.set(String(threadId), {
          operationId: latestTurn.operationId,
          status: waiting ? "waiting" : "running",
        });
      } else {
        activeTurnOperations.current.delete(String(threadId));
      }
      setTurnStatus((current) =>
        waiting
          ? "waiting"
          : incomplete
            ? current === "sending"
              ? current
              : "running"
            : current === "running" || current === "waiting"
              ? "idle"
              : current,
      );
      return {
        incomplete,
        activeOperationId: incomplete || waiting ? latestTurn?.operationId : undefined,
        nextCursor,
      };
    },
    [client],
  );

  const activateThread = useCallback(
    async (threadId: CodeThreadId) => {
      const request = ++threadGeneration.current;
      streamAbort.current?.abort();
      const controller = new AbortController();
      streamAbort.current = controller;
      clearFailure();
      // Usage belongs to the thread being left. Hydration may fail, so it is
      // cleared on the way in rather than replaced on the way out; otherwise the
      // new thread would keep showing the previous thread's totals and limits.
      usageByOperation.current = new Map();
      setThreadUsage(EMPTY_THREAD_USAGE);
      // The restore point belongs to the thread being left, for the same
      // reason: hydration may fail, and offering one thread's way back on
      // another thread's checkout would overwrite files nobody asked about.
      setRestoreUndo(undefined);
      setConversationHistory("loading");
      const conversationRead = hydrateConversation(threadId, request, controller.signal);
      void conversationRead.catch(() => undefined);
      try {
        const initial = await client.thread(threadId, controller.signal);
        if (!isActive(request, threadGeneration, mounted)) return;
        installView(initial);
        void refreshFollowUp(threadId);
        let conversationCursor = 0;
        let conversationIncomplete = false;
        let conversationOperationId: CodeOperationId | undefined;
        try {
          const hydrated = await conversationRead;
          conversationIncomplete = hydrated?.incomplete === true;
          conversationOperationId = hydrated?.activeOperationId;
          conversationCursor = hydrated?.nextCursor ?? 0;
          setConversationHistory("loaded");
          // A retried activation that succeeds must also take its own error
          // banner down. Only that message: a first-turn failure noted just
          // before activation still belongs to the user's bounced prompt.
          setTurnError((current) =>
            current === HISTORY_UNAVAILABLE_MESSAGE ? undefined : current,
          );
        } catch {
          if (!isActive(request, threadGeneration, mounted)) return;
          setConversation([]);
          setConversationHistory("unavailable");
          setTurnError(HISTORY_UNAVAILABLE_MESSAGE);
        }
        if (!isActive(request, threadGeneration, mounted)) return;
        // The thread is open in front of the user now: its recorded turns when
        // history loaded, its explicit error state when it did not. Either way
        // they have seen the thread's current state, which is everything the
        // sidebar's unread dot was pointing at. History failures used to keep
        // the mark, which left a dot no amount of opening the thread could
        // clear. Marking stays tied to this open, never to a timer.
        void recordSeenActivity(threadId);
        let cursor = Number(initial.lastSequence);
        let operationStream: Promise<void> | undefined;
        const startConversationOperationStream = (operationId: CodeOperationId) => {
          if (operationStream !== undefined) return;
          operationStream = (async () => {
            let operationCursor = 0;
            let assistantText = "";
            let snapshotRequired = false;
            while (isActive(request, threadGeneration, mounted) && !controller.signal.aborted) {
              if (snapshotRequired) {
                const hydrated = await hydrateConversation(
                  threadId,
                  request,
                  controller.signal,
                ).catch(() => undefined);
                if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) {
                  return;
                }
                if (hydrated === undefined) {
                  await waitForReconnect(controller.signal, 250);
                  continue;
                }
                if (hydrated.incomplete !== true) return;
                operationCursor = 0;
                assistantText = "";
                snapshotRequired = false;
              }
              let received = 0;
              try {
                for await (const frame of client.subscribeOperation(
                  threadId,
                  operationId,
                  operationCursor,
                  controller.signal,
                )) {
                  if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) {
                    return;
                  }
                  const event = frame.event;
                  noteProviderRequest(event);
                  noteActivity(operationId, event);
                  noteUsage(operationId, event);
                  if (event.kind === "provider-content" && event.channel === "reasoning") {
                    const chunk =
                      frame.displayText ??
                      (await readOperationText(
                        client,
                        threadId,
                        operationId,
                        event.content.contentId,
                        controller.signal,
                      ));
                    if (chunk !== undefined) noteReasoning(operationId, chunk);
                  }
                  if (event.kind === "provider-content" && event.channel === "message") {
                    const chunk =
                      frame.displayText ??
                      (await readOperationText(
                        client,
                        threadId,
                        operationId,
                        event.content.contentId,
                        controller.signal,
                      ));
                    if (
                      !isActive(request, threadGeneration, mounted) ||
                      controller.signal.aborted
                    ) {
                      return;
                    }
                    if (chunk !== undefined) {
                      assistantText += chunk;
                      const nextText = assistantText;
                      setConversation((current) =>
                        current.map((message) =>
                          message.id === `${operationId}:assistant`
                            ? { ...message, text: nextText, status: "incomplete" }
                            : message,
                        ),
                      );
                    }
                  }

                  let terminalState: "completed" | "waiting" | "interrupted" | "failed" | undefined;
                  let terminalMessage: string | undefined;
                  if (event.kind === "operation-state" && event.state !== "running") {
                    terminalState = event.state;
                    terminalMessage = event.failure?.message;
                  } else if (
                    event.kind === "operation-result" &&
                    event.result.kind === "provider-turn-state" &&
                    event.result.state !== "running"
                  ) {
                    terminalState = event.result.state;
                  } else if (
                    event.kind === "operation-result" &&
                    event.result.kind === "operation-failed"
                  ) {
                    terminalState = "failed";
                    terminalMessage = event.result.failure.message;
                  }

                  operationCursor = Number(frame.cursor);
                  received += 1;
                  // The frame is on screen, so the activity the host had
                  // reported by now has been read.
                  markRenderedActivity(threadId);
                  if (terminalState !== undefined) {
                    activeTurnOperations.current.delete(String(threadId));
                    if (terminalState !== "waiting") setProviderRequests([]);
                    const hydrated = await hydrateConversation(
                      threadId,
                      request,
                      controller.signal,
                    ).catch(() => undefined);
                    // The turn ended in front of the user. Recording it here,
                    // rather than waiting for the timed refresh, is what keeps
                    // leaving for another thread in the same moment from
                    // raising an unread mark for the turn they just watched.
                    // It is neither awaited nor guarded by the active thread:
                    // the frame is already rendered, and the composer should
                    // not wait on a read the user has no stake in.
                    void recordSeenActivity(threadId);
                    if (!isActive(request, threadGeneration, mounted)) return;
                    if (terminalState === "completed") {
                      if (hydrated?.incomplete !== true) {
                        setTurnStatus("idle");
                        setTurnError(undefined);
                      }
                    } else {
                      setTurnStatus(terminalState === "waiting" ? "waiting" : "failed");
                      setTurnError(
                        terminalMessage ??
                          (terminalState === "waiting"
                            ? "The provider turn is waiting for approval, input, or recovery."
                            : `Provider turn ${terminalState}.`),
                      );
                    }
                    return;
                  }
                }
              } catch (error) {
                // A gap means later deltas have no trustworthy base. Reload
                // the durable conversation before replaying the operation
                // from its beginning; ordinary disconnects resume at the last
                // fully applied cursor.
                if (error instanceof CodeClientSnapshotRequiredError) snapshotRequired = true;
              }
              if (!controller.signal.aborted) {
                await waitForReconnect(controller.signal, received === 0 ? 250 : 50);
              }
            }
          })().finally(() => {
            operationStream = undefined;
          });
        };
        if (conversationOperationId !== undefined) {
          startConversationOperationStream(conversationOperationId);
        }
        let conversationPoll: Promise<void> | undefined;
        const startConversationPoll = () => {
          if (conversationPoll !== undefined) return;
          conversationPoll = (async () => {
            let delayMs = 250;
            while (isActive(request, threadGeneration, mounted) && !controller.signal.aborted) {
              await waitForReconnect(controller.signal, delayMs);
              await waitUntilDocumentVisible(controller.signal);
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                return;
              try {
                const latest = await client.conversation(
                  threadId,
                  Math.max(0, conversationCursor - 1),
                  1,
                  controller.signal,
                );
                if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                  return;
                if (latest.threadId !== threadId || latest.turns.at(-1)?.status === "incomplete") {
                  delayMs = Math.min(delayMs * 2, 2_000);
                  continue;
                }
                const hydrated = await hydrateConversation(threadId, request, controller.signal);
                if (hydrated?.incomplete !== true) {
                  // Same reason as the streamed terminal frame: the finished
                  // turn is on screen now, and the timed refresh that would
                  // otherwise report it may not run until the user has left.
                  void recordSeenActivity(threadId);
                  setTurnError((current) =>
                    current === "Conversation history could not be refreshed."
                      ? undefined
                      : current,
                  );
                  return;
                }
                conversationCursor = hydrated.nextCursor;
              } catch {
                if (!isActive(request, threadGeneration, mounted)) return;
                setTurnError("Conversation history could not be refreshed.");
              }
            }
          })().finally(() => {
            conversationPoll = undefined;
          });
        };
        if (conversationIncomplete) startConversationPoll();

        let reconnectBackoffMs = MIN_CODE_RECONNECT_BACKOFF_MS;
        let reconnectFailed = false;
        /**
         * Catch up from the authoritative thread view after the event stream
         * dropped, and wait before opening it again.
         *
         * A snapshot the client cannot fetch is exactly what a machine that
         * slept through the host's answer sees, so it is a reason to ask again
         * more slowly — never a reason to stop. Giving up here would freeze the
         * thread at whatever event happened to arrive last. The stream is only
         * reopened once a snapshot has actually been read, because the events
         * after a gap mean nothing without the state they continue from.
         */
        const resume = async (): Promise<"stop" | "again"> => {
          for (;;) {
            try {
              const recovered = await client.thread(threadId, controller.signal);
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) {
                return "stop";
              }
              installView(recovered);
              cursor = Number(recovered.lastSequence);
              reconnectBackoffMs = MIN_CODE_RECONNECT_BACKOFF_MS;
              if (reconnectFailed) {
                reconnectFailed = false;
                clearFailure();
                setStatus("ready");
              }
              await waitForReconnect(controller.signal, reconnectDelayMs);
              return "again";
            } catch (error) {
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) {
                return "stop";
              }
              reconnectFailed = true;
              fail(error);
              await waitForReconnect(controller.signal, reconnectBackoffMs);
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) {
                return "stop";
              }
              reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_CODE_RECONNECT_DELAY_MS);
            }
          }
        };

        for (;;) {
          if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) return;
          let snapshotRequired = false;
          try {
            const frames = client.subscribe(threadId, cursor, controller.signal);
            for await (const frame of frames) {
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                return;
              if (!acceptFrame(frame, threadId, cursor)) {
                snapshotRequired = true;
                break;
              }
              cursor = Number(frame.sequence);
              setBootstrap((current) => applyEvent(current, frame));
              const refreshed = await client.thread(threadId, controller.signal);
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                return;
              installView(refreshed);
              void refreshFollowUp(threadId);
              if (conversationPoll === undefined) {
                try {
                  const hydrated = await hydrateConversation(threadId, request, controller.signal);
                  conversationIncomplete = hydrated?.incomplete === true;
                  conversationOperationId = hydrated?.activeOperationId;
                  conversationCursor = hydrated?.nextCursor ?? conversationCursor;
                  // The thread's state and its recorded turns were both
                  // re-read into the transcript, so the activity the host had
                  // reported by now has been read.
                  markRenderedActivity(threadId);
                  if (conversationIncomplete) {
                    startConversationPoll();
                    if (conversationOperationId !== undefined) {
                      startConversationOperationStream(conversationOperationId);
                    }
                  }
                } catch {
                  if (!isActive(request, threadGeneration, mounted)) return;
                  setTurnError("Conversation history could not be refreshed.");
                }
              }
              cursor = Number(refreshed.lastSequence);
            }
            if (!snapshotRequired) {
              await waitForReconnect(controller.signal, reconnectDelayMs);
              continue;
            }
          } catch {
            if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) return;
          }
          if ((await resume()) === "stop") return;
        }
      } catch (error) {
        if (!isActive(request, threadGeneration, mounted)) return;
        controller.abort();
        fail(error);
      }
    },
    [
      clearFailure,
      client,
      fail,
      hydrateConversation,
      installView,
      markRenderedActivity,
      reconnectDelayMs,
      recordSeenActivity,
      refreshFollowUp,
    ],
  );

  const followUpThreadKey = useMemo(
    () =>
      (bootstrap?.threads ?? [])
        .filter((thread) => thread.lifecycle !== "archived")
        .map((thread) => String(thread.id))
        .join(","),
    [bootstrap],
  );

  useEffect(() => {
    const ids = followUpThreadKey === "" ? [] : followUpThreadKey.split(",");
    let active = true;
    void (async () => {
      const views = await Promise.all(
        ids.map(async (id) => {
          try {
            return { id, view: await client.readFollowUp(id as CodeThreadId) };
          } catch {
            // A per-thread follow-up read failure is non-fatal to navigation.
            return undefined;
          }
        }),
      );
      if (!active || !mounted.current) return;
      if (views.length === 0) return;
      setFollowUps((current) => {
        const next = new Map(current);
        for (const result of views) {
          if (result !== undefined) next.set(result.id, result.view);
        }
        return next;
      });
    })();
    return () => {
      active = false;
    };
  }, [client, followUpThreadKey]);

  useEffect(() => {
    mounted.current = true;
    void loadBootstrap("bootstrap");
    return () => {
      mounted.current = false;
      bootstrapGeneration.current += 1;
      threadGeneration.current += 1;
      bootstrapAbort.current.abort();
      streamAbort.current?.abort();
      turnAbort.current?.abort();
    };
  }, [loadBootstrap]);

  useEffect(() => {
    activeThreadId.current = options.activeThreadId;
    threadGeneration.current += 1;
    streamAbort.current?.abort();
    streamAbort.current = undefined;
    turnAbort.current?.abort();
    turnAbort.current = undefined;
    setConversation([]);
    setConversationHistory("loading");
    setProviderRequests([]);
    setTurnActivity(new Map());
    setTurnStatus(
      options.activeThreadId === undefined
        ? "idle"
        : (activeTurnOperations.current.get(String(options.activeThreadId))?.status ?? "idle"),
    );
    const firstTurnFailure =
      options.activeThreadId === undefined
        ? undefined
        : firstTurnFailures.current.get(String(options.activeThreadId));
    setTurnError(firstTurnFailure?.message);
    if (firstTurnFailure !== undefined) {
      setPendingDraft(firstTurnFailure.prompt);
      firstTurnFailures.current.delete(String(options.activeThreadId));
    }
    if (options.activeThreadId === undefined) {
      setActiveView(undefined);
      return;
    }
    void activateThread(options.activeThreadId);
  }, [activateThread, options.activeThreadId]);

  // The current thread list, read inside callbacks that must not re-create
  // themselves every time a thread's version changes.
  // How far each thread's own journaled activity has reached. A provider turn
  // never touches the thread aggregate, so this — not `thread.version` — is the
  // only number that moves when one runs or finishes.
  const activityByThread = useMemo(() => {
    const byThread = new Map<string, number>();
    for (const entry of bootstrap?.activity ?? []) {
      byThread.set(String(entry.threadId), Number(entry.lastSequence));
    }
    return byThread;
  }, [bootstrap]);
  const runtimeByThread = useMemo(() => {
    const byThread = new Map<
      string,
      {
        readonly executing: boolean;
        readonly checkoutChip?: {
          readonly checkoutKind: "managed-worktree";
          readonly label: string;
        };
      }
    >();
    for (const entry of bootstrap?.runtime ?? []) {
      byThread.set(String(entry.threadId), {
        executing: entry.executing,
        ...(entry.checkoutChip === undefined ? {} : { checkoutChip: entry.checkoutChip }),
      });
    }
    return byThread;
  }, [bootstrap]);
  // Being the thread on screen is not the same as having shown what the host
  // journaled. A refresh reports activity for every thread, including one whose
  // snapshot or operation stream is late or gone, and a read cursor only moves
  // forward: marking here would spend an unread mark the user never saw. The
  // transcript itself records what it renders, through `markRenderedActivity`
  // and `recordSeenActivity`.
  observedActivity.current = activityByThread;

  const navigation = useMemo(
    (): ReadonlyArray<CodeThreadNavigationItem> =>
      (bootstrap?.threads ?? [])
        .filter((thread) => thread.lifecycle !== "archived")
        .map((thread) => {
          const runtime = runtimeByThread.get(String(thread.id));
          return {
            executionPolicy: thread.executionPolicy,
            lifecycle: thread.lifecycle,
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            threadId: thread.id,
            title: thread.title,
            followUp: followUps.get(String(thread.id))?.followUp?.state === "open",
            unread:
              markedUnreadThreads.has(String(thread.id)) ||
              (activityByThread.get(String(thread.id)) ?? 0) >
                (readCursors.get(String(thread.id)) ?? 0),
            ...(runtime?.executing === true ? { executing: true } : {}),
            ...(runtime?.checkoutChip === undefined ? {} : { checkoutChip: runtime.checkoutChip }),
            ...(thread.pinned === true ? { pinned: true } : {}),
            ...(thread.forkedFrom === undefined
              ? {}
              : { lineageParentThreadId: String(thread.forkedFrom.threadId) }),
            updatedAt: thread.updatedAt,
          };
        })
        // Pinned threads lead, and the order inside each group is the host's.
        // Sorting the whole list by recency instead would move a pinned thread
        // the moment anything else ran, which is the opposite of pinning it.
        .sort((left, right) => Number(right.pinned ?? false) - Number(left.pinned ?? false)),
    [activityByThread, bootstrap, followUps, markedUnreadThreads, readCursors, runtimeByThread],
  );

  // Only the thread in view streams, so the list is re-read on a timer to keep
  // titles, lifecycle, and access current for threads nobody is watching.
  //
  // The activity sequence is what makes background provider output visible
  // here. A turn is journaled on the `code-operation` aggregate, so a thread's
  // own version stands still while it runs; the host projects the operation
  // events per thread and reports that instead, which is what the unread mark
  // compares against.
  useEffect(() => {
    if (navigationRefreshMs <= 0) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      markInteraction("renderer", "code-navigation-refresh");
      try {
        const read = nextNavigationRead();
        const next = await client.navigation();
        if (cancelled || !mounted.current) return;
        applyNavigationRefresh(next, read);
      } catch {
        // A refresh that fails leaves the last list on screen; the stream and
        // the retry path are what report a host that has actually gone away.
      } finally {
        inFlight = false;
      }
    };
    const stop = scheduleVisibleInterval(() => void refresh(), navigationRefreshMs);
    return () => {
      cancelled = true;
      stop();
    };
  }, [applyNavigationRefresh, client, navigationRefreshMs, nextNavigationRead]);

  useEffect(() => {
    if (
      options.changeRevision === undefined ||
      options.changeRevision <= 0 ||
      bootstrapRef.current === undefined
    )
      return;
    let cancelled = false;
    const read = nextNavigationRead();
    void client
      .navigation()
      .then((next) => {
        if (cancelled || !mounted.current) return;
        applyNavigationRefresh(next, read);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applyNavigationRefresh, client, nextNavigationRead, options.changeRevision]);

  const execute = useCallback(
    async (command: CodeCommand, signal?: AbortSignal): Promise<CodeCommandResult | undefined> => {
      clearFailure();
      lastExecuteError.current = undefined;
      try {
        const result =
          signal === undefined
            ? await client.execute(command)
            : await client.execute(command, signal);
        if (!mounted.current) return undefined;
        setBootstrap((current) => applyResult(current, result));
        const currentThreadId = activeThreadId.current;
        if (currentThreadId !== undefined && commandTargets(command, currentThreadId)) {
          void activateThread(currentThreadId);
        } else if (result.kind === "thread-created") {
          await loadBootstrap();
        }
        return result;
      } catch (error) {
        if (!mounted.current) return undefined;
        if (signal?.aborted) return undefined;
        const failure = codeFailure(error);
        lastExecuteError.current = failure;
        if (failure.category === "stale" || failure.category === "conflict") {
          const loaded = await loadBootstrap("conflict");
          const currentThreadId = activeThreadId.current;
          if (loaded && currentThreadId !== undefined) void activateThread(currentThreadId);
          return undefined;
        }
        fail(error);
        return undefined;
      }
    },
    [activateThread, clearFailure, client, fail, loadBootstrap],
  );

  const beginProviderTurn = useCallback(
    async (input: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly prompt: string;
      /**
       * `#thread` mentions this turn points at. Ids only: the host resolves
       * each one against the sender's own authority when the turn runs, so a
       * mention is context for this turn and never part of the prompt evidence
       * the journal records as the message.
       */
      readonly threadMentionIds?: ReadonlyArray<MentionableThreadId>;
      /**
       * Images this turn carries. Ids only: the host holds the bytes it
       * accepted and reads them itself, so the renderer never re-sends an
       * image and never decides what an id stands for.
       */
      readonly attachmentIds?: ReadonlyArray<CodeAttachmentId>;
      readonly fileMentionPaths?: ReadonlyArray<string>;
      /**
       * The posture this turn asks to run under. The host clamps it to the
       * thread's grant, so this is an intent, not a grant.
       */
      readonly executionPolicy?: ProviderExecutionPolicy;
      readonly signal?: AbortSignal;
    }) => {
      const reference = await client.putEvidence(input.threadId, input.prompt);
      if (input.signal?.aborted === true) {
        throw new DOMException("Provider turn was interrupted.", "AbortError");
      }
      const operationId = decodeCodeOperationId(globalThis.crypto.randomUUID());
      const sessionId = decodeProviderSessionId(globalThis.crypto.randomUUID());
      const started = await client.executeOperation({
        kind: "start-provider-turn",
        operationId,
        threadId: input.threadId,
        checkoutId: input.checkoutId,
        sessionId,
        prompt: reference,
        ...(input.threadMentionIds === undefined || input.threadMentionIds.length === 0
          ? {}
          : { threadMentionIds: [...input.threadMentionIds] }),
        ...(input.attachmentIds === undefined || input.attachmentIds.length === 0
          ? {}
          : { attachmentIds: [...input.attachmentIds] }),
        ...(input.fileMentionPaths === undefined || input.fileMentionPaths.length === 0
          ? {}
          : { fileMentionPaths: [...input.fileMentionPaths] }),
        ...(input.executionPolicy === undefined ? {} : { executionPolicy: input.executionPolicy }),
      });
      return { operationId, started } as const;
    },
    [client],
  );

  const startThreadTurn = useCallback(
    async (input: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly prompt: string;
      readonly threadMentionIds?: ReadonlyArray<MentionableThreadId>;
      readonly attachmentIds?: ReadonlyArray<CodeAttachmentId>;
      readonly fileMentionPaths?: ReadonlyArray<string>;
    }): Promise<boolean> => {
      const prompt = input.prompt.trim();
      if (prompt.length === 0) return false;
      firstTurnFailures.current.delete(String(input.threadId));
      clearFailure();
      setTurnError(undefined);
      setTurnStatus("sending");
      const failFirstTurn = (message: string) => {
        firstTurnFailures.current.set(String(input.threadId), { prompt, message });
        activeTurnOperations.current.delete(String(input.threadId));
        setTurnStatus("failed");
        setTurnError(message);
        // Activation is what usually restores this prompt, but a first turn can
        // fail on a thread that is already open — the New Code composer opens
        // the thread before starting — so put it back now or the composer stays
        // empty in front of the error.
        if (String(activeThreadId.current) === String(input.threadId)) {
          setPendingDraft(prompt);
          firstTurnFailures.current.delete(String(input.threadId));
        }
      };
      try {
        const { operationId, started } = await beginProviderTurn({ ...input, prompt });
        if (started.kind === "operation-failed") {
          failFirstTurn(started.failure.message);
          return false;
        }
        if (started.kind !== "provider-turn-state" || started.state !== "running") {
          failFirstTurn("The provider turn could not be started.");
          return false;
        }
        activeTurnOperations.current.set(String(input.threadId), {
          operationId,
          status: "running",
        });
        setTurnStatus("running");
        // Opening a newly created thread hydrates before this first turn is
        // journaled, so the transcript reads empty. A provider turn does not
        // emit thread events, so the already-running activation never hydrates
        // or streams again unless we ask it to.
        if (String(activeThreadId.current) === String(input.threadId)) {
          void activateThread(input.threadId);
        }
        return true;
      } catch (error) {
        const failure = codeFailure(error);
        failFirstTurn(failure.message);
        fail(error);
        return false;
      }
    },
    [activateThread, beginProviderTurn, clearFailure, fail, setPendingDraft],
  );

  const refreshConversation = useCallback((): boolean => {
    const threadId = activeThreadId.current;
    if (threadId === undefined) return false;
    void activateThread(threadId);
    return true;
  }, [activateThread]);

  /**
   * Rename or pin one thread through the ordinary command path.
   *
   * Both carry the version the renderer last saw, so two windows renaming the
   * same thread produce a stale failure the reload path already handles rather
   * than one silently overwriting the other.
   */
  const renameThread = useCallback(
    async (threadId: CodeThreadId, title: string): Promise<boolean> => {
      const thread = bootstrapRef.current?.threads.find(
        (candidate) => String(candidate.id) === String(threadId),
      );
      if (thread === undefined) return false;
      const result = await execute({
        kind: "rename-code-thread",
        threadId,
        expectedVersion: thread.version,
        title: title as never,
      });
      return result !== undefined;
    },
    [execute],
  );

  /**
   * Start a new thread that continues an existing one from a chosen answer.
   *
   * The fork binds the same checkout, provider, model, and posture as its
   * source, and records where it branched from so the host — not this
   * renderer — decides what history its first turn carries. Nothing about the
   * source thread changes: a fork is a second direction, not a rewrite.
   */
  const forkThread = useCallback(
    async (input: {
      readonly threadId: CodeThreadId;
      readonly throughOperationId: string;
      readonly title: string;
    }): Promise<CodeThread | undefined> => {
      const source = bootstrapRef.current?.threads.find(
        (candidate) => String(candidate.id) === String(input.threadId),
      );
      if (source === undefined) return undefined;
      // The server refuses a thread whose checkout does not match the one it
      // just prepared, so the fork binds a freshly observed checkout rather
      // than the identity this renderer happens to be holding.
      const prepared = await execute({
        kind: "prepare-code-project-checkout",
        projectId: source.projectId,
      });
      if (prepared?.kind !== "checkout-prepared") return undefined;
      // Re-observing is right only when the renderer's identity is stale enough
      // that bootstrap no longer knows the checkout at all. A checkout bootstrap
      // still lists is still real and still different, and only the Project's is
      // accepted for a new thread, so forking would inherit the conversation
      // while opening another branch and working tree. Availability does not
      // soften that: a managed worktree that is waiting or unrecovered is the
      // same tree, temporarily out of reach, and pointing the fork at the
      // Project's checkout instead would silently rebind the work.
      const sourceCheckout = bootstrapRef.current?.checkouts.find(
        (candidate) => String(candidate.id) === String(source.checkoutId),
      );
      if (
        sourceCheckout !== undefined &&
        String(prepared.checkout.id) !== String(sourceCheckout.id)
      ) {
        return undefined;
      }
      const timestamp = new Date().toISOString();
      // A fork is its own thread and does not inherit the source's profile. A
      // one-off profile belongs to the source by definition, and one deleted
      // since the source started would refuse the fork outright; either way the
      // fork begins with no profile until someone picks one for it.
      const { profileId: _inheritedProfileId, ...carried } = source;
      let thread: CodeThread;
      try {
        thread = decodeCodeThread({
          ...carried,
          id: globalThis.crypto.randomUUID(),
          bindingRevisionId: prepared.bindingRevisionId,
          repositoryId: prepared.checkout.repositoryId,
          checkoutId: prepared.checkout.id,
          title: input.title,
          lifecycle: "active",
          pinned: false,
          // A fork is a new thread, and the server requires a native approval
          // bound to that thread before it may hold Full access. Inheriting the
          // source's posture here would carry no receipt, so the fork starts
          // approval-gated and is raised the same way any thread is.
          executionPolicy: "approval-gated",
          forkedFrom: { threadId: input.threadId, throughOperationId: input.throughOperationId },
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      } catch {
        return undefined;
      }
      const created = await execute({ kind: "create-code-thread", thread });
      return created?.kind === "thread-created" ? created.thread : undefined;
    },
    [execute],
  );

  /**
   * Move a thread onto the checkout its Project binds now, because the user
   * asked from the fail-closed banner.
   *
   * Never inferred: a thread whose Project was rebound keeps the authority it
   * was created with until someone deliberately moves it, which is the whole
   * point of binding a checkout in the first place. The host decides whether
   * the move is admissible and answers with a refusal reason this renderer
   * shows rather than a failure it swallows.
   */
  const rebindThreadCheckout = useCallback(
    async (threadId: CodeThreadId): Promise<CodeThreadCheckoutRebindOutcome | undefined> => {
      const thread = bootstrapRef.current?.threads.find(
        (candidate) => String(candidate.id) === String(threadId),
      );
      if (thread === undefined) return undefined;
      const result = await execute({
        kind: "rebind-code-thread-checkout",
        threadId,
        expectedVersion: thread.version,
      });
      return result?.kind === "thread-checkout-rebind" ? result.outcome : undefined;
    },
    [execute],
  );

  const pinThread = useCallback(
    async (threadId: CodeThreadId, pinned: boolean): Promise<boolean> => {
      const thread = bootstrapRef.current?.threads.find(
        (candidate) => String(candidate.id) === String(threadId),
      );
      if (thread === undefined) return false;
      const result = await execute({
        kind: "pin-code-thread",
        threadId,
        expectedVersion: thread.version,
        pinned,
      });
      return result !== undefined;
    },
    [execute],
  );

  /**
   * Move a thread out of the lists without deleting it. Archiving carries the
   * version the renderer last saw, so two windows archiving at once produce a
   * stale failure the reload path already handles.
   */
  const archiveThread = useCallback(
    async (threadId: CodeThreadId): Promise<boolean> => {
      const thread = bootstrapRef.current?.threads.find(
        (candidate) => String(candidate.id) === String(threadId),
      );
      if (thread === undefined) return false;
      const result = await execute({
        kind: "change-code-thread-lifecycle",
        threadId,
        expectedVersion: thread.version,
        lifecycle: "archived",
      });
      return result !== undefined;
    },
    [execute],
  );

  const markFollowUp = useCallback(
    async (threadId: CodeThreadId, reason?: string): Promise<boolean> => {
      const view = followUps.get(String(threadId)) ?? (await refreshFollowUp(threadId));
      if (view === undefined) return false;
      // A manual mark must always open (or reopen) the marker, so pick a source
      // sequence strictly newer than any prior trigger or acknowledgement.
      const base = Math.max(
        view.followUp?.triggerSequence ?? 0,
        view.followUp?.acknowledgedThroughSequence ?? 0,
      );
      const text = (reason ?? "").trim() || "Marked for follow-up";
      try {
        await client.executeFollowUp({
          kind: "open-code-follow-up",
          threadId,
          expectedVersion: view.followUpVersion,
          reason: text as never,
          origin: "manual",
          triggerSequence: (base + 1) as never,
        });
        await refreshFollowUp(threadId);
        return true;
      } catch (error) {
        if (!mounted.current) return false;
        fail(error);
        return false;
      }
    },
    [client, fail, followUps, refreshFollowUp],
  );

  const completeFollowUp = useCallback(
    async (threadId: CodeThreadId): Promise<boolean> => {
      const view = followUps.get(String(threadId)) ?? (await refreshFollowUp(threadId));
      if (view?.followUp === undefined || view.followUp.state !== "open") return false;
      try {
        await client.executeFollowUp({
          kind: "complete-code-follow-up",
          threadId,
          expectedVersion: view.followUpVersion,
          acknowledgedThroughSequence: view.followUp.triggerSequence,
        });
        await refreshFollowUp(threadId);
        return true;
      } catch (error) {
        if (!mounted.current) return false;
        fail(error);
        return false;
      }
    },
    [client, fail, followUps, refreshFollowUp],
  );

  async function updateSettings(input: {
    readonly defaultExecutionPolicy: CodeThread["executionPolicy"];
    readonly defaultPermissionPersistence: CodeThread["permissionPersistence"];
    readonly externalEditor?: CodeExternalEditor;
  }): Promise<boolean> {
    if (bootstrap === undefined) return false;
    const result = await execute({
      kind: "update-code-settings",
      expectedVersion: bootstrap.settings.version,
      ...input,
    });
    return result?.kind === "settings-updated";
  }

  const sendFollowUp = useCallback(
    async (
      prompt: string,
      /**
       * `#thread` mentions this follow-up points at. Ids only: the host
       * resolves each one against the sender's own authority when the turn
       * runs, so the mention is context for this turn and never part of the
       * message.
       */
      threadMentionIds: ReadonlyArray<MentionableThreadId> = [],
      /** Images the host already staged for this thread. */
      attachments: ReadonlyArray<CodeAttachmentReference> = [],
      /** `@file` paths this follow-up names; the host re-checks each one. */
      fileMentionPaths: ReadonlyArray<string> = [],
      /**
       * The posture this follow-up asks to run under. The host clamps it to
       * the thread's grant. Absent means the thread's own posture.
       */
      executionPolicy?: ProviderExecutionPolicy,
      /** True when the composer already cleared this draft while it waited. */
      delayed?: boolean,
    ): Promise<boolean> => {
      const trimmed = prompt.trim();
      const view = activeView?.thread.id === activeThreadId.current ? activeView : undefined;
      if (trimmed.length === 0 || view === undefined) return false;
      if (turnStatus === "sending" || turnStatus === "running") return false;

      clearFailure();
      setTurnError(undefined);
      setTurnStatus("sending");
      const sendingThreadId = String(view.thread.id);
      const draftRevisionAtDispatch = composerDraftRef.current.revisionFor(sendingThreadId);
      const previousDraft = composerDraftRef.current.readFor(sendingThreadId);
      let internalClearRan = false;
      const restoreFailedPrompt = () => {
        const currentRevision = composerDraftRef.current.revisionFor(sendingThreadId);
        if (
          currentRevision !== draftRevisionAtDispatch &&
          (!internalClearRan || currentRevision !== draftRevisionAtDispatch + 1)
        ) {
          return;
        }
        composerDraftRef.current.restoreFor(sendingThreadId, {
          text: trimmed,
          caretIndex: previousDraft?.caretIndex ?? trimmed.length,
          stagedDropped: previousDraft?.stagedDropped === true,
        });
      };
      const userMessage: CodeConversationMessage = {
        id: globalThis.crypto.randomUUID(),
        role: "user",
        text: trimmed,
        providerInstanceId: view.thread.providerInstanceId,
        modelId: view.thread.modelId,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(executionPolicy === undefined ? {} : { executionPolicy }),
      };

      turnAbort.current?.abort();
      const controller = new AbortController();
      turnAbort.current = controller;
      const assistantId = globalThis.crypto.randomUUID();

      try {
        const { operationId, started } = await beginProviderTurn({
          threadId: view.thread.id,
          checkoutId: view.checkout.id,
          prompt: trimmed,
          threadMentionIds,
          attachmentIds: attachments.map((attachment) => attachment.attachmentId),
          fileMentionPaths,
          ...(executionPolicy === undefined ? {} : { executionPolicy }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return false;
        if (started.kind === "operation-failed") {
          setTurnStatus("failed");
          setTurnError(started.failure.message);
          restoreFailedPrompt();
          return false;
        }
        if (started.kind !== "provider-turn-state" || started.state !== "running") {
          setTurnStatus("failed");
          setTurnError("The provider turn could not be started.");
          restoreFailedPrompt();
          return false;
        }
        setTurnStatus("running");
        // A steered send may have emptied the composer so the user can keep
        // typing. Clearing here is safe only when no draft revision landed
        // after this dispatch.
        if (
          delayed !== true &&
          composerDraftRef.current.revisionFor(sendingThreadId) === draftRevisionAtDispatch
        ) {
          composerDraftRef.current.clearFor(sendingThreadId);
          internalClearRan = true;
        }
        setConversation((current) => [
          ...current,
          { ...userMessage, operationId },
          {
            id: assistantId,
            role: "assistant",
            text: "",
            // The transcript reads this turn's tool and reasoning rows by
            // operation, so a live message must name its operation the same way
            // a replayed one does.
            operationId,
            status: "incomplete",
            providerInstanceId: view.thread.providerInstanceId,
            modelId: view.thread.modelId,
          },
        ]);

        let cursor = 0;
        let assistantText = "";
        let terminal = false;
        const settleActiveTurn = (
          status: "waiting" | "interrupted" | "failed",
          message: string,
        ) => {
          setTurnStatus(status === "waiting" ? "waiting" : "failed");
          setTurnError(message);
          restoreFailedPrompt();
          setConversation((current) =>
            current.map((entry) =>
              entry.id === assistantId
                ? { ...entry, text: entry.text.trim().length > 0 ? entry.text : message, status }
                : entry,
            ),
          );
        };
        while (!terminal && !controller.signal.aborted) {
          let received = 0;
          for await (const frame of client.subscribeOperation(
            view.thread.id,
            operationId,
            cursor,
            controller.signal,
          )) {
            received += 1;
            cursor = Number(frame.cursor);
            const event = frame.event;
            noteProviderRequest(event);
            noteActivity(operationId, event);
            noteUsage(operationId, event);
            // The checkpoint is only known once the host has taken it, so the
            // message the user already sees gains its restore point here
            // rather than waiting for the thread to be reopened.
            if (event.kind === "conversation-turn-started") {
              const checkpoint = event.checkpoint;
              const ranUnder = event.executionPolicy;
              if (checkpoint !== undefined || ranUnder !== undefined) {
                setConversation((current) =>
                  current.map((entry) =>
                    entry.id === userMessage.id
                      ? {
                          ...entry,
                          ...(checkpoint === undefined ? {} : { checkpoint }),
                          ...(ranUnder === undefined ? {} : { executionPolicy: ranUnder }),
                        }
                      : entry,
                  ),
                );
              }
            }
            if (event.kind === "provider-content" && event.channel === "reasoning") {
              const chunk =
                frame.displayText ??
                (await readOperationText(
                  client,
                  view.thread.id,
                  operationId,
                  event.content.contentId,
                  controller.signal,
                ));
              if (chunk !== undefined) noteReasoning(operationId, chunk);
            }
            if (event.kind === "provider-content" && event.channel === "message") {
              const chunk =
                frame.displayText ??
                (await readOperationText(
                  client,
                  view.thread.id,
                  operationId,
                  event.content.contentId,
                  controller.signal,
                ));
              if (chunk !== undefined) {
                assistantText += chunk;
                const nextText = assistantText;
                setConversation((current) =>
                  current.map((message) =>
                    message.id === assistantId ? { ...message, text: nextText } : message,
                  ),
                );
              }
            }
            if (event.kind === "operation-state") {
              if (event.state !== "running") {
                terminal = true;
                if (event.state !== "completed") {
                  settleActiveTurn(
                    event.state,
                    event.failure?.message ??
                      (event.state === "waiting"
                        ? "The provider turn is waiting for approval, input, or recovery."
                        : `Provider turn ${event.state}.`),
                  );
                  return false;
                }
              }
            }
            if (event.kind === "operation-result") {
              if (event.result.kind === "provider-turn-state") {
                terminal = event.result.state !== "running";
                if (
                  event.result.state === "waiting" ||
                  event.result.state === "interrupted" ||
                  event.result.state === "failed"
                ) {
                  settleActiveTurn(
                    event.result.state,
                    event.result.state === "waiting"
                      ? "The provider turn is waiting for approval, input, or recovery."
                      : `Provider turn ${event.result.state}.`,
                  );
                  return false;
                }
              } else if (event.result.kind === "operation-failed") {
                terminal = true;
                settleActiveTurn("failed", event.result.failure.message);
                return false;
              } else {
                terminal = event.result.kind !== "operation-accepted";
              }
            }
          }
          if (!terminal && received === 0) {
            await waitForReconnect(controller.signal, 150);
          }
        }
        setProviderRequests([]);
        if (controller.signal.aborted) return false;
        setConversation((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: "completed",
                  text:
                    assistantText.trim() === ""
                      ? "The provider turn finished without a visible reply."
                      : message.text,
                }
              : message,
          ),
        );
        setTurnStatus("idle");
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        const failure = codeFailure(error);
        setTurnStatus("failed");
        setTurnError(failure.message);
        restoreFailedPrompt();
        fail(error);
        return false;
      }
    },
    [activeView, beginProviderTurn, clearFailure, client, fail, turnStatus],
  );

  const answerProviderRequest = useCallback(
    async (answer: CodeProviderAnswer): Promise<boolean> => {
      const view = activeView;
      if (view === undefined) return false;
      const scope = {
        operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
        threadId: view.thread.id,
        checkoutId: view.checkout.id,
      } as const;
      try {
        const result =
          answer.kind === "approval"
            ? await client.executeOperation({
                kind: "answer-provider-approval",
                ...scope,
                approvalId: answer.approvalId,
                decision: answer.decision,
              })
            : await client.executeOperation({
                kind: "answer-provider-input",
                ...scope,
                requestId: answer.requestId,
                response: await client.putEvidence(view.thread.id, answer.response),
              });
        if (!mounted.current) return false;
        if (result.kind === "operation-failed") {
          setTurnError(result.failure.message);
          return false;
        }
        setProviderRequests((current) =>
          current.filter((request) =>
            answer.kind === "approval"
              ? !(request.kind === "approval" && request.approvalId === answer.approvalId)
              : !(request.kind === "input" && request.requestId === answer.requestId),
          ),
        );
        return true;
      } catch (error) {
        if (!mounted.current) return false;
        setTurnError(codeFailure(error).message);
        return false;
      }
    },
    [activeView, client],
  );

  return {
    activeView: activeView?.thread.id === options.activeThreadId ? activeView : undefined,
    answerProviderRequest,
    archiveThread,
    bootstrap,
    client,
    conversation,
    completeFollowUp,
    errorCategory,
    errorMessage,
    followUps,
    forkThread,
    lastExecuteError,
    editorDrafts,
    execute,
    markFollowUp,
    markThreadRead,
    navigation,
    pendingDraft,
    pendingDraftCaret: composerDraft.caretIndex,
    draftStagedDropped: composerDraft.stagedDropped,
    draftPersistError: composerDraft.persistError,
    markDraftStagedDropped: composerDraft.markStagedDropped,
    purgeThreadDraft: composerDraft.purge,
    pinThread,
    rebindThreadCheckout,
    renameThread,
    providerRequests,
    refreshFollowUp,
    refreshConversation,
    restoreUndo,
    noteRestoreUndo,
    // A retry issued from a thread view is asking for that thread back, not
    // only for a fresh thread list: a hydration failure leaves the transcript
    // in its error state until the thread is activated again, and nothing else
    // re-activates a tab that is already open.
    retry: async () => {
      const reachable = await loadBootstrap("retry");
      // Fired, not awaited: activation runs the thread's event stream until
      // the thread is left, so its promise settles far after the retry does.
      if (reachable && options.activeThreadId !== undefined) {
        void activateThread(options.activeThreadId);
      }
    },
    conversationHistory,
    sendFollowUp,
    setPendingDraft,
    setPendingDraftCaret,
    writePendingDraftFor,
    startThreadTurn,
    status,
    threadUsage,
    turnActivity,
    turnError,
    turnStatus,
    updateSettings,
  };
}

function conversationFallback(
  status: "waiting" | "completed" | "interrupted" | "failed" | "incomplete",
): string {
  switch (status) {
    case "waiting":
      return "The provider turn is waiting for input or recovery.";
    case "interrupted":
      return "The provider turn was interrupted.";
    case "failed":
      return "The provider turn failed.";
    case "incomplete":
      return "Working…";
    case "completed":
      return "The provider turn finished without a visible reply.";
  }
}

type CodeControllerResult = ReturnType<typeof useCodeController>;
export type CodeController = Omit<CodeControllerResult, "writePendingDraftFor"> & {
  /** Optional for injected fixtures and hosts that do not persist drafts by thread. */
  readonly writePendingDraftFor?: (threadId: string, value: string) => void;
};

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("Code controller requires launch authority.");
  return value;
}

/** Whether a refused bootstrap describes a host that may simply not be up yet. */
function worthAskingAgain(error: unknown): boolean {
  const category = codeFailure(error).category;
  return category === "disconnected" || category === "unavailable";
}

function codeFailure(error: unknown): Pick<CodeFailure, "category" | "message"> {
  if (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof error.category === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { category: error.category as CodeFailure["category"], message: error.message };
  }
  return { category: "disconnected", message: "The local Octant Code service is unavailable." };
}

function replaceById<T extends { readonly id: unknown }>(items: ReadonlyArray<T>, value: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) return [...items, value];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? value : candidate));
}

function applyEvent(current: CodeBootstrap | undefined, frame: CodeEventFrame) {
  return current === undefined ? current : applyResult(current, frame.event);
}

function applyResult(current: CodeBootstrap | undefined, result: CodeCommandResult) {
  if (current === undefined) return current;
  switch (result.kind) {
    case "checkout-prepared":
      return { ...current, checkouts: replaceById(current.checkouts, result.checkout) };
    case "settings-updated":
      return { ...current, settings: result.settings };
    case "thread-created":
    case "thread-updated":
      return { ...current, threads: replaceById(current.threads, result.thread) };
    case "thread-lifecycle-changed":
      return {
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === result.threadId
            ? { ...thread, lifecycle: result.lifecycle, version: result.version }
            : thread,
        ),
      };
    case "worktree-source-previewed":
    case "worktree-remote-facts-retrieved":
      return current;
    case "thread-checkout-rebind":
      return result.outcome.status === "refused"
        ? current
        : {
            ...current,
            threads: replaceById(current.threads, result.outcome.thread),
            checkouts: replaceById(current.checkouts, result.outcome.checkout),
          };
    case "managed-thread-created":
      return {
        ...current,
        threads: replaceById(current.threads, result.thread),
        checkouts: replaceById(current.checkouts, result.checkout),
      };
  }
}

function commandTargets(command: CodeCommand, threadId: CodeThreadId): boolean {
  return "threadId" in command && command.threadId === threadId;
}

function acceptFrame(frame: CodeEventFrame, threadId: CodeThreadId, cursor: number): boolean {
  return frame.threadId === threadId && Number(frame.sequence) === cursor + 1;
}

function isActive(
  request: number,
  generation: { readonly current: number },
  mounted: { readonly current: boolean },
): boolean {
  return mounted.current && request === generation.current;
}

async function readOperationText(
  client: CodeClient,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  contentId: CodeEvidenceContentId,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const bytes = await client.operationContent(threadId, operationId, contentId, signal);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function projectConversationTurns(
  client: CodeClient,
  threadId: CodeThreadId,
  turns: ReadonlyArray<CodeConversationTurn>,
  evidence: ReadonlyMap<string, string> | undefined,
  signal: AbortSignal,
): Promise<{
  readonly messages: ReadonlyArray<CodeConversationMessage>;
  readonly activity: ReadonlyMap<string, CodeTurnActivity>;
}> {
  const messages: CodeConversationMessage[] = [];
  const activity = new Map<string, CodeTurnActivity>();
  for (const turn of turns) {
    if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
    const prompt = await readConversationText(
      client,
      threadId,
      turn.operationId,
      turn.prompt.contentId,
      evidence,
      signal,
    );
    messages.push({
      id: `${turn.operationId}:user`,
      role: "user",
      text: prompt ?? "Conversation prompt evidence is unavailable.",
      operationId: turn.operationId,
      providerInstanceId: turn.providerInstanceId,
      modelId: turn.modelId,
      status: turn.status,
      ...(turn.attachments === undefined || turn.attachments.length === 0
        ? {}
        : { attachments: turn.attachments }),
      ...(turn.checkpoint === undefined ? {} : { checkpoint: turn.checkpoint }),
      ...(turn.executionPolicy === undefined ? {} : { executionPolicy: turn.executionPolicy }),
    });
    const parts: string[] = [];
    for (const reference of turn.assistant) {
      const part = await readConversationText(
        client,
        threadId,
        turn.operationId,
        reference.contentId,
        evidence,
        signal,
      );
      if (part !== undefined) parts.push(part);
    }
    messages.push({
      id: `${turn.operationId}:assistant`,
      role: "assistant",
      text: parts.join("") || conversationFallback(turn.status),
      operationId: turn.operationId,
      providerInstanceId: turn.providerInstanceId,
      modelId: turn.modelId,
      status: turn.status,
    });
    const steps = turn.steps ?? [];
    if (steps.length === 0 && turn.stepsTruncated !== true) continue;
    let replayed = EMPTY_TURN_ACTIVITY;
    for (const step of steps) {
      if (step.kind === "tool") {
        replayed = applyActivityEvent(replayed, {
          kind: "tool-activity",
          toolCallId: step.toolCallId,
          toolName: step.toolName,
          state: step.state,
          ...(step.summary === undefined ? {} : { summary: step.summary }),
        });
        continue;
      }
      const text = await readConversationText(
        client,
        threadId,
        turn.operationId,
        step.content.contentId,
        evidence,
        signal,
      );
      if (text !== undefined) replayed = appendReasoning(replayed, text);
    }
    activity.set(String(turn.operationId), {
      ...replayed,
      ...(turn.stepsTruncated === true ? { truncated: true } : {}),
    });
  }
  return { messages, activity };
}

async function readConversationEvidence(
  client: CodeClient,
  threadId: CodeThreadId,
  turns: ReadonlyArray<CodeConversationTurn>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string> | undefined> {
  const read = client.operationContents;
  if (read === undefined) return undefined;
  const unique = new Map<
    string,
    { readonly operationId: CodeOperationId; readonly contentId: CodeEvidenceContentId }
  >();
  for (const turn of turns) {
    const references = [
      turn.prompt,
      ...turn.assistant,
      ...(turn.steps ?? []).flatMap((step) => (step.kind === "reasoning" ? [step.content] : [])),
    ];
    for (const reference of references) {
      const key = `${String(turn.operationId)}:${String(reference.contentId)}`;
      unique.set(key, { operationId: turn.operationId, contentId: reference.contentId });
    }
  }
  const items = [...unique.values()];
  let responses: ReadonlyArray<Awaited<ReturnType<NonNullable<CodeClient["operationContents"]>>>>;
  try {
    responses = await Promise.all(
      Array.from({ length: Math.ceil(items.length / MAX_CODE_EVIDENCE_BATCH_ITEMS) }, (_, index) =>
        read(
          {
            threadId,
            items: items.slice(
              index * MAX_CODE_EVIDENCE_BATCH_ITEMS,
              (index + 1) * MAX_CODE_EVIDENCE_BATCH_ITEMS,
            ),
          },
          signal,
        ),
      ),
    );
  } catch (error) {
    if (signal.aborted) throw error;
    // A renderer may reconnect to a host from before the batch endpoint was
    // introduced. Preserve transcript recovery through the existing bounded
    // per-reference reads instead of treating that host as corrupt.
    return undefined;
  }
  const text = new Map<string, string>();
  for (const response of responses) {
    if (String(response.threadId) !== String(threadId)) continue;
    for (const item of response.items) {
      text.set(`${String(item.operationId)}:${String(item.contentId)}`, item.text);
    }
  }
  return text;
}

async function readConversationText(
  client: CodeClient,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  contentId: CodeEvidenceContentId,
  evidence: ReadonlyMap<string, string> | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (evidence !== undefined) {
    return evidence.get(`${String(operationId)}:${String(contentId)}`);
  }
  return readOperationText(client, threadId, operationId, contentId, signal);
}

async function waitForReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
