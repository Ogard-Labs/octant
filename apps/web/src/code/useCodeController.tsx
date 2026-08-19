import { createCodeClient, type CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeBootstrap,
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
  type CodeProviderLimit,
  type CodeEvidenceContentId,
  type CodeOperationEvent,
  type CodeOperationId,
  type CodeThreadFollowUpView,
  type CodeAttachmentId,
  type CodeAttachmentReference,
  type MentionableThreadId,
} from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  EMPTY_TURN_ACTIVITY,
  appendReasoning,
  applyActivityEvent,
  type CodeActivityRow,
  type CodeTurnActivity,
} from "./transcriptActivity";
import {
  EMPTY_CODE_TURN_QUEUES,
  enqueueCodeTurn,
  queuedTurnsFor,
  removeQueuedCodeTurn,
  type CodeTurnQueues,
  type QueuedCodeTurn,
} from "./turnQueue";

export type CodeControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";
export type CodeTurnStatus = "idle" | "sending" | "running" | "failed";

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
}

export interface CodeThreadNavigationItem {
  readonly executionPolicy: CodeThread["executionPolicy"];
  readonly lifecycle: CodeThread["lifecycle"];
  readonly projectId: CodeThread["projectId"];
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
   * Session-scoped like Chat's: an unread mark is about this sitting, and
   * carrying it across restarts would resurface work the user already dealt
   * with.
   */
  readonly unread?: boolean;
  /** Whether the user pinned this thread to the top of the list. */
  readonly pinned?: boolean;
}

/**
 * Per-thread record of the activity sequence the user has actually seen.
 *
 * The sequence is the host's, from the bootstrap: a thread's own version cannot
 * stand in for it, because a provider turn is journaled on a different
 * aggregate and moves neither the version nor `updatedAt`.
 *
 * Deliberately in memory and deliberately shaped like Chat's: unread is a
 * property of this sitting at the app, so a durable one would tell the user
 * about work they closed the laptop on last week.
 */
export interface CodeReadCursorStore {
  readonly getSnapshot: () => ReadonlyMap<string, number>;
  readonly mark: (threadId: CodeThreadId, sequence: number) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createCodeReadCursorStore(): CodeReadCursorStore {
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

/**
 * The longest a dropped stream waits before trying the host again. Long enough
 * that a machine asleep for hours is not asking every quarter second, short
 * enough that waking it up catches the thread back up while the user is still
 * looking at it.
 */
const MAX_CODE_RECONNECT_DELAY_MS = 10_000;

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
  readonly readCursorStore?: CodeReadCursorStore;
  /**
   * How often the sidebar re-reads the thread list. Only the thread in view
   * streams its own events, so without this a thread finishing in the
   * background would show no unread mark until something else reloaded.
   */
  readonly navigationRefreshMs?: number;
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
  const [activeView, setActiveView] = useState<CodeThreadView>();
  const [errorCategory, setErrorCategory] = useState<CodeFailure["category"]>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [conversation, setConversation] = useState<ReadonlyArray<CodeConversationMessage>>([]);
  /*
   * Whether the empty transcript means "nothing has been said yet" or "we could
   * not fetch what was said". Both leave `conversation` empty, and only the
   * first one is an invitation to start something.
   */
  const [conversationHistory, setConversationHistory] = useState<"loaded" | "unavailable">(
    "loaded",
  );
  const [followUps, setFollowUps] = useState<ReadonlyMap<string, CodeThreadFollowUpView>>(
    () => new Map(),
  );
  const [turnStatus, setTurnStatus] = useState<CodeTurnStatus>("idle");
  const [turnError, setTurnError] = useState<string>();
  const [providerRequests, setProviderRequests] = useState<ReadonlyArray<CodeProviderRequest>>([]);
  const [turnQueues, setTurnQueues] = useState<CodeTurnQueues>(EMPTY_CODE_TURN_QUEUES);
  const draining = useRef(false);
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
  const activeTurnOperations = useRef(new Map<string, CodeOperationId>());
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
  const pendingDraft = drafts.get(draftKey(options.activeThreadId)) ?? "";
  const setPendingDraft = useCallback((value: string) => {
    const key = draftKey(activeThreadId.current);
    setDrafts((current) => {
      if ((current.get(key) ?? "") === value) return current;
      const next = new Map(current);
      if (value === "") next.delete(key);
      else next.set(key, value);
      return next;
    });
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
          setBootstrap(next);
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
    [clearFailure, client, fail],
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
      readCursorStore.mark(threadId, observedActivity.current.get(String(threadId)) ?? 0);
    },
    [readCursorStore],
  );

  const applyNavigationRefresh = useCallback((next: CodeBootstrap) => {
    setBootstrap((current) =>
      current === undefined ? next : { ...current, threads: next.threads, activity: next.activity },
    );
  }, []);

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
    async (threadId: CodeThreadId) => {
      try {
        const next = await client.bootstrap();
        if (!mounted.current) return;
        applyNavigationRefresh(next);
        const seen = next.activity.find(
          (entry) => String(entry.threadId) === String(threadId),
        )?.lastSequence;
        readCursorStore.mark(threadId, Number(seen ?? 0));
      } catch {
        if (!mounted.current) return;
        markRenderedActivity(threadId);
      }
    },
    [applyNavigationRefresh, client, markRenderedActivity, readCursorStore],
  );

  const installView = useCallback(
    (view: CodeThreadView) => {
      setActiveView(view);
      setBootstrap((current) =>
        current === undefined
          ? current
          : {
              ...current,
              checkouts: replaceById(current.checkouts, view.checkout),
              threads: replaceById(current.threads, view.thread),
            },
      );
      setStatus("ready");
      clearFailure();
    },
    [clearFailure],
  );

  const hydrateConversation = useCallback(
    async (threadId: CodeThreadId, request: number) => {
      let cursor = 0;
      let nextCursor = 0;
      let pageCount = 0;
      const turns: CodeConversationTurn[] = [];
      let pageLimits: ReadonlyArray<CodeProviderLimit> = [];
      let pageRestoreUndo: CodeCheckpoint | undefined;
      for (;;) {
        const page = await client.conversation(threadId, cursor, 50);
        if (!isActive(request, threadGeneration, mounted) || page.threadId !== threadId)
          return undefined;
        turns.push(...page.turns);
        if (page.limits !== undefined) pageLimits = page.limits;
        pageRestoreUndo = page.restoreUndo;
        nextCursor = page.nextCursor;
        if (!page.hasMore) break;
        if (page.nextCursor <= cursor || (pageCount += 1) >= 100) {
          throw new Error("Code conversation pagination did not advance.");
        }
        cursor = page.nextCursor;
      }

      const messages: CodeConversationMessage[] = [];
      const replayedActivity = new Map<string, CodeTurnActivity>();
      for (const turn of turns) {
        const prompt = await readOperationText(
          client,
          threadId,
          turn.operationId,
          turn.prompt.contentId,
        );
        if (!isActive(request, threadGeneration, mounted)) return undefined;
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
        });
        const parts: string[] = [];
        for (const reference of turn.assistant) {
          const part = await readOperationText(
            client,
            threadId,
            turn.operationId,
            reference.contentId,
          );
          if (part !== undefined) parts.push(part);
        }
        if (!isActive(request, threadGeneration, mounted)) return undefined;
        messages.push({
          id: `${turn.operationId}:assistant`,
          role: "assistant",
          text: parts.join("") || conversationFallback(turn.status),
          operationId: turn.operationId,
          providerInstanceId: turn.providerInstanceId,
          modelId: turn.modelId,
          status: turn.status,
        });
        // The steps this turn recorded, folded into the same rows the live
        // transcript builds, so a reopened thread reads like the turn did.
        const steps = turn.steps ?? [];
        if (steps.length > 0 || turn.stepsTruncated === true) {
          const rows: CodeActivityRow[] = [];
          let reasoning = "";
          for (const step of steps) {
            if (step.kind === "tool") {
              rows.push({
                kind: "tool",
                id: String(step.toolCallId),
                toolName: step.toolName,
                state: step.state,
                ...(step.summary === undefined ? {} : { summary: step.summary }),
              });
              continue;
            }
            const text = await readOperationText(
              client,
              threadId,
              turn.operationId,
              step.content.contentId,
            );
            if (text !== undefined) reasoning += text;
          }
          if (!isActive(request, threadGeneration, mounted)) return undefined;
          replayedActivity.set(String(turn.operationId), {
            rows,
            reasoning,
            ...(turn.stepsTruncated === true ? { truncated: true } : {}),
          });
        }
      }
      usageByOperation.current = new Map(
        turns.flatMap((turn) =>
          turn.usage === undefined ? [] : [[String(turn.operationId), turn.usage] as const],
        ),
      );
      setThreadUsage({ ...totalTurnUsage(usageByOperation.current), limits: pageLimits });
      setRestoreUndo(pageRestoreUndo);
      setConversation(messages);
      if (replayedActivity.size > 0) {
        setTurnActivity((current) => new Map([...current, ...replayedActivity]));
      }
      const latestTurn = turns.at(-1);
      const incomplete = latestTurn?.status === "incomplete";
      if (incomplete && latestTurn !== undefined) {
        activeTurnOperations.current.set(String(threadId), latestTurn.operationId);
      } else {
        activeTurnOperations.current.delete(String(threadId));
      }
      setTurnStatus((current) =>
        incomplete
          ? current === "sending"
            ? current
            : "running"
          : current === "running"
            ? "idle"
            : current,
      );
      return {
        incomplete,
        incompleteOperationId: incomplete ? latestTurn?.operationId : undefined,
        nextCursor,
      };
    },
    [client],
  );

  const activateThread = useCallback(
    async (threadId: CodeThreadId) => {
      const request = ++threadGeneration.current;
      streamAbort.current?.abort();
      streamAbort.current = undefined;
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
      setConversationHistory("loaded");
      try {
        const initial = await client.thread(threadId);
        if (!isActive(request, threadGeneration, mounted)) return;
        installView(initial);
        void refreshFollowUp(threadId);
        let conversationCursor = 0;
        let conversationIncomplete = false;
        let conversationOperationId: CodeOperationId | undefined;
        let conversationRendered = false;
        try {
          const hydrated = await hydrateConversation(threadId, request);
          conversationIncomplete = hydrated?.incomplete === true;
          conversationOperationId = hydrated?.incompleteOperationId;
          conversationCursor = hydrated?.nextCursor ?? 0;
          conversationRendered = true;
        } catch {
          if (!isActive(request, threadGeneration, mounted)) return;
          setConversation([]);
          setConversationHistory("unavailable");
          setTurnError("Conversation history could not be loaded.");
        }
        if (!isActive(request, threadGeneration, mounted)) return;
        // The thread's own state and the turns it has recorded are on screen
        // now, so everything the host has journaled for it counts as read. A
        // thread whose history could not be loaded shows an error instead of
        // that work, and is left to keep its mark.
        if (conversationRendered) void recordSeenActivity(threadId);
        let cursor = Number(initial.lastSequence);
        const controller = new AbortController();
        streamAbort.current = controller;
        let operationStream: Promise<void> | undefined;
        const startConversationOperationStream = (operationId: CodeOperationId) => {
          if (operationStream !== undefined) return;
          operationStream = (async () => {
            let operationCursor = 0;
            let assistantText = "";
            while (isActive(request, threadGeneration, mounted) && !controller.signal.aborted) {
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
                    const chunk = await readOperationText(
                      client,
                      threadId,
                      operationId,
                      event.content.contentId,
                    );
                    if (chunk !== undefined) noteReasoning(operationId, chunk);
                  }
                  if (event.kind === "provider-content" && event.channel === "message") {
                    const chunk = await readOperationText(
                      client,
                      threadId,
                      operationId,
                      event.content.contentId,
                    );
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
                    setProviderRequests([]);
                    const hydrated = await hydrateConversation(threadId, request).catch(
                      () => undefined,
                    );
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
                      setTurnStatus("failed");
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
              } catch {
                // The durable conversation poll below remains the recovery
                // path; reconnect from the last fully applied operation frame.
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
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                return;
              try {
                const latest = await client.conversation(
                  threadId,
                  Math.max(0, conversationCursor - 1),
                  1,
                );
                if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                  return;
                if (latest.threadId !== threadId || latest.turns.at(-1)?.status === "incomplete") {
                  delayMs = Math.min(delayMs * 2, 2_000);
                  continue;
                }
                const hydrated = await hydrateConversation(threadId, request);
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
              const recovered = await client.thread(threadId);
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
              const refreshed = await client.thread(threadId);
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                return;
              installView(refreshed);
              void refreshFollowUp(threadId);
              if (conversationPoll === undefined) {
                try {
                  const hydrated = await hydrateConversation(threadId, request);
                  conversationIncomplete = hydrated?.incomplete === true;
                  conversationOperationId = hydrated?.incompleteOperationId;
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
      for (const id of ids) {
        if (!active || !mounted.current) return;
        try {
          const view = await client.readFollowUp(id as CodeThreadId);
          if (!active || !mounted.current) return;
          setFollowUps((current) => {
            const next = new Map(current);
            next.set(id, view);
            return next;
          });
        } catch {
          // A per-thread follow-up read failure is non-fatal to navigation.
        }
      }
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
    setConversationHistory("loaded");
    setProviderRequests([]);
    setTurnActivity(new Map());
    setTurnStatus(
      options.activeThreadId !== undefined &&
        activeTurnOperations.current.has(String(options.activeThreadId))
        ? "running"
        : "idle",
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
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;

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
        .map((thread) => ({
          executionPolicy: thread.executionPolicy,
          lifecycle: thread.lifecycle,
          projectId: thread.projectId,
          threadId: thread.id,
          title: thread.title,
          followUp: followUps.get(String(thread.id))?.followUp?.state === "open",
          unread:
            (activityByThread.get(String(thread.id)) ?? 0) >
            (readCursors.get(String(thread.id)) ?? 0),
          ...(thread.pinned === true ? { pinned: true } : {}),
          updatedAt: thread.updatedAt,
        }))
        // Pinned threads lead, and the order inside each group is the host's.
        // Sorting the whole list by recency instead would move a pinned thread
        // the moment anything else ran, which is the opposite of pinning it.
        .sort((left, right) => Number(right.pinned ?? false) - Number(left.pinned ?? false)),
    [activityByThread, bootstrap, followUps, readCursors],
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
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await client.bootstrap();
          if (cancelled || !mounted.current) return;
          applyNavigationRefresh(next);
        } catch {
          // A refresh that fails leaves the last list on screen; the stream and
          // the retry path are what report a host that has actually gone away.
        }
      })();
    }, navigationRefreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [applyNavigationRefresh, client, navigationRefreshMs]);

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
        activeTurnOperations.current.set(String(input.threadId), operationId);
        setTurnStatus("running");
        return true;
      } catch (error) {
        const failure = codeFailure(error);
        failFirstTurn(failure.message);
        fail(error);
        return false;
      }
    },
    [beginProviderTurn, clearFailure, fail],
  );

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
      let thread: CodeThread;
      try {
        thread = decodeCodeThread({
          ...source,
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
    ): Promise<boolean> => {
      const trimmed = prompt.trim();
      const view = activeView?.thread.id === activeThreadId.current ? activeView : undefined;
      if (trimmed.length === 0 || view === undefined) return false;
      if (turnStatus === "sending" || turnStatus === "running") return false;

      clearFailure();
      setTurnError(undefined);
      setTurnStatus("sending");
      const userMessage: CodeConversationMessage = {
        id: globalThis.crypto.randomUUID(),
        role: "user",
        text: trimmed,
        providerInstanceId: view.thread.providerInstanceId,
        modelId: view.thread.modelId,
        ...(attachments.length === 0 ? {} : { attachments }),
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
          signal: controller.signal,
        });
        if (controller.signal.aborted) return false;
        if (started.kind === "operation-failed") {
          setTurnStatus("failed");
          setTurnError(started.failure.message);
          setPendingDraft(trimmed);
          return false;
        }
        if (started.kind !== "provider-turn-state" || started.state !== "running") {
          setTurnStatus("failed");
          setTurnError("The provider turn could not be started.");
          setPendingDraft(trimmed);
          return false;
        }
        setTurnStatus("running");
        setPendingDraft("");
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
        const failActiveTurn = (status: "waiting" | "interrupted" | "failed", message: string) => {
          setTurnStatus("failed");
          setTurnError(message);
          setPendingDraft(trimmed);
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
            if (event.kind === "conversation-turn-started" && event.checkpoint !== undefined) {
              const checkpoint = event.checkpoint;
              setConversation((current) =>
                current.map((entry) =>
                  entry.id === userMessage.id ? { ...entry, checkpoint } : entry,
                ),
              );
            }
            if (event.kind === "provider-content" && event.channel === "reasoning") {
              const chunk = await readOperationText(
                client,
                view.thread.id,
                operationId,
                event.content.contentId,
              );
              if (chunk !== undefined) noteReasoning(operationId, chunk);
            }
            if (event.kind === "provider-content" && event.channel === "message") {
              const chunk = await readOperationText(
                client,
                view.thread.id,
                operationId,
                event.content.contentId,
              );
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
                  failActiveTurn(
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
                  failActiveTurn(
                    event.result.state,
                    event.result.state === "waiting"
                      ? "The provider turn is waiting for approval, input, or recovery."
                      : `Provider turn ${event.result.state}.`,
                  );
                  return false;
                }
              } else if (event.result.kind === "operation-failed") {
                terminal = true;
                failActiveTurn("failed", event.result.failure.message);
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
        setPendingDraft(trimmed);
        fail(error);
        return false;
      }
    },
    [activeView, beginProviderTurn, clearFailure, client, fail, turnStatus],
  );

  /**
   * Park a follow-up written while a turn is running and send it once that turn
   * settles. Sending immediately is impossible — the host admits one provider
   * turn per thread — so the alternative is making the user wait at the
   * keyboard and remember to press send.
   */
  const queueFollowUp = useCallback(
    (
      prompt: string,
      threadMentionIds: ReadonlyArray<MentionableThreadId> = [],
      attachments: ReadonlyArray<CodeAttachmentReference> = [],
    ): QueuedCodeTurn | undefined => {
      const trimmed = prompt.trim();
      const threadId = activeThreadId.current;
      if (trimmed.length === 0 || threadId === undefined) return undefined;
      const turn: QueuedCodeTurn = {
        id: globalThis.crypto.randomUUID(),
        prompt: trimmed,
        threadMentionIds,
        attachments,
      };
      setTurnQueues((current) => enqueueCodeTurn(current, String(threadId), turn));
      return turn;
    },
    [],
  );

  const cancelQueuedFollowUp = useCallback((turnId: string): void => {
    const threadId = activeThreadId.current;
    if (threadId === undefined) return;
    setTurnQueues((current) => removeQueuedCodeTurn(current, String(threadId), turnId));
  }, []);

  const queuedFollowUps = useMemo(
    () =>
      options.activeThreadId === undefined
        ? []
        : queuedTurnsFor(turnQueues, String(options.activeThreadId)),
    [options.activeThreadId, turnQueues],
  );

  // A settled turn releases the next queued follow-up. A failed turn keeps the
  // queue parked: the user decides whether the rest still applies.
  useEffect(() => {
    if (turnStatus !== "idle") return;
    const threadId = options.activeThreadId;
    if (threadId === undefined) return;
    const next = queuedTurnsFor(turnQueues, String(threadId))[0];
    if (next === undefined || draining.current) return;
    draining.current = true;
    void (async () => {
      try {
        const sent = await sendFollowUp(next.prompt, next.threadMentionIds, next.attachments);
        if (!mounted.current || !sent) return;
        setTurnQueues((current) => removeQueuedCodeTurn(current, String(threadId), next.id));
      } finally {
        draining.current = false;
      }
    })();
  }, [options.activeThreadId, sendFollowUp, turnQueues, turnStatus]);

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
    cancelQueuedFollowUp,
    queueFollowUp,
    queuedFollowUps,
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
    navigation,
    pendingDraft,
    pinThread,
    renameThread,
    providerRequests,
    refreshFollowUp,
    restoreUndo,
    noteRestoreUndo,
    retry: () => loadBootstrap("retry"),
    conversationHistory,
    sendFollowUp,
    setPendingDraft,
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

export type CodeController = ReturnType<typeof useCodeController>;

/** Draft bucket for one thread, or for the composer before a thread exists. */
function draftKey(threadId: CodeThreadId | undefined): string {
  return threadId === undefined ? "" : String(threadId);
}

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
): Promise<string | undefined> {
  try {
    const bytes = await client.operationContent(threadId, operationId, contentId);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
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
