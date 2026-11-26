import {
  noteTypedComposerText,
  threadDraftScope,
  typedClaimFor,
} from "@octant/client-runtime/typed-composer-text";
import { createEditorDraftStore } from "../editor/editorDraftStore";
import type { ConversationInputPolicy } from "@octant/contracts/conversation-inputs";
import type {
  CodePullRequestLineNotesSource,
  CodeReviewFindingReference,
  CoordinatorBounds,
  CoordinatorDoneWhen,
  CoordinatorOpenWorkerLimit,
  CoordinatorStartingByProject,
  CoordinatorStartingChoice,
  CoordinatorWorkerChoice,
  CoordinatorWorkerListing,
  CoordinatorWorkerListingByProject,
  CoordinatorWorkerLevel,
  CodeWorktreeCreationProgress,
  SideChatDraftReturnReference,
  WindowsTerminalShell,
} from "@octant/contracts";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { ProjectId } from "@octant/contracts/projects";
import type { AutoReviewer, ShieldModelChoice } from "@octant/contracts/shield";
import {
  CodeClientFailure,
  CodeClientSnapshotRequiredError,
  createCodeClient,
  type CodeClient,
} from "@octant/client-runtime/code-client";
import type {
  CodeBootstrap,
  CodeNavigation,
  CodeCommand,
  CodeCommandResult,
  CodeFailure,
  CodeCheckoutId,
  CodeExternalEditor,
  CodeThread,
  CodeThreadId,
  CodeThreadView,
  CodeWorktreeSettings,
} from "@octant/contracts/code";
import { decodeCodeThreadId } from "@octant/contracts/code";
import {
  decodeUtcTimestamp,
  type CodeConversationUsageTotals,
  type CodeConversationWindow,
  type ProviderContextBreakdown,
} from "@octant/contracts";
import type { CodeLineNotesSendResult } from "./CodeLineNotes";
import { prependEarlierTurns } from "@octant/domain";
import { waitForReconnect } from "../lib/waitForReconnect";
import {
  decodeCodeOperationId,
  decodeProviderSessionId,
  type CodeApprovalId,
  type CodeCheckpoint,
  type CodeConversationTurn,
  type CodeProviderLimit,
  type CodeOperationEvent,
  type CodeEvidenceContentId,
  type CodeOperationFailure,
  type CodeOperationId,
  type CodeThreadCheckoutRebindOutcome,
  type CodeForkMergeBackOutcome,
  type CodeThreadFollowUpView,
  type CodeAttachmentId,
  type CodeAttachmentReference,
  type MentionableThreadId,
  type ProviderExecutionPolicy,
  type ProviderUsageLimit,
  ThreadBoardPullRequestSummaries,
  type ThreadBoardPullRequestIdentity,
  ThreadTouchedIssues,
  type ThreadLiveStep,
} from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRetainedRecord } from "../polling/useRetainedRecord";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import type { ComposerThreadDraftStore } from "../composer/composerThreadDraftStore";
import { applyActivityEvent, forgetWrittenPath } from "./transcriptActivity";
import { EMPTY_TURN_ACTIVITY, type TurnActivity } from "../transcript/turnActivity";
import { samePollingData } from "../polling/samePollingData";
import {
  documentIsVisible,
  scheduleVisibleInterval,
  waitUntilDocumentVisible,
} from "../polling/documentVisibility";
import { markInteraction } from "../polling/interactionTrace";
import {
  framePosition,
  holdSteeredMessages,
  keepStreamedTurn,
  withSteeredMessages,
  applyEvent,
  applyResult,
  commandReloadsThread,
  withUpdatedThread,
  codeFailure,
  createCodeReadCursorStore,
  isActive,
  projectConversationTurns,
  codeReplyMetadataUpdate,
  providerAnswerOutcome,
  providerRequestFromEvent,
  readConversationEvidence,
  readOperationText,
  refreshActiveThreadView,
  replaceById,
  totalTurnUsage,
  worthAskingAgain,
} from "./codeControllerState";
import type {
  CodeCacheCoverage,
  CodeConversationMessage,
  CodeProviderRequest,
  CodeReadCursorStore,
  CodeSteeredMessages,
  CodeTurnUsage,
} from "./codeControllerState";
import {
  CODE_CONVERSATION_PAGE_TURNS,
  MAX_CODE_FORK_LINEAGE,
  NO_EARLIER_CONVERSATION,
  earlierRowState,
  joinNewestWindow,
  loadedTurnUsage,
  nextEarlierRead,
  oldestOwnOperation,
  type CodeEarlierConversation,
  type CodeInheritedCursor,
} from "./codeConversationWindow";
import {
  archiveCodeThread,
  completeCodeThread,
  moveCodeThread,
  findCodeThread,
  pinCodeThread,
  renameCodeThread,
  markCodeThreadDone,
  unlinkCodeThreadPullRequest,
  reopenCodeThread,
  setCodeThreadCoordinator,
  setCodeThreadCoordinatorBounds,
  setCodeThreadCoordinatorDoneWhen,
  setCodeThreadCoordinatorWake,
  setCodeThreadMessageWake,
  setCodeThreadRestartContinuation,
  snoozeCodeThread,
  wakeCodeThread,
} from "./codeThreadCommands";

export type { CodeConversationMessage, CodeProviderRequest, CodeReadCursorStore };
export { createCodeReadCursorStore };

export type CodeControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";
export type CodeTurnStatus = "idle" | "sending" | "running" | "waiting" | "interrupted" | "failed";

/** What completing, reopening, snoozing, or waking a thread answered. */
export type CodeThreadRestOutcome =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly message: string };

/**
 * A move's answer: the rest outcome, a queued intent dropped by its own
 * Cancel before it ever dispatched, or a queued intent whose real dispatch
 * answer arrives later on `settled`.
 */
export type CodeThreadMoveOutcome =
  | CodeThreadRestOutcome
  | { readonly status: "cancelled" }
  | {
      readonly status: "deferred";
      readonly settled: Promise<CodeThreadMoveOutcome>;
      readonly cancel: () => void;
    };

/** One queued move intent: the thread, the destination, the turn it waits for, and its answer. */
interface PendingThreadMove {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
  readonly sourceTurnStartedAt?: string | undefined;
  readonly resolve: (outcome: CodeThreadMoveOutcome) => void;
}

/**
 * A question the running provider turn asked the user and is blocked on:
 * either a yes/no approval for a tool it wants to run, or free-form input.
 * The host mints these from the provider stream; the renderer only relays
 * the user's answer back through `answer-provider-*` operations.
 */
export type CodeProviderAnswer =
  | {
      readonly kind: "approval";
      readonly approvalId: CodeApprovalId;
      readonly decision: "approved" | "denied";
      /** With `approved`, on an ask that offered it: "Remember for this Project". */
      readonly rememberForProject?: true;
    }
  | {
      readonly kind: "input";
      readonly requestId: string;
      readonly response: string;
      /** A secret question's answer, sent in the command and never put as evidence. */
      readonly secret?: true;
    };

export interface CodeThreadNavigationItem {
  readonly checkoutChip?: {
    readonly checkoutKind: "existing-worktree" | "managed-worktree";
    readonly label: string;
  };
  /** Exact linked pull requests joined by the host; absent when it has none. */
  readonly pullRequestSummaries?: ThreadBoardPullRequestSummaries;
  /** The issues the thread's tool calls wrote to; absent when it has none. */
  readonly touchedIssues?: ThreadTouchedIssues;
  readonly executing?: boolean;
  /** An approval or a question waits on the person; the thread is parked, not working. */
  readonly awaitingInput?: boolean;
  /** What the person is asked. Absent from an older host, which only reported an approval. */
  readonly awaitingKind?: "approval" | "user-input";
  /** When the running turn began and its latest step; absent outside a live turn. */
  readonly turnStartedAt?: string;
  readonly liveStep?: ThreadLiveStep;
  readonly executionPolicy: CodeThread["executionPolicy"];
  readonly lifecycle: CodeThread["lifecycle"];
  readonly projectId: CodeThread["projectId"];
  readonly providerInstanceId: CodeThread["providerInstanceId"];
  readonly modelId?: string;
  readonly createdAt?: string;
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
  /** When the person completed the thread; absent while it is in play. */
  readonly completedAt?: NonNullable<CodeThread["completedAt"]>;
  /** The host's record of the thread's snooze; absent while it is awake. */
  readonly snooze?: NonNullable<CodeThread["snooze"]>;
  /** A person marked the thread Done as their own override. */
  readonly markedDone?: true;
  /**
   * The visible thread this one was forked from. Absent when the thread
   * started on its own.
   */
  readonly lineageParentThreadId?: string;
  /** Present on a coordinator thread (docs/design/coordinator-threads.md). */
  readonly coordinator?: true;
  /**
   * The thread is its Project's designated planner, which reads as a
   * coordinator whose starts always need approval. Its role follows the
   * designation, so Make coordinator and Stop coordinating are not offered.
   */
  readonly planner?: true;
  /** The coordinator that started this worker; the host records it at creation. */
  readonly coordinatorThreadId?: CodeThreadId;
  /** How the host chose a worker's model from the roles. */
  readonly coordinatorChoice?: CoordinatorWorkerChoice;
  /** The thread's Wake when a message arrives switch is on. */
  readonly messageWake?: true;
  /** A person turned off this worker's Wake for coordinator. */
  readonly coordinatorWakeOff?: true;
  /** A person turned off Continue after restart for this thread. */
  readonly restartContinuationOff?: true;
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
const HISTORY_UNREFRESHED_MESSAGE = "Conversation history could not be refreshed.";
const INHERITED_HISTORY_UNAVAILABLE_MESSAGE = "Inherited conversation history could not be loaded.";

/** The first wait after a failed catch-up, before the delay starts doubling. */
const MIN_CODE_RECONNECT_BACKOFF_MS = 100;
/**
 * A client that reads thread events without waiting (a paired computer reached
 * through a bounded request channel) reads again at the pace the phone uses:
 * soon after a read that brought frames, slower while nothing changes.
 */
const POLLED_THREAD_EVENTS_ACTIVE_MS = 750;
const POLLED_THREAD_EVENTS_IDLE_MAX_MS = 3_000;

/**
 * A streamed reply commits its text and reasoning to conversation state on
 * beats, not per chunk: every commit re-renders the workspace, and a reply's
 * chunks arrive far faster than a frame paints. The accumulated text stays
 * current in the stream loop, so the beat only decides when the state next
 * sees it. `flush` commits what arrived on an exit, `settle` drops a beat
 * whose truth a reload supersedes.
 */
const STREAM_REPLY_BEAT_MS = 50;

function createReplyBeat(commit: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    schedule: () => {
      if (settled || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        commit();
      }, STREAM_REPLY_BEAT_MS);
    },
    /** Re-arms a flushed beat: a replayed stream commits on beats again. */
    reset: () => {
      settled = false;
    },
    flush: () => {
      if (settled) return;
      settled = true;
      clear();
      commit();
    },
  };
}

/**
 * What a Code thread has consumed, and the provider usage windows it last
 * heard about. Every figure comes from the provider: a provider that reports
 * no cost leaves `costUsd` absent rather than showing a derived number.
 */
export interface CodeThreadUsage {
  readonly cacheCoverage?: CodeCacheCoverage;
  readonly inputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;

  readonly outputTokens?: number;
  readonly costUsd?: number;
  /** The model's window and its fill after the latest turn that named them. */
  readonly contextWindow?: number;
  readonly contextTokens?: number;
  /** Where the runtime compacts by itself, from the latest turn that said so. */
  readonly autoCompactThreshold?: number;
  /** What the window held, from the latest turn that reported or counted it. */
  readonly contextBreakdown?: ProviderContextBreakdown;
  readonly limits: ReadonlyArray<CodeProviderLimit>;
}

const EMPTY_THREAD_USAGE: CodeThreadUsage = { limits: [] };

/** A navigation read's planner list replaces the bootstrap's; an older host's absent list clears it. */
function withNavigationPlanners(current: CodeBootstrap, next: CodeNavigation): CodeBootstrap {
  const { plannerThreadIds: _previous, ...rest } = current;
  return next.plannerThreadIds === undefined
    ? rest
    : { ...rest, plannerThreadIds: next.plannerThreadIds };
}

/**
 * The usage object already held while a re-read changed none of its figures,
 * so the shell surfaces reading it (the dock overview, the context meter) can
 * bail out instead of redrawing on every event of a streaming turn.
 */
function retainThreadUsage(current: CodeThreadUsage, next: CodeThreadUsage): CodeThreadUsage {
  return samePollingData(current, next) ? current : next;
}

/**
 * Clients whose host answered 404 for the conversation window: an older host
 * that only has the forward read. Asked once per client, then the thread is
 * read whole as before and shown as fully loaded.
 */
const clientsWithoutConversationWindow = new WeakSet<CodeClient>();

function readsConversationWindow(
  client: CodeClient,
): client is CodeClient & Required<Pick<CodeClient, "conversationWindow">> {
  return (
    typeof client.conversationWindow === "function" && !clientsWithoutConversationWindow.has(client)
  );
}

/** How long an open view waits to look again after a look for a turn failed. */
const FAILED_LOOK_RETRY_MS = 5_000;

/**
 * How far a thread's activity has reached in the thread list, and whether the
 * list says it is working; undefined for a thread the list reports neither
 * for. A turn moves the number, even one that started and ended between two
 * reads of the list.
 */
function threadListActivity(
  bootstrap: CodeBootstrap | undefined,
  threadId: CodeThreadId,
): { readonly sequence: number; readonly working: boolean } | undefined {
  const key = String(threadId);
  const working = (bootstrap?.runtime ?? []).some(
    (entry) => String(entry.threadId) === key && entry.executing,
  );
  const activity = (bootstrap?.activity ?? []).find((entry) => String(entry.threadId) === key);
  if (!working && activity === undefined) return undefined;
  return { sequence: Number(activity?.lastSequence ?? 0), working };
}

/**
 * The transcript a thread's controller held when its thread left the window,
 * with what a later read needs to join its newest turns onto it. Text and
 * figures only: no turn status, pending request, draft, stream or poll.
 */
export interface CodeKeptThread {
  readonly client: CodeClient;
  readonly view: CodeThreadView;
  readonly conversation: ReadonlyArray<CodeConversationMessage>;
  readonly inheritedConversation: ReadonlyArray<CodeConversationMessage>;
  readonly earlierConversation: CodeEarlierConversation;
  readonly forkedFrom: CodeThread["forkedFrom"];
  readonly turnActivity: ReadonlyMap<string, TurnActivity>;
  readonly threadUsage: CodeThreadUsage;
  readonly usageByOperation: ReadonlyMap<string, CodeTurnUsage>;
  readonly earlierUsage: CodeConversationUsageTotals | undefined;
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
export interface CodeControllerOptions {
  readonly activeThreadId?: CodeThreadId;
  /**
   * What this thread showed when the window last left it, read once on mount.
   * It is drawn until the journal answers the read every open starts; nothing
   * treats it as the thread's current state before that.
   */
  readonly kept?: CodeKeptThread | undefined;
  /** Window-owned metadata; a thread slot waits for it instead of bootstrapping. */
  readonly navigation?: { readonly bootstrap: CodeBootstrap | undefined };
  readonly client?: CodeClient;
  readonly draftStore?: ComposerThreadDraftStore;
  readonly readCursorStore?: CodeReadCursorStore;
  /**
   * How often the sidebar re-reads the thread list. Only the thread in view
   * streams its own events, so without this a thread finishing in the
   * background would show no unread mark until something else reloaded.
   */
  readonly navigationRefreshMs?: number;
  /**
   * How often the open thread's cleanup standing is read again, on the
   * navigation refresh. Cleanup and restore write no journal event, so no
   * stream tells an open thread that its worktree folder was removed or
   * brought back.
   */
  readonly worktreeStandingRefreshMs?: number;
  readonly changeRevision?: number;
  /**
   * Moves when a message queue on this host changes. A message the runtime
   * takes into a running turn leaves the queue then, and the turn's own
   * stream carries nothing for it.
   */
  readonly messageQueueRevision?: number | undefined;
  readonly reconnectDelayMs?: number;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export function useCodeController(options: CodeControllerOptions) {
  const ownsNavigation = options.navigation === undefined;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  const navigationRefreshMs = options.navigationRefreshMs ?? 2_000;
  const worktreeStandingRefreshMs = options.worktreeStandingRefreshMs ?? 30_000;
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
  const [kept] = useState(() =>
    options.kept !== undefined &&
    options.kept.client === client &&
    String(options.kept.view.thread.id) === String(options.activeThreadId)
      ? options.kept
      : undefined,
  );
  // True while the transcript held is the kept one, or one read onto it.
  const keptTranscript = useRef(kept !== undefined);
  const [status, setStatus] = useState<CodeControllerStatus>("loading");
  const [bootstrap, setBootstrap] = useState<CodeBootstrap>();
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;
  const [activeView, setActiveView] = useState<CodeThreadView | undefined>(kept?.view);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const lastStandingRead = useRef(0);
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

  const reconcileDrafts = useCallback(
    (threadIds: ReadonlyArray<string>) => {
      if (!ownsNavigation) return;
      if (knownDraftThreads.current === undefined) {
        composerDraftRef.current.dropUnknown(threadIds);
      } else {
        for (const threadId of knownDraftThreads.current) {
          if (!threadIds.includes(threadId)) composerDraftRef.current.purge(threadId);
        }
      }
      knownDraftThreads.current = new Set(threadIds);
    },
    [ownsNavigation],
  );
  const [conversation, setConversation] = useState<ReadonlyArray<CodeConversationMessage>>(
    kept?.conversation ?? [],
  );
  // The transcript as last set, and whose it is, for the window reads that
  // join a page onto it. A render keeps it level with live updates.
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const conversationThreadKey = useRef<string | undefined>(
    kept === undefined ? undefined : String(kept.view.thread.id),
  );
  // The turn this window's own send streams, which no other path may stream
  // and no read of the conversation may replace.
  const sentTurnStreaming = useRef<string | undefined>(undefined);
  const showConversation = useCallback(
    (threadId: CodeThreadId, messages: ReadonlyArray<CodeConversationMessage>) => {
      const streamed = sentTurnStreaming.current;
      conversationRef.current = keepStreamedTurn(messages, conversationRef.current, streamed);
      conversationThreadKey.current = String(threadId);
      setConversation((current) => keepStreamedTurn(messages, current, streamed));
    },
    [],
  );
  // The whole-history fallback's inherited turns, read before the thread's own.
  const inheritedConversation = useRef<ReadonlyArray<CodeConversationMessage>>(
    kept?.inheritedConversation ?? [],
  );
  /*
   * What the open thread holds beyond its newest page: whether its own turns
   * go on, and where a fork's inherited history continues. Mirrored in a ref
   * for the page reads, which run outside render.
   */
  const [earlierConversation, setEarlierConversationState] = useState<CodeEarlierConversation>(
    kept?.earlierConversation ?? NO_EARLIER_CONVERSATION,
  );
  const earlierConversationRef = useRef(earlierConversation);
  const setEarlierConversation = useCallback(
    (update: (current: CodeEarlierConversation) => CodeEarlierConversation) => {
      const next = update(earlierConversationRef.current);
      earlierConversationRef.current = next;
      setEarlierConversationState(next);
    },
    [],
  );
  const forkedFrom = useRef<CodeThread["forkedFrom"]>(kept?.forkedFrom);
  const earlierAbort = useRef<AbortController | undefined>(undefined);
  /*
   * Whether an empty transcript is still loading, authoritatively empty, or
   * unavailable. Only the loaded state is an invitation to start something.
   */
  const [conversationHistory, setConversationHistory] = useState<
    "loading" | "loaded" | "unavailable"
  >("loading");
  // How the last read of the transcript ended, read by an activation: each
  // sets the state to loading first, and one may start while another reads.
  const settledHistory = useRef(conversationHistory);
  if (conversationHistory !== "loading") settledHistory.current = conversationHistory;
  const [followUps, setFollowUps] = useState<ReadonlyMap<string, CodeThreadFollowUpView>>(
    () => new Map(),
  );
  const [turnStatus, setTurnStatus] = useState<CodeTurnStatus>("idle");
  // Read by the follow of a turn started elsewhere: a turn this window is
  // still sending gets its own stream once the host accepts it.
  const turnStatusNow = useRef(turnStatus);
  turnStatusNow.current = turnStatus;
  const [turnError, setTurnErrorMessage] = useState<string>();
  // The provider's own usage-limit signal for the turn `turnError` speaks
  // about. Kept separate so arbitrary failure text can never grow a
  // countdown; only a contract fact the host journaled can.
  const [turnUsageLimit, setTurnUsageLimit] = useState<ProviderUsageLimit>();
  // The category of the failure `turnError` carries, when the host stated
  // one. A refused resume parks the turn as `stale`, and the transcript's
  // recovery keys on that journaled fact instead of guessing from what the
  // failure did not come with.
  const [turnErrorCategory, setTurnErrorCategory] = useState<CodeOperationFailure["category"]>();
  // The conversation-tail provider turn's operationId, kept beside
  // `turnUsageLimit`: a resume opt-in names exactly this operation.
  const [latestProviderTurnOperationId, setLatestProviderTurnOperationId] =
    useState<CodeOperationId>();
  /**
   * Whether the current failure already reads in the transcript. A turn the
   * host projected as failed carries its reason in its own assistant row; a
   * send the host refused before any turn existed adds no row at all, so the
   * callout above the transcript is the only place its reason is ever seen.
   */
  const [turnErrorInTranscript, setTurnErrorInTranscript] = useState(false);
  const setTurnError = useCallback(
    (
      next: string | undefined | ((current: string | undefined) => string | undefined),
      options?: {
        readonly inTranscript?: boolean;
        /** The host's stated category for this failure, when it carried one. */
        readonly category?: CodeOperationFailure["category"];
      },
    ) => {
      setTurnErrorMessage(next);
      // An updater revises whichever failure is already showing, so it keeps
      // that failure's provenance; a plain message is a new failure and is not
      // in the transcript unless its caller says so.
      if (typeof next !== "function") {
        setTurnErrorInTranscript(options?.inTranscript === true);
        setTurnErrorCategory(options?.category);
      }
    },
    [],
  );
  const [providerRequests, setProviderRequests] = useState<ReadonlyArray<CodeProviderRequest>>([]);
  // Why the host refused the last answer, and to which request. A waiting
  // turn's own reason is the generic waiting sentence, so this is the only
  // place the refusal can be told while the request stays on screen. It is
  // told only while that request is still listed: a later turn's request must
  // not inherit an earlier refusal.
  const [refusedAnswer, setRefusedAnswer] = useState<{
    readonly requestKey: string;
    readonly message: string;
  }>();
  const providerAnswerRefusal =
    refusedAnswer !== undefined &&
    providerRequests.some((request) => providerRequestKey(request) === refusedAnswer.requestKey)
      ? refusedAnswer.message
      : undefined;

  /**
   * Put a refusal this controller did not perform in front of the person.
   *
   * A thread created from a draft starts its first turn on the window's create
   * controller, so the refusal has to be handed to the controller that renders
   * the open thread. It lands exactly where a refused steered send lands: the
   * turn callout above the composer.
   */
  const showTurnRefusal = useCallback(
    (message: string) => {
      setTurnStatus("failed");
      setTurnError(message);
    },
    [setTurnError],
  );

  /**
   * The prompt a newly created thread is about to run.
   *
   * The window opens a new thread before starting its first turn, and that turn
   * runs on the window's create controller. This controller therefore reads an
   * honestly empty journal first and re-reads it once the turn is durable. In
   * between it painted the empty-thread copy and the project setup offers, then
   * a loading notice, then the message: four screens in half a second. Holding
   * the prompt lets the transcript show the person's own message throughout.
   * It is never cleared on activation, because React's development re-mount
   * re-runs activation after the prompt has already been delivered.
   */
  const [firstPromptInFlight, setFirstPromptInFlight] = useState<string>();
  const announceFirstPrompt = useCallback(
    (prompt: string | undefined) => setFirstPromptInFlight(prompt),
    [],
  );
  const conversationStarted = conversation.length > 0;
  useEffect(() => {
    // The journal speaks for the thread from its first message on.
    if (conversationStarted) setFirstPromptInFlight(undefined);
  }, [conversationStarted]);

  const noteProviderRequest = useCallback(
    (
      event: CodeOperationEvent,
      readText?: (contentId: CodeEvidenceContentId) => Promise<string | undefined>,
    ) => {
      // A replay of the turn's stream carries every ask from its start; the
      // host's record of the answer is what withdraws one already answered.
      if (event.kind === "owner-approval-settled" || event.kind === "approval-answered") {
        setProviderRequests((current) =>
          current.filter(
            (request) =>
              request.kind !== "approval" ||
              String(request.approvalId) !== String(event.approvalId),
          ),
        );
        return;
      }
      const request = providerRequestFromEvent(event);
      if (request === undefined) return;
      setProviderRequests((current) => [...current, request]);
      // The plan an agent asks the person to approve is read once and put on
      // its card; a plan that cannot be read leaves the card with its summary.
      const planContentId =
        request.kind === "approval" ? request.levelChange?.planContentId : undefined;
      if (planContentId === undefined || readText === undefined || request.kind !== "approval")
        return;
      void readText(planContentId).then((plan) => {
        if (plan === undefined) return;
        setProviderRequests((current) =>
          current.map((candidate) =>
            candidate.kind === "approval" &&
            String(candidate.approvalId) === String(request.approvalId) &&
            candidate.levelChange !== undefined
              ? { ...candidate, levelChange: { ...candidate.levelChange, plan } }
              : candidate,
          ),
        );
      });
    },
    [],
  );
  const [turnActivity, setTurnActivity] = useState<ReadonlyMap<string, TurnActivity>>(
    () => kept?.turnActivity ?? new Map(),
  );
  /** A read's tool and reasoning rows, leaving those the own send streams as they are. */
  const takeReadActivity = useCallback((read: ReadonlyMap<string, TurnActivity>) => {
    if (read.size === 0) return;
    const streamed = sentTurnStreaming.current;
    setTurnActivity(
      (current) =>
        new Map([
          ...current,
          ...[...read].filter(
            ([operationId]) => operationId !== streamed || !current.has(operationId),
          ),
        ]),
    );
  }, []);
  // What this thread has consumed and how much of the provider's usage windows
  // is left. Both are the provider's own figures; nothing here is derived from
  // a price list or a limit Octant assumed.
  const [threadUsage, setThreadUsage] = useState<CodeThreadUsage>(
    kept?.threadUsage ?? EMPTY_THREAD_USAGE,
  );
  const [accessNotice, setAccessNotice] = useState<string>();
  // The way back from this thread's last restore, as the host recorded it. It
  // lives here rather than in the surface that ran the restore because that
  // surface is unmounted the moment the user opens another tab, and the only
  // copy of the state the restore overwrote would go with it.
  //
  // It is bound to the checkout the open thread was on when it was read or
  // made, and offered only while the thread is still on that checkout: a
  // thread rebound to another checkout keeps its transcript through a read
  // that fails, and the old checkout's way back, sent to the new one, would
  // overwrite files nobody asked about. The host's page does not say which
  // checkout its restore point belongs to, so the binding is the renderer's.
  const [restorePoint, setRestorePoint] = useState<{
    readonly checkoutId: string | undefined;
    readonly checkpoint: CodeCheckpoint;
  }>();
  // The checkout of the thread view last installed for the open thread; none
  // until the first is installed, and a point read before then binds to it.
  const installedCheckout = useRef<string | undefined>(undefined);
  /**
   * Carry what a restore just replaced, so the offer appears without waiting
   * for the thread to be reopened. The host has already recorded it; this only
   * keeps the renderer level with the journal it will read back next time.
   */
  const noteRestoreUndo = useCallback((checkpoint: CodeCheckpoint | undefined) => {
    setRestorePoint(checkpoint && { checkoutId: installedCheckout.current, checkpoint });
  }, []);
  const setRestoreUndo = noteRestoreUndo;
  const [keptUsage] = useState(() => new Map<string, CodeTurnUsage>(kept?.usageByOperation));
  const usageByOperation = useRef(keptUsage);
  // The host's fold of every own turn older than the oldest loaded one.
  const earlierUsage = useRef<CodeConversationUsageTotals | undefined>(kept?.earlierUsage);
  const noteUsage = useCallback((operationId: CodeOperationId, event: CodeOperationEvent) => {
    if (event.kind === "usage") {
      const {
        inputTokens,
        outputTokens,
        costUsd,
        contextWindow,
        contextTokens,
        autoCompactThreshold,
        contextBreakdown,
        cacheReadInputTokens,
        cacheWriteInputTokens,
      } = event;
      usageByOperation.current.set(String(operationId), {
        inputTokens,
        outputTokens,
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
        ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),

        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(contextTokens === undefined ? {} : { contextTokens }),
        ...(autoCompactThreshold === undefined ? {} : { autoCompactThreshold }),
        ...(contextBreakdown === undefined ? {} : { contextBreakdown }),
      });
      setThreadUsage((current) => ({
        ...totalTurnUsage(usageByOperation.current, earlierUsage.current),
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
      // A deletion answers for the whole thread: the turn that removes a file
      // is rarely the turn that wrote it, so the path leaves every turn's
      // written paths rather than only the one that reported the change.
      if (event.kind === "file-change" && event.change === "deleted") {
        const path = String(event.path);
        const updated = new Map(current);
        updated.set(key, next);
        let changed = next !== existing;
        for (const [turn, activity] of updated) {
          const forgotten = forgetWrittenPath(activity, path);
          if (forgotten === activity) continue;
          updated.set(turn, forgotten);
          changed = true;
        }
        return changed ? updated : current;
      }
      if (next === existing) return current;
      const updated = new Map(current);
      updated.set(key, next);
      return updated;
    });
  }, []);
  /**
   * A turn's reasoning as its stream has shown it from the turn's start. A read
   * of the thread can land before the stream commits a chunk it holds, and
   * already carry that chunk; set rather than appended, the chunk shows once. A
   * read that holds this text and more is the newer, so it stays.
   */
  const noteReasoning = useCallback((operationId: CodeOperationId, streamed: string) => {
    setTurnActivity((current) => {
      const key = String(operationId);
      const existing = current.get(key) ?? EMPTY_TURN_ACTIVITY;
      if (existing.reasoning.startsWith(streamed)) return current;
      const updated = new Map(current);
      updated.set(key, { ...existing, reasoning: streamed });
      return updated;
    });
  }, []);
  const firstTurnFailures = useRef(
    new Map<string, Readonly<{ prompt: string; message: string }>>(),
  );
  const activeTurnOperations = useRef(
    new Map<
      string,
      { readonly operationId: CodeOperationId; readonly status: "running" | "waiting" }
    >(),
  );
  /**
   * The open thread's way to take up a turn it has not seen start, given the
   * thread's activity sequence. Set once the activation's own first read is
   * in, so it never races that read.
   */
  const followTurnStartedElsewhere = useRef<
    ((activity: number, working: boolean) => void) | undefined
  >(undefined);
  // Held apart from the transcript, which the turn's stream is writing: a read
  // for these takes nothing else from the host's copy of the turn, and a
  // slower read of the conversation cannot take one of these away.
  const [steeredMessages, setSteeredMessages] = useState<CodeSteeredMessages>(new Map());
  const noteSteeredMessages = useCallback((turns: ReadonlyArray<CodeConversationTurn>) => {
    setSteeredMessages((held) => holdSteeredMessages(held, turns));
  }, []);
  /** Read what the person sent into the open thread's running turn, if one runs. */
  const readSteeredMessages = useCallback(async () => {
    const threadId = activeThreadId.current;
    const request = threadGeneration.current;
    if (
      threadId === undefined ||
      !activeTurnOperations.current.has(String(threadId)) ||
      !readsConversationWindow(client)
    )
      return;
    try {
      // Two, because the turn after the one that took it may already run.
      const window = await client.conversationWindow(threadId, { limit: 2 });
      if (isActive(request, threadGeneration, mounted)) noteSteeredMessages(window.turns);
    } catch {
      // The next queue change, or the turn's own end, reads them.
    }
  }, [client, noteSteeredMessages]);
  const readQueueRevision = useRef(options.messageQueueRevision);
  useEffect(() => {
    if (readQueueRevision.current === options.messageQueueRevision) return;
    readQueueRevision.current = options.messageQueueRevision;
    void readSteeredMessages();
  }, [options.messageQueueRevision, readSteeredMessages]);
  const turnAbort = useRef<AbortController | undefined>(undefined);
  const editorDrafts = useMemo(
    () => createEditorDraftStore(options.serverUrl ?? "local"),
    [options.serverUrl],
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

  /**
   * The sentence the host refused the most recent first-turn start with.
   *
   * The composer shows it, but a thread created from a draft starts its turn on
   * the window's create controller while the open thread renders from its own
   * controller — so the create flow reads this to hand the reason to the thread
   * the person is actually looking at.
   */
  const lastStartRefusal = useRef<string | undefined>(undefined);

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
  // A refused command must not leave the sidebar reading "Threads are unavailable"
  // until manual retry; it answers one action rather than disconnecting Code.
  const failCommand = useCallback((error: unknown) => {
    const failure = codeFailure(error);
    setErrorCategory(failure.category);
    setErrorMessage(failure.message);
    if (failure.category === "disconnected") setStatus("disconnected");
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
            samePollingData(currentBootstrap.runtime, next.runtime) &&
            samePollingData(currentBootstrap.plannerThreadIds, next.plannerThreadIds)
          )
        ) {
          bootstrapRef.current = {
            ...withNavigationPlanners(currentBootstrap, next),
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
          samePollingData(current.runtime, next.runtime) &&
          samePollingData(current.plannerThreadIds, next.plannerThreadIds)
        ) {
          return current;
        }
        return {
          ...withNavigationPlanners(current, next),
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
      const checkoutId = String(resolvedView.checkout.id);
      installedCheckout.current = checkoutId;
      setRestorePoint((point) =>
        point?.checkoutId === undefined
          ? point && { ...point, checkoutId }
          : point.checkoutId === checkoutId
            ? point
            : undefined,
      );
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

  /**
   * Take the newest turn's state as the thread's: whether a turn is still
   * running or waiting, and the usage limit the tail stopped on.
   */
  const settleLatestTurn = useCallback(
    (threadId: CodeThreadId, latestTurn: CodeConversationTurn | undefined) => {
      // The journal is the only authority a reopen can trust for a limit: a
      // completed later turn carries none, so this also clears a stale one.
      setTurnUsageLimit(latestTurn?.failure?.usageLimit);
      // The resume opt-in binds the turn the displayed limit belongs to; a
      // tail without a limit must not leave an older turn's id behind.
      setLatestProviderTurnOperationId(
        latestTurn?.failure?.usageLimit === undefined ? undefined : latestTurn.operationId,
      );
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
      };
    },
    [],
  );

  /**
   * Read the whole thread page by page, for a host that has no window read.
   * The thread then shows as fully loaded, as it always did there.
   */
  const hydrateWholeConversation = useCallback(
    async (threadId: CodeThreadId, request: number, signal: AbortSignal) => {
      let cursor = 0;
      let nextCursor = 0;
      let pageCount = 0;
      const turns: CodeConversationTurn[] = [];
      const messages: CodeConversationMessage[] = [];
      let pageLimits: ReadonlyArray<CodeProviderLimit> = [];
      const usage: typeof usageByOperation.current = new Map();
      earlierUsage.current = undefined;
      // A transcript already shown, and the usage and restore point that go
      // with it, are replaced only once every page is read: a later page that
      // fails must not leave them cut short.
      const shown = conversationThreadKey.current === String(threadId);
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
            usage.set(String(turn.operationId), turn.usage);
          }
        }
        if (page.limits !== undefined) pageLimits = page.limits;
        nextCursor = page.nextCursor;
        if (!shown || !page.hasMore) {
          usageByOperation.current = usage;
          setThreadUsage((current) =>
            retainThreadUsage(current, { ...totalTurnUsage(usage), limits: pageLimits }),
          );
          setRestoreUndo(page.restoreUndo);
          showConversation(threadId, [...inheritedConversation.current, ...messages]);
        }
        if (projected.activity.size > 0) {
          takeReadActivity(projected.activity);
        }
        if (!page.hasMore) break;
        if (page.nextCursor <= cursor || (pageCount += 1) >= 100) {
          throw new Error("Code conversation pagination did not advance.");
        }
        cursor = page.nextCursor;
      }
      // Everything is loaded, the inherited turns included, so nothing earlier is offered.
      setEarlierConversation(() => ({
        ...NO_EARLIER_CONVERSATION,
        threadKey: String(threadId),
        inherited: "complete",
      }));
      return { ...settleLatestTurn(threadId, turns.at(-1)), nextCursor };
    },
    [client, setEarlierConversation, settleLatestTurn, showConversation, takeReadActivity],
  );

  /**
   * Show the thread's newest turns and join them onto what is loaded: one
   * window read, its evidence, and its activity. Earlier pages stay while the
   * window still touches them. A host without the window read is read whole.
   */
  const hydrateConversation = useCallback(
    async (
      threadId: CodeThreadId,
      request: number,
      signal: AbortSignal,
    ): Promise<
      | {
          readonly incomplete: boolean;
          readonly activeOperationId: CodeOperationId | undefined;
          /** The forward cursor, only on a host read whole. */
          readonly nextCursor?: number;
        }
      | undefined
    > => {
      if (!readsConversationWindow(client)) {
        return hydrateWholeConversation(threadId, request, signal);
      }
      let window: CodeConversationWindow;
      try {
        window = await client.conversationWindow(
          threadId,
          { limit: CODE_CONVERSATION_PAGE_TURNS },
          signal,
        );
      } catch (error) {
        if (!(error instanceof CodeClientFailure && error.status === 404)) throw error;
        clientsWithoutConversationWindow.add(client);
        return hydrateWholeConversation(threadId, request, signal);
      }
      if (!isActive(request, threadGeneration, mounted) || window.threadId !== threadId)
        return undefined;
      const evidence = await readConversationEvidence(client, threadId, window.turns, signal);
      if (!isActive(request, threadGeneration, mounted)) return undefined;
      const projected = await projectConversationTurns(
        client,
        threadId,
        window.turns,
        evidence,
        signal,
      );
      if (!isActive(request, threadGeneration, mounted)) return undefined;
      const threadKey = String(threadId);
      const sameThread = conversationThreadKey.current === threadKey;
      const joined = joinNewestWindow(
        sameThread ? conversationRef.current : [],
        projected.messages,
        window.hasEarlier,
      );
      if (joined.kind === "replaced" || !sameThread) {
        earlierUsage.current = window.earlierUsage;
        setEarlierConversation((current) => {
          const kept = current.threadKey === threadKey;
          return {
            threadKey,
            ownHasEarlier: window.hasEarlier,
            // The inherited turns still touch only a window that reaches the
            // thread's first turn.
            inherited: kept && !window.hasEarlier ? current.inherited : undefined,
            offered: (kept && current.offered) || window.hasEarlier,
            loading: kept ? current.loading : "idle",
          };
        });
      }
      usageByOperation.current = loadedTurnUsage(
        joined.messages,
        window.turns,
        sameThread ? usageByOperation.current : new Map(),
      );
      setThreadUsage((current) =>
        retainThreadUsage(current, {
          ...totalTurnUsage(usageByOperation.current, earlierUsage.current),
          limits: window.limits ?? [],
        }),
      );
      setRestoreUndo(window.restoreUndo);
      showConversation(threadId, joined.messages);
      // A turn the journal no longer holds (another window rewound it away)
      // takes its tool activity with it, so nothing keeps watching its tools.
      // The turn this window's own send streams keeps its rows, as its
      // transcript rows are kept above.
      const held = new Set(joined.messages.map((message) => String(message.operationId)));
      const streamed = sentTurnStreaming.current;
      setTurnActivity((current) => {
        const kept = [...current].filter(
          ([operation]) => held.has(operation) || operation === streamed,
        );
        const read = [...projected.activity].filter(
          ([operation]) => operation !== streamed || !current.has(operation),
        );
        if (kept.length === current.size && read.length === 0) return current;
        return new Map([...kept, ...read]);
      });
      return settleLatestTurn(threadId, window.turns.at(-1));
    },
    [client, hydrateWholeConversation, setEarlierConversation, settleLatestTurn, showConversation],
  );

  /**
   * Add the page before the oldest loaded turn: the thread's own, then, for a
   * fork, its source's at the fork point and up the lineage. Answers whether
   * a page arrived. A page read for a run that has since been replaced is
   * dropped; an own anchor the host no longer holds starts the thread again
   * from its newest page.
   */
  const readEarlierPage = useCallback(
    async (threadId: CodeThreadId): Promise<boolean> => {
      const request = threadGeneration.current;
      const threadKey = String(threadId);
      const state = earlierConversationRef.current;
      if (
        state.threadKey !== threadKey ||
        state.loading === "loading" ||
        conversationThreadKey.current !== threadKey ||
        !readsConversationWindow(client)
      ) {
        return false;
      }
      const next = nextEarlierRead(state, conversationRef.current, forkedFrom.current);
      if (next.kind === "none") return false;
      earlierAbort.current?.abort();
      const abort = new AbortController();
      earlierAbort.current = abort;
      const current = () =>
        isActive(request, threadGeneration, mounted) &&
        !abort.signal.aborted &&
        conversationThreadKey.current === threadKey;
      // A page that no longer belongs on screen leaves the row ready again,
      // unless a later read of this thread has taken it over.
      const abandoned = () => {
        if (mounted.current && earlierAbort.current === abort) {
          setEarlierConversation((value) =>
            value.threadKey === threadKey && value.loading === "loading"
              ? { ...value, loading: "idle" }
              : value,
          );
        }
        return false;
      };
      setEarlierConversation((value) => ({ ...value, loading: "loading", offered: true }));
      try {
        if (next.kind === "own") {
          const page = await client.conversationWindow(
            threadId,
            { limit: CODE_CONVERSATION_PAGE_TURNS, before: next.before },
            abort.signal,
          );
          if (!current() || page.threadId !== threadId) return abandoned();
          const evidence = await readConversationEvidence(
            client,
            threadId,
            page.turns,
            abort.signal,
          );
          const projected = await projectConversationTurns(
            client,
            threadId,
            page.turns,
            evidence,
            abort.signal,
          );
          if (!current()) return abandoned();
          const loaded = conversationRef.current;
          // A newest read that could not prove it touched this run replaced
          // it while the page loaded; the page belongs to a run that is gone.
          if (oldestOwnOperation(loaded) !== next.before) {
            setEarlierConversation((value) => ({ ...value, loading: "idle" }));
            return false;
          }
          const at = loaded.findIndex(
            (message) => message.sourceThreadId === undefined && message.operationId !== undefined,
          );
          const held = new Set(loaded.map((message) => message.id));
          const messages = [
            ...loaded.slice(0, at),
            ...projected.messages.filter((message) => !held.has(message.id)),
            ...loaded.slice(at),
          ];
          earlierUsage.current = page.earlierUsage;
          usageByOperation.current = loadedTurnUsage(
            messages,
            page.turns,
            usageByOperation.current,
          );
          setThreadUsage((usage) => ({
            ...totalTurnUsage(usageByOperation.current, earlierUsage.current),
            limits: usage.limits,
          }));
          showConversation(threadId, messages);
          if (projected.activity.size > 0) {
            setTurnActivity((activity) => new Map([...projected.activity, ...activity]));
          }
          setEarlierConversation((value) => ({
            ...value,
            ownHasEarlier: page.hasEarlier,
            loading: "idle",
          }));
          return true;
        }
        const cursor = next.cursor;
        const page = await client.conversationWindow(
          cursor.threadId,
          { limit: CODE_CONVERSATION_PAGE_TURNS, ...cursor.anchor },
          abort.signal,
        );
        if (!current() || page.threadId !== cursor.threadId) return abandoned();
        const evidence = await readConversationEvidence(
          client,
          cursor.threadId,
          page.turns,
          abort.signal,
        );
        const projected = await projectConversationTurns(
          client,
          cursor.threadId,
          page.turns,
          evidence,
          abort.signal,
        );
        const first = page.turns[0];
        let continued: CodeInheritedCursor | "complete";
        if (page.hasEarlier && first !== undefined) {
          continued = { ...cursor, anchor: { before: first.operationId } };
        } else {
          // The source's own turns are all loaded; its own source, if any,
          // continues at the point it was forked from.
          const source = await client.thread(cursor.threadId, abort.signal);
          const origin = source.thread.forkedFrom;
          const lineage = [...cursor.lineage, String(cursor.threadId)];
          if (origin === undefined) continued = "complete";
          else if (
            lineage.includes(String(origin.threadId)) ||
            lineage.length >= MAX_CODE_FORK_LINEAGE
          ) {
            throw new Error("Fork history contains an invalid lineage.");
          } else {
            continued = {
              threadId: origin.threadId,
              anchor: { through: decodeCodeOperationId(origin.throughOperationId) },
              lineage,
            };
          }
        }
        if (!current()) return abandoned();
        // Rows from a source keep their source thread, which their evidence
        // and attachments are read through.
        const inherited = projected.messages.map((message) => ({
          ...message,
          sourceThreadId: cursor.threadId,
        }));
        showConversation(
          threadId,
          prependEarlierTurns(conversationRef.current, inherited, (message) => message.id),
        );
        if (projected.activity.size > 0) {
          setTurnActivity((activity) => new Map([...projected.activity, ...activity]));
        }
        setEarlierConversation((value) => ({
          ...value,
          inherited: continued,
          loading: "idle",
        }));
        return true;
      } catch (error) {
        if (abort.signal.aborted || !isActive(request, threadGeneration, mounted)) return false;
        if (
          next.kind === "own" &&
          error instanceof CodeClientFailure &&
          error.category === "stale"
        ) {
          // The turn this page was anchored on is gone, so the loaded run
          // cannot be extended: start again from the newest page.
          showConversation(threadId, []);
          setEarlierConversation(() => NO_EARLIER_CONVERSATION);
          try {
            await hydrateConversation(threadId, request, abort.signal);
            return false;
          } catch {
            if (abort.signal.aborted) return false;
          }
        }
        setEarlierConversation((value) => ({ ...value, loading: "failed" }));
        return false;
      }
    },
    [client, hydrateConversation, setEarlierConversation, showConversation],
  );

  const loadEarlierConversation = useCallback(() => {
    const threadId = activeThreadId.current;
    if (threadId !== undefined) void readEarlierPage(threadId);
  }, [readEarlierPage]);

  const activateThread = useCallback(
    async (threadId: CodeThreadId) => {
      const request = ++threadGeneration.current;
      inheritedConversation.current = [];
      streamAbort.current?.abort();
      earlierAbort.current?.abort();
      const controller = new AbortController();
      streamAbort.current = controller;
      clearFailure();
      // Usage belongs to the thread being left. Hydration may fail, so it is
      // cleared on the way in rather than replaced on the way out; otherwise the
      // new thread would keep showing the previous thread's totals and limits.
      // Activating the open thread again keeps the earlier pages it loaded,
      // and with them the usage they carry.
      if (conversationThreadKey.current !== String(threadId)) {
        usageByOperation.current = new Map();
        earlierUsage.current = undefined;
        forkedFrom.current = undefined;
        setEarlierConversation(() => NO_EARLIER_CONVERSATION);
        setThreadUsage(EMPTY_THREAD_USAGE);
      } else if (earlierConversationRef.current.loading === "loading") {
        // The page read just aborted with the stream it belonged to.
        setEarlierConversation((value) => ({ ...value, loading: "idle" }));
      }
      // A thread read again in place (a rename, a retry) shows the transcript
      // this activation's earlier read loaded, not one kept from a visit.
      const reloadsShown =
        conversationThreadKey.current === String(threadId) && settledHistory.current === "loaded";
      setConversationHistory("loading");
      // The first read covers the thread as the list described it now.
      const activityAtOpen = threadListActivity(bootstrapRef.current, threadId)?.sequence ?? -1;
      const conversationRead = hydrateConversation(threadId, request, controller.signal);
      void conversationRead.catch(() => undefined);
      try {
        const initial = await client.thread(threadId, controller.signal);
        if (!isActive(request, threadGeneration, mounted)) return;
        installView(initial);
        forkedFrom.current = initial.thread.forkedFrom;
        void refreshFollowUp(threadId);
        let conversationCursor = 0;
        let conversationIncomplete = false;
        let conversationOperationId: CodeOperationId | undefined;
        let openingReadFailed = false;
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
            current === HISTORY_UNAVAILABLE_MESSAGE ||
            current === HISTORY_UNREFRESHED_MESSAGE ||
            current === INHERITED_HISTORY_UNAVAILABLE_MESSAGE
              ? undefined
              : current,
          );
        } catch {
          if (!isActive(request, threadGeneration, mounted)) return;
          openingReadFailed = true;
          if (reloadsShown) {
            // What a read loaded stays, as when a refresh fails: emptying it
            // would also take the row a reply this window sends streams into.
            setConversationHistory("loaded");
            setTurnError(HISTORY_UNREFRESHED_MESSAGE);
          } else {
            // A transcript kept from an earlier visit goes, and with it the
            // tool activity of turns no longer shown and where Load earlier
            // went on: the next read starts the thread again from its newest
            // turns, as a first open does.
            conversationThreadKey.current = undefined;
            setConversation([]);
            setTurnActivity(new Map());
            setEarlierConversation(() => NO_EARLIER_CONVERSATION);
            setConversationHistory("unavailable");
            setTurnError(HISTORY_UNAVAILABLE_MESSAGE);
          }
        }
        if (initial.thread.forkedFrom !== undefined && !readsConversationWindow(client)) {
          try {
            const { readForkConversation } = await import("./forkConversation");
            const inherited = await readForkConversation(
              client,
              initial.thread.forkedFrom,
              controller.signal,
            );
            if (!isActive(request, threadGeneration, mounted)) return;
            inheritedConversation.current = inherited.messages;
            // A kept transcript already starts with the inherited turns.
            if (!(reloadsShown && openingReadFailed)) {
              setConversation((current) => [...inherited.messages, ...current]);
            }
            setTurnActivity((current) => new Map([...inherited.activity, ...current]));
          } catch {
            if (!isActive(request, threadGeneration, mounted)) return;
            setTurnError((current) => current ?? INHERITED_HISTORY_UNAVAILABLE_MESSAGE);
          }
        }
        /**
         * A new fork has few turns of its own, so its first inherited page is
         * read with the first read of the fork that succeeds, rather than
         * leaving the fork nearly empty.
         */
        const readFirstInheritedPage = async () => {
          if (
            initial.thread.forkedFrom === undefined ||
            conversationThreadKey.current !== String(threadId) ||
            earlierConversationRef.current.ownHasEarlier ||
            earlierConversationRef.current.inherited !== undefined ||
            conversationRef.current.filter((message) => message.role === "user").length >=
              CODE_CONVERSATION_PAGE_TURNS
          )
            return;
          const loaded = await readEarlierPage(threadId);
          if (!isActive(request, threadGeneration, mounted)) return;
          if (!loaded && earlierConversationRef.current.loading === "failed") {
            setTurnError((current) => current ?? INHERITED_HISTORY_UNAVAILABLE_MESSAGE);
          }
        };
        await readFirstInheritedPage();
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
          // A turn this window sends has its own stream; a second would write
          // the reply twice.
          if (operationStream !== undefined || sentTurnStreaming.current === String(operationId))
            return;
          operationStream = (async () => {
            let operationCursor = 0;
            let assistantText = "";
            let reasoningText = "";
            const replyBeat = createReplyBeat(() => {
              if (assistantText.length > 0) {
                const nextText = assistantText;
                setConversation((current) =>
                  current.map((message) =>
                    message.id === `${operationId}:assistant`
                      ? { ...message, text: nextText, status: "incomplete" }
                      : message,
                  ),
                );
              }
              if (reasoningText.length > 0) noteReasoning(operationId, reasoningText);
            });
            let snapshotRequired = false;
            try {
              while (isActive(request, threadGeneration, mounted) && !controller.signal.aborted) {
                if (snapshotRequired) {
                  // Commit what arrived before the reload: a failed reload
                  // must not lose the streamed text, and a successful one
                  // replaces it.
                  replyBeat.flush();
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
                  reasoningText = "";
                  // The operation replays from its beginning on a fresh base,
                  // so its deltas commit on beats again.
                  replyBeat.reset();
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
                    if (
                      !isActive(request, threadGeneration, mounted) ||
                      controller.signal.aborted
                    ) {
                      return;
                    }
                    const event = frame.event;
                    noteProviderRequest(event, (contentId) =>
                      readOperationText(
                        client,
                        threadId,
                        operationId,
                        contentId,
                        controller.signal,
                      ),
                    );
                    noteActivity(operationId, event);
                    noteUsage(operationId, event);
                    const updateReply = codeReplyMetadataUpdate(event, frame.occurredAt);
                    if (updateReply !== undefined) {
                      setConversation((current) =>
                        current.map((message) =>
                          message.id === `${operationId}:assistant`
                            ? updateReply(message)
                            : message,
                        ),
                      );
                    }
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
                      if (chunk !== undefined) {
                        reasoningText += chunk;
                        replyBeat.schedule();
                      }
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
                        replyBeat.schedule();
                      }
                    }

                    let terminalState:
                      | "completed"
                      | "waiting"
                      | "interrupted"
                      | "failed"
                      | undefined;
                    let terminalMessage: string | undefined;
                    let terminalFailureCategory: CodeOperationFailure["category"] | undefined;
                    let terminalUsageLimit: ProviderUsageLimit | undefined;
                    // Only a provider-turn-state result is the journaled stop a
                    // resume opt-in can bind to; other terminal frames show the
                    // limit but carry no schedulable stop.
                    let terminalProviderTurnOperationId: CodeOperationId | undefined;
                    if (event.kind === "operation-state" && event.state !== "running") {
                      terminalState = event.state;
                      terminalMessage = event.failure?.message;
                      terminalFailureCategory = event.failure?.category;
                      terminalUsageLimit = event.failure?.usageLimit;
                    } else if (
                      event.kind === "operation-result" &&
                      event.result.kind === "provider-turn-state" &&
                      event.result.state !== "running"
                    ) {
                      terminalState = event.result.state;
                      terminalUsageLimit = event.result.failure?.usageLimit;
                      terminalProviderTurnOperationId = operationId;
                    } else if (
                      event.kind === "operation-result" &&
                      event.result.kind === "operation-failed"
                    ) {
                      terminalState = "failed";
                      terminalMessage = event.result.failure.message;
                      terminalFailureCategory = event.result.failure.category;
                      terminalUsageLimit = event.result.failure.usageLimit;
                    }

                    operationCursor = Number(frame.cursor);
                    received += 1;
                    // The frame is on screen, so the activity the host had
                    // reported by now has been read.
                    markRenderedActivity(threadId);
                    if (terminalState !== undefined) {
                      // Commit what arrived before the authoritative reload:
                      // it replaces this stream's text when it lands, and a
                      // failed reload must not lose it.
                      replyBeat.flush();
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
                      setTurnUsageLimit(terminalUsageLimit);
                      setLatestProviderTurnOperationId(terminalProviderTurnOperationId);
                      if (terminalState === "completed") {
                        if (hydrated?.incomplete !== true) {
                          setTurnStatus("idle");
                          setTurnError(undefined);
                        }
                      } else {
                        setTurnStatus(
                          terminalState === "waiting"
                            ? "waiting"
                            : terminalState === "interrupted"
                              ? "interrupted"
                              : "failed",
                        );
                        // The reloaded transcript already carries this turn's
                        // row, so the callout above it would only repeat it.
                        setTurnError(
                          terminalMessage ??
                            (terminalState === "waiting"
                              ? "Reply to continue."
                              : `Provider turn ${terminalState}.`),
                          {
                            inTranscript: true,
                            ...(terminalFailureCategory === undefined
                              ? {}
                              : { category: terminalFailureCategory }),
                          },
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
            } finally {
              // Every exit that did not settle the beat leaves whatever text
              // and reasoning arrived in the state the person can see.
              replyBeat.flush();
            }
          })().finally(() => {
            operationStream = undefined;
          });
        };
        if (conversationOperationId !== undefined) {
          startConversationOperationStream(conversationOperationId);
        }
        // A read of the thread that succeeds settles its history, whichever
        // path started it: the warning a failed read put up comes down with
        // the state it stood for. A read an older activation finishes
        // settles nothing here.
        const historyRead = () => {
          if (!isActive(request, threadGeneration, mounted)) return;
          // A read that recovers a history that never loaded is the fork's
          // first read to succeed, so it brings the first inherited page: a
          // new fork has no turn activity that would read the fork again.
          if (settledHistory.current !== "loaded") void readFirstInheritedPage();
          setConversationHistory("loaded");
          setTurnError((current) =>
            current === HISTORY_UNAVAILABLE_MESSAGE || current === HISTORY_UNREFRESHED_MESSAGE
              ? undefined
              : current,
          );
        };
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
                // Only whether the newest turn is still running: one turn,
                // or on a host without the window read, the last one loaded.
                const latest = readsConversationWindow(client)
                  ? await client.conversationWindow(threadId, { limit: 1 }, controller.signal)
                  : await client.conversation(
                      threadId,
                      Math.max(0, conversationCursor - 1),
                      1,
                      controller.signal,
                    );
                if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                  return;
                noteSteeredMessages(latest.turns);
                if (latest.threadId !== threadId || latest.turns.at(-1)?.status === "incomplete") {
                  // A queued turn that started as the followed one ended
                  // runs with no stream: the ended one's stream has stopped.
                  // It is read once and followed like a turn found at open.
                  const newest = latest.turns.at(-1);
                  if (
                    latest.threadId === threadId &&
                    newest !== undefined &&
                    operationStream === undefined &&
                    turnStatusNow.current !== "sending" &&
                    sentTurnStreaming.current !== String(newest.operationId)
                  ) {
                    const hydrated = await hydrateConversation(
                      threadId,
                      request,
                      controller.signal,
                    );
                    if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                      return;
                    conversationCursor = hydrated?.nextCursor ?? conversationCursor;
                    if (hydrated?.activeOperationId !== undefined) {
                      startConversationOperationStream(hydrated.activeOperationId);
                    }
                  }
                  delayMs = Math.min(delayMs * 2, 2_000);
                  continue;
                }
                const hydrated = await hydrateConversation(threadId, request, controller.signal);
                if (hydrated?.incomplete !== true) {
                  // Same reason as the streamed terminal frame: the finished
                  // turn is on screen now, and the timed refresh that would
                  // otherwise report it may not run until the user has left.
                  void recordSeenActivity(threadId);
                  historyRead();
                  return;
                }
                conversationCursor = hydrated.nextCursor ?? conversationCursor;
              } catch {
                if (!isActive(request, threadGeneration, mounted)) return;
                setTurnError(HISTORY_UNREFRESHED_MESSAGE);
              }
            }
          })().finally(() => {
            conversationPoll = undefined;
          });
        };
        if (conversationIncomplete) startConversationPoll();

        // A turn another window, a phone, or an agent starts is journaled on
        // the operation, not the thread, so the thread's stream below never
        // hears of it. The thread list does: its activity moves, and while the
        // turn runs it says the thread is working. A working thread is read
        // once and the turn followed through the same poll and stream a read
        // at open would; activity on a settled thread takes one look at the
        // newest turn and reads the thread only for a turn not shown, as one
        // that started and ended between two reads of the list. A turn this
        // view follows already uses the activity up; a send of its own or a
        // read in flight only puts the look off, and a read that fails leaves
        // the activity to be looked at again. A waiting turn is not followed:
        // the reply that continues it may come from anywhere.
        // A first read that failed covered nothing, so its activity is still
        // to be looked at.
        let triedActivity = openingReadFailed ? -1 : activityAtOpen;
        // Until a read that follows the turn succeeds, a look reads the
        // thread: a read for a change to the thread does not replay a turn
        // waiting on the person, and its approval comes only with that replay.
        let unread = openingReadFailed;
        let following = false;
        let retryPending = false;
        const followTurn = async () => {
          const hydrated = await hydrateConversation(threadId, request, controller.signal);
          if (hydrated === undefined) return false;
          if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
            return true;
          conversationCursor = hydrated.nextCursor ?? conversationCursor;
          unread = false;
          historyRead();
          if (hydrated.incomplete) startConversationPoll();
          if (hydrated.activeOperationId !== undefined) {
            startConversationOperationStream(hydrated.activeOperationId);
          }
          return true;
        };
        const lookAtNewestTurn = async () => {
          if (!readsConversationWindow(client)) return true;
          const latest = await client.conversationWindow(threadId, { limit: 1 }, controller.signal);
          const newest = latest.turns.at(-1);
          if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
            return true;
          if (
            newest === undefined ||
            (newest.status !== "incomplete" &&
              conversationRef.current.some(
                (message) => String(message.operationId) === String(newest.operationId),
              ))
          )
            return true;
          return followTurn();
        };
        const follow = (activity: number, working: boolean): void => {
          if (
            activity <= triedActivity ||
            following ||
            turnStatusNow.current === "sending" ||
            !isActive(request, threadGeneration, mounted) ||
            controller.signal.aborted
          )
            return;
          if (
            operationStream !== undefined ||
            conversationPoll !== undefined ||
            activeTurnOperations.current.get(String(threadId))?.status === "running"
          ) {
            triedActivity = activity;
            return;
          }
          const lookedAt = triedActivity;
          triedActivity = activity;
          following = true;
          const lookAgainLater = () => {
            triedActivity = lookedAt;
            // A settled thread's activity may not move again, so the look is
            // tried again on its own until it succeeds or the view moves on;
            // one retry waits at a time, however many looks failed meanwhile.
            if (retryPending) return;
            retryPending = true;
            void waitForReconnect(controller.signal, FAILED_LOOK_RETRY_MS).then(() => {
              retryPending = false;
              follow(activity, working);
            });
          };
          void (working || unread ? followTurn() : lookAtNewestTurn())
            .then((read) => {
              if (!read) lookAgainLater();
            })
            .catch(lookAgainLater)
            .finally(() => {
              following = false;
            });
        };
        followTurnStartedElsewhere.current = follow;
        const listNow = threadListActivity(bootstrapRef.current, threadId);
        if (listNow !== undefined) follow(listNow.sequence, listNow.working);

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

        let polledIdleMs = POLLED_THREAD_EVENTS_ACTIVE_MS;
        const nextReadDelayMs = (framesRead: number): number => {
          if (client.threadEvents !== "poll") return reconnectDelayMs;
          if (framesRead > 0) {
            polledIdleMs = POLLED_THREAD_EVENTS_ACTIVE_MS;
            return POLLED_THREAD_EVENTS_ACTIVE_MS;
          }
          const delay = polledIdleMs;
          polledIdleMs = Math.min(polledIdleMs * 2, POLLED_THREAD_EVENTS_IDLE_MAX_MS);
          return delay;
        };
        for (;;) {
          if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted) return;
          let snapshotRequired = false;
          let framesRead = 0;
          try {
            const frames = client.subscribe(threadId, cursor, controller.signal);
            for await (const frame of frames) {
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                return;
              framesRead += 1;
              const position = framePosition(frame, threadId, cursor);
              if (position === "gap") {
                snapshotRequired = true;
                break;
              }
              setBootstrap((current) => applyEvent(current, frame));
              if (position === "covered") {
                // The thread read that answered the previous frame already
                // carried this sequence; the frame still lands on bootstrap,
                // but re-reading the thread for it would only repeat state.
                continue;
              }
              cursor = Number(frame.sequence);
              // Settling the conversation read up front keeps a thread read
              // that fails or returns early from leaving it an unhandled
              // rejection.
              const conversationRead =
                conversationPoll === undefined
                  ? hydrateConversation(threadId, request, controller.signal).then(
                      (value) => ({ status: "fulfilled" as const, value }),
                      () => ({ status: "rejected" as const }),
                    )
                  : undefined;
              const refreshed = await client.thread(threadId, controller.signal);
              if (!isActive(request, threadGeneration, mounted) || controller.signal.aborted)
                return;
              installView(refreshed);
              void refreshFollowUp(threadId);
              if (conversationRead !== undefined) {
                const settled = await conversationRead;
                if (settled.status === "rejected") {
                  if (!isActive(request, threadGeneration, mounted)) return;
                  setTurnError(HISTORY_UNREFRESHED_MESSAGE);
                } else {
                  const hydrated = settled.value;
                  conversationIncomplete = hydrated?.incomplete === true;
                  conversationOperationId = hydrated?.activeOperationId;
                  conversationCursor = hydrated?.nextCursor ?? conversationCursor;
                  if (hydrated !== undefined) historyRead();
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
                }
              }
              cursor = Number(refreshed.lastSequence);
            }
            if (!snapshotRequired) {
              await waitForReconnect(controller.signal, nextReadDelayMs(framesRead));
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
      noteSteeredMessages,
      readEarlierPage,
      reconnectDelayMs,
      recordSeenActivity,
      refreshFollowUp,
      setEarlierConversation,
    ],
  );

  const followUpThreadKey = useMemo(
    () =>
      options.activeThreadId !== undefined
        ? ""
        : (bootstrap?.threads ?? [])
            .filter((thread) => thread.lifecycle !== "archived")
            .map((thread) => String(thread.id))
            .sort()
            .join(","),
    [bootstrap, options.activeThreadId],
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

  const windowBootstrap = options.navigation?.bootstrap;
  useEffect(() => {
    if (ownsNavigation || windowBootstrap === undefined) return;
    bootstrapRef.current = windowBootstrap;
    setBootstrap(windowBootstrap);
    // Window metadata neither reconciles a tab's drafts nor recovers a failed
    // thread read. Only installing a successfully read view clears that failure.
  }, [ownsNavigation, windowBootstrap]);

  useEffect(() => {
    mounted.current = true;
    if (ownsNavigation) void loadBootstrap("bootstrap");
    return () => {
      mounted.current = false;
      bootstrapGeneration.current += 1;
      threadGeneration.current += 1;
      bootstrapAbort.current.abort();
      streamAbort.current?.abort();
      turnAbort.current?.abort();
    };
  }, [loadBootstrap, ownsNavigation]);

  useEffect(() => {
    activeThreadId.current = options.activeThreadId;
    threadGeneration.current += 1;
    followTurnStartedElsewhere.current = undefined;
    streamAbort.current?.abort();
    streamAbort.current = undefined;
    turnAbort.current?.abort();
    turnAbort.current = undefined;
    earlierAbort.current?.abort();
    // A thread the window comes back to keeps the transcript it starts from;
    // the read below joins the journal's newest turns onto it or replaces it.
    const keepsTranscript =
      keptTranscript.current &&
      readsConversationWindow(client) &&
      kept?.client === client &&
      conversationThreadKey.current === String(options.activeThreadId);
    if (!keepsTranscript) {
      keptTranscript.current = false;
      conversationThreadKey.current = undefined;
      conversationRef.current = [];
      setConversation([]);
      setTurnActivity(new Map());
    }
    setSteeredMessages(new Map());
    setConversationHistory("loading");
    setProviderRequests([]);
    setRefusedAnswer(undefined);
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
    // Activation rehydrates the journal's own fact; nothing carried over from
    // the thread being left is allowed to speak for this one. Above all its
    // restore point: offered on another thread's checkout, it would overwrite
    // files nobody asked about. Reading the open thread again keeps its own
    // until a read replaces it, so a read that fails leaves Undo restore.
    setRestoreUndo(undefined);
    installedCheckout.current = undefined;
    setTurnUsageLimit(undefined);
    setLatestProviderTurnOperationId(undefined);
    if (firstTurnFailure !== undefined) {
      setPendingDraft(firstTurnFailure.prompt);
      firstTurnFailures.current.delete(String(options.activeThreadId));
    }
    if (options.activeThreadId === undefined) {
      setActiveView(undefined);
      return;
    }
    void activateThread(options.activeThreadId);
  }, [activateThread, client, kept, options.activeThreadId]);

  const shownFacts = useRef({ activeView, conversationHistory, threadUsage, turnActivity });
  shownFacts.current = { activeView, conversationHistory, threadUsage, turnActivity };
  /**
   * What this thread shows now, for the window to start from when it comes
   * back, or nothing when no read of it has landed or the last one failed.
   */
  const keepThread = useCallback((): CodeKeptThread | undefined => {
    const threadKey = String(activeThreadId.current);
    const shown = shownFacts.current;
    const view = shown.activeView;
    const held =
      shown.conversationHistory === "loaded" ||
      (shown.conversationHistory === "loading" && keptTranscript.current);
    // A host without the window read is read again from its first page, which
    // would replace the kept newest turns with the oldest ones while it loads.
    if (
      !held ||
      !readsConversationWindow(client) ||
      view === undefined ||
      String(view.thread.id) !== threadKey ||
      conversationThreadKey.current !== threadKey ||
      conversationRef.current.length === 0
    ) {
      return undefined;
    }
    const earlier = earlierConversationRef.current;
    return {
      client,
      view,
      conversation: conversationRef.current,
      inheritedConversation: inheritedConversation.current,
      earlierConversation: earlier.loading === "idle" ? earlier : { ...earlier, loading: "idle" },
      forkedFrom: forkedFrom.current,
      turnActivity: shown.turnActivity,
      threadUsage: shown.threadUsage,
      usageByOperation: usageByOperation.current,
      earlierUsage: earlierUsage.current,
    };
  }, [client]);

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
        readonly awaitingKind?: "approval" | "user-input";
        readonly checkoutChip?: {
          readonly checkoutKind: "existing-worktree" | "managed-worktree";
          readonly label: string;
        };
        readonly pullRequestSummaries?: ThreadBoardPullRequestSummaries;
        readonly touchedIssues?: ThreadTouchedIssues;
        readonly turnStartedAt?: string;
        readonly liveStep?: ThreadLiveStep;
      }
    >();
    for (const entry of bootstrap?.runtime ?? []) {
      // The whole list from a host that sends it, else the board's three.
      const pullRequestSummaries = entry.threadPullRequests ?? entry.pullRequestSummaries;
      byThread.set(String(entry.threadId), {
        executing: entry.executing,
        ...(entry.awaitingInput === true ? { awaitingKind: entry.awaitingKind ?? "approval" } : {}),
        ...(entry.turnStartedAt === undefined ? {} : { turnStartedAt: entry.turnStartedAt }),
        ...(entry.liveStep === undefined ? {} : { liveStep: entry.liveStep }),
        ...(entry.checkoutChip === undefined ? {} : { checkoutChip: entry.checkoutChip }),
        ...(pullRequestSummaries === undefined ? {} : { pullRequestSummaries }),
        ...(entry.touchedIssues === undefined ? {} : { touchedIssues: entry.touchedIssues }),
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
  const openThreadList =
    options.activeThreadId === undefined
      ? undefined
      : threadListActivity(bootstrap, options.activeThreadId);
  const openThreadSequence = openThreadList?.sequence;
  const openThreadWorking = openThreadList?.working === true;
  // The turn status too: a send of this window's own that the host refused
  // leaves a turn started elsewhere still to be looked for.
  useEffect(() => {
    if (openThreadSequence !== undefined) {
      followTurnStartedElsewhere.current?.(openThreadSequence, openThreadWorking);
    }
  }, [openThreadSequence, openThreadWorking, turnStatus]);
  const plannerThreadIds = useMemo(
    () => new Set((bootstrap?.plannerThreadIds ?? []).map(String)),
    [bootstrap],
  );

  const navigation = useMemo(
    (): ReadonlyArray<CodeThreadNavigationItem> =>
      (bootstrap?.threads ?? [])
        .filter((thread) => thread.lifecycle !== "archived")
        .map((thread) => {
          const runtime = runtimeByThread.get(String(thread.id));
          // The designated planner reads as a coordinator whose starts need
          // approval; a worker never does (docs/design/coordinator-threads.md).
          const planner =
            thread.coordinatorThreadId === undefined && plannerThreadIds.has(String(thread.id));
          return {
            executionPolicy: thread.executionPolicy,
            lifecycle: thread.lifecycle,
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            modelId: String(thread.modelId),
            createdAt: thread.createdAt,
            threadId: thread.id,
            title: thread.title,
            followUp: followUps.get(String(thread.id))?.followUp?.state === "open",
            unread:
              markedUnreadThreads.has(String(thread.id)) ||
              (activityByThread.get(String(thread.id)) ?? 0) >
                (readCursors.get(String(thread.id)) ?? 0),
            ...(runtime?.executing === true ? { executing: true } : {}),
            ...(runtime?.awaitingKind === undefined
              ? {}
              : { awaitingInput: true, awaitingKind: runtime.awaitingKind }),
            ...(runtime?.turnStartedAt === undefined
              ? {}
              : { turnStartedAt: runtime.turnStartedAt }),
            ...(runtime?.liveStep === undefined ? {} : { liveStep: runtime.liveStep }),
            ...(runtime?.checkoutChip === undefined ? {} : { checkoutChip: runtime.checkoutChip }),
            ...(runtime?.pullRequestSummaries === undefined
              ? {}
              : { pullRequestSummaries: runtime.pullRequestSummaries }),
            ...(runtime?.touchedIssues === undefined
              ? {}
              : { touchedIssues: runtime.touchedIssues }),
            ...(thread.pinned === true ? { pinned: true } : {}),
            ...(thread.completedAt === undefined ? {} : { completedAt: thread.completedAt }),
            ...(thread.snooze === undefined ? {} : { snooze: thread.snooze }),
            ...(thread.markedDoneAt === undefined ? {} : { markedDone: true as const }),
            ...(thread.forkedFrom === undefined
              ? {}
              : { lineageParentThreadId: String(thread.forkedFrom.threadId) }),
            ...(thread.coordinator === true || planner ? { coordinator: true as const } : {}),
            ...(planner ? { planner: true as const } : {}),
            ...(thread.coordinatorThreadId === undefined
              ? {}
              : { coordinatorThreadId: thread.coordinatorThreadId }),
            ...(thread.coordinatorChoice === undefined
              ? {}
              : { coordinatorChoice: thread.coordinatorChoice }),
            ...(thread.messageWake === true ? { messageWake: true as const } : {}),
            ...(thread.coordinatorWakeOff === true ? { coordinatorWakeOff: true as const } : {}),
            ...(thread.restartContinuationOff === true
              ? { restartContinuationOff: true as const }
              : {}),
            updatedAt: thread.updatedAt,
          };
        })
        // Pinned threads lead, and the order inside each group is the host's.
        // Sorting the whole list by recency instead would move a pinned thread
        // the moment anything else ran, which is the opposite of pinning it.
        .sort((left, right) => Number(right.pinned ?? false) - Number(left.pinned ?? false)),
    [
      activityByThread,
      bootstrap,
      followUps,
      markedUnreadThreads,
      plannerThreadIds,
      readCursors,
      runtimeByThread,
    ],
  );

  /**
   * Cleanup and restore of a managed worktree write no journal event and the
   * navigation read carries no cleanup standing, so the open thread would keep
   * a stale one for ever. On the navigation timer already running, a managed
   * worktree thread's view is read again at most once per interval and only
   * its standing is taken from it; every other thread costs nothing.
   */
  const refreshWorktreeStanding = useCallback(async () => {
    const open = activeViewRef.current;
    if (open === undefined || open.checkout.kind !== "managed-worktree") return;
    const at = Date.now();
    if (at - lastStandingRead.current < worktreeStandingRefreshMs) return;
    lastStandingRead.current = at;
    try {
      const read = await client.thread(open.thread.id);
      if (!mounted.current || String(activeThreadId.current) !== String(read.thread.id)) return;
      setActiveView((current) => {
        if (current === undefined || String(current.thread.id) !== String(read.thread.id)) {
          return current;
        }
        if (current.worktreeCleanup === read.worktreeCleanup) return current;
        const { worktreeCleanup: _previous, ...rest } = current;
        return read.worktreeCleanup === undefined
          ? rest
          : { ...rest, worktreeCleanup: read.worktreeCleanup };
      });
    } catch {
      // The next interval reads it again.
    }
  }, [client, worktreeStandingRefreshMs]);

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
        void refreshWorktreeStanding();
        // A paired browser has no change feed to hear a queue change from.
        void readSteeredMessages();
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
  }, [
    applyNavigationRefresh,
    client,
    navigationRefreshMs,
    nextNavigationRead,
    readSteeredMessages,
    refreshWorktreeStanding,
  ]);

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

  /**
   * Reads the thread list once now, for a caller that needs to know whether a
   * thread the host just named is in it. A read that fails leaves the list as
   * it was.
   */
  const refreshNavigation = useCallback(async (): Promise<void> => {
    const read = nextNavigationRead();
    try {
      const next = await client.navigation();
      if (mounted.current) applyNavigationRefresh(next, read);
    } catch {
      // The list stays as it was; the caller decides what a missing thread means.
    }
  }, [applyNavigationRefresh, client, nextNavigationRead]);

  const execute = useCallback(
    async (
      command: CodeCommand,
      signal?: AbortSignal,
      onWorktreeProgress?: (progress: CodeWorktreeCreationProgress) => void,
    ): Promise<CodeCommandResult | undefined> => {
      // The branch name field falls back to a name of its own and says so there,
      // so neither read shows a failure banner: a host older than these commands
      // refuses them every time a draft opens.
      const namesBranch =
        command.kind === "list-code-worktree-branch-names" ||
        command.kind === "suggest-code-worktree-branch";
      if (!namesBranch) {
        clearFailure();
        lastExecuteError.current = undefined;
      }
      try {
        const result =
          onWorktreeProgress !== undefined
            ? await client.execute(command, signal, onWorktreeProgress)
            : signal === undefined
              ? await client.execute(command)
              : await client.execute(command, signal);
        if (!mounted.current) return undefined;
        // Update the ref immediately so a sequential command awaited right
        // after this one (such as saving bounds and done-when in one dialog
        // click) reads the committed thread version before React re-renders.
        bootstrapRef.current = applyResult(bootstrapRef.current, result);
        setBootstrap((current) => applyResult(current, result));
        setActiveView((current) => withUpdatedThread(current, result));
        const currentThreadId = activeThreadId.current;
        if (currentThreadId !== undefined && commandReloadsThread(command, currentThreadId)) {
          void activateThread(currentThreadId);
        }
        return result;
      } catch (error) {
        if (!mounted.current) return undefined;
        if (signal?.aborted) return undefined;
        if (namesBranch) return undefined;
        const failure = codeFailure(error);
        lastExecuteError.current = failure;
        if (failure.category === "stale" || failure.category === "conflict") {
          const loaded = await loadBootstrap("conflict");
          const currentThreadId = activeThreadId.current;
          if (loaded && currentThreadId !== undefined) void activateThread(currentThreadId);
          return undefined;
        }
        failCommand(error);
        return undefined;
      }
    },
    [activateThread, clearFailure, client, failCommand, loadBootstrap],
  );

  const beginProviderTurn = useCallback(
    async (input: {
      readonly contextInputPolicy?: ConversationInputPolicy;
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
      readonly sideChatReturns?: ReadonlyArray<SideChatDraftReturnReference>;
      readonly reviewFindingReferences?: ReadonlyArray<CodeReviewFindingReference>;
      readonly pullRequestLineNotesSource?: CodePullRequestLineNotesSource;
      /**
       * Images this turn carries. Ids only: the host holds the bytes it
       * accepted and reads them itself, so the renderer never re-sends an
       * image and never decides what an id stands for.
       */
      readonly attachmentIds?: ReadonlyArray<CodeAttachmentId>;
      readonly fileMentionPaths?: ReadonlyArray<string>;
      readonly computerUseSelection?: ExtensionSelection;
      readonly extensionSelections?: ReadonlyArray<ExtensionSelection>;
      readonly toolCatalogHandoff?: boolean;
      /** The person typed this message into the composer; a button's text is not. */
      readonly typedByPerson?: true;
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
        ...(input.toolCatalogHandoff === true ? { toolCatalogHandoff: true } : {}),
        ...(input.contextInputPolicy === undefined
          ? {}
          : { contextInputPolicy: input.contextInputPolicy }),
        ...(input.typedByPerson === true ? { typedByPerson: true as const } : {}),
        operationId,
        threadId: input.threadId,
        checkoutId: input.checkoutId,
        sessionId,
        prompt: reference,
        ...(input.computerUseSelection === undefined
          ? {}
          : { computerUseSelection: input.computerUseSelection }),
        ...(input.extensionSelections === undefined || input.extensionSelections.length === 0
          ? {}
          : { extensionSelections: [...input.extensionSelections] }),
        ...(input.threadMentionIds === undefined || input.threadMentionIds.length === 0
          ? {}
          : { threadMentionIds: [...input.threadMentionIds] }),
        ...(input.reviewFindingReferences === undefined ||
        input.reviewFindingReferences.length === 0
          ? {}
          : { reviewFindingReferences: [...input.reviewFindingReferences] }),
        ...(input.pullRequestLineNotesSource === undefined
          ? {}
          : { pullRequestLineNotesSource: input.pullRequestLineNotesSource }),
        ...(input.sideChatReturns === undefined || input.sideChatReturns.length === 0
          ? {}
          : { sideChatReturns: [...input.sideChatReturns] }),
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
      readonly computerUseSelection?: ExtensionSelection;
      readonly extensionSelections?: ReadonlyArray<ExtensionSelection>;
      /** The person typed the prompt where it was written; it keeps the claim if it is put back. */
      readonly typedByPerson?: true;
    }): Promise<boolean> => {
      const prompt = input.prompt.trim();
      if (prompt.length === 0) return false;
      firstTurnFailures.current.delete(String(input.threadId));
      lastStartRefusal.current = undefined;
      clearFailure();
      setTurnError(undefined);
      setTurnUsageLimit(undefined);
      setLatestProviderTurnOperationId(undefined);
      setTurnStatus("sending");
      const failFirstTurn = (message: string) => {
        firstTurnFailures.current.set(String(input.threadId), { prompt, message });
        lastStartRefusal.current = message;
        activeTurnOperations.current.delete(String(input.threadId));
        setTurnStatus("failed");
        setTurnError(message);
        // Activation is what usually restores this prompt, but a first turn can
        // fail on a thread that is already open — the New Code composer opens
        // the thread before starting — so put it back now or the composer stays
        // empty in front of the error.
        if (input.typedByPerson === true) {
          noteTypedComposerText(threadDraftScope("code", String(input.threadId)), prompt);
        }
        if (String(activeThreadId.current) === String(input.threadId)) {
          setPendingDraft(prompt);
          firstTurnFailures.current.delete(String(input.threadId));
        }
      };
      try {
        const { operationId, started } = await beginProviderTurn({
          ...input,
          prompt,
        });
        if (started.kind === "operation-failed") {
          failFirstTurn(started.failure.message);
          if (started.failure.usageLimit !== undefined) {
            setTurnUsageLimit(started.failure.usageLimit);
          }
          // An operation failure records no provider-turn stop to resume.
          setLatestProviderTurnOperationId(undefined);
          return false;
        }
        if (started.kind !== "provider-turn-state" || started.state !== "running") {
          // A refused start that names its reason is worth more than the
          // generic sentence: the host refused this turn for a specific cause.
          const refusal =
            started.kind === "provider-turn-state" ? started.failure?.message : undefined;
          failFirstTurn(refusal ?? "The provider turn could not be started.");
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
        failCommand(error);
        return false;
      }
    },
    [activateThread, beginProviderTurn, clearFailure, failCommand, setPendingDraft],
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
      const thread = findCodeThread(bootstrapRef.current?.threads, threadId);
      if (thread === undefined) return false;
      const result = await execute(renameCodeThread(thread, title));
      return result !== undefined;
    },
    [execute],
  );

  /**
   * Start a new thread that continues an existing one from a chosen answer.
   *
   * The host builds the fork on its own managed worktree and branch, starting
   * from the files as they stood after that answer — uncommitted work
   * included — so the fork and its source never write to the same checkout.
   * It also decides what history the fork's first turn carries. Nothing about
   * the source thread changes: a fork is a second direction, not a rewrite.
   */
  const forkThread = useCallback(
    async (input: {
      readonly threadId: CodeThreadId;
      readonly throughOperationId: string;
      readonly title: string;
    }): Promise<CodeThread | undefined> => {
      const created = await execute({
        kind: "fork-code-thread",
        threadId: decodeCodeThreadId(globalThis.crypto.randomUUID()),
        sourceThreadId: input.threadId,
        throughOperationId: input.throughOperationId,
        title: input.title,
      });
      return created?.kind === "managed-thread-created" ? created.thread : undefined;
    },
    [execute],
  );

  /**
   * Merge a fork's conversation back into the thread it was forked from,
   * through one of the fork's finished replies. The host reads the turns
   * itself and the source's next message carries them; nothing runs now and
   * no file moves. Undefined only when the host could not be asked at all.
   */
  const mergeForkContext = useCallback(
    async (input: {
      readonly threadId: CodeThreadId;
      readonly throughOperationId: string;
      readonly contextInputPolicy?: ConversationInputPolicy;
    }): Promise<CodeForkMergeBackOutcome | undefined> => {
      const result = await execute({
        kind: "merge-code-fork-context",
        threadId: input.threadId,
        throughOperationId: input.throughOperationId,
        ...(input.contextInputPolicy === undefined
          ? {}
          : { contextInputPolicy: input.contextInputPolicy }),
      });
      return result?.kind === "fork-context-merge" ? result.outcome : undefined;
    },
    [execute],
  );

  /**
   * Reads the open thread's view from the host again, for a fact that changes
   * with no journal event of its own, such as its worktree being restored.
   * A read that fails is read again by the next navigation refresh.
   */
  const reloadThreadView = useCallback(
    async (threadId: CodeThreadId): Promise<void> => {
      try {
        const view = await client.thread(threadId);
        if (!mounted.current || String(activeThreadId.current) !== String(view.thread.id)) return;
        installView(view);
      } catch {
        // The next navigation refresh reads it again.
      }
    },
    [client, installView],
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
      const thread = findCodeThread(bootstrapRef.current?.threads, threadId);
      if (thread === undefined) return false;
      const result = await execute(pinCodeThread(thread, pinned));
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
      const thread = findCodeThread(bootstrapRef.current?.threads, threadId);
      if (thread === undefined) return false;
      const result = await execute(archiveCodeThread(thread));
      return result !== undefined;
    },
    [execute],
  );

  /**
   * Complete, reopen, snooze, and wake all carry the version the renderer
   * last saw, like archiving. Whether completing or snoozing would hide work
   * in flight is the host's call, so the answer is a value the caller must
   * handle: these run from a sidebar row, where nothing else reports a
   * failure. The controller's own error line is read only while Code is
   * disconnected, and a stale version reloads the list without a word, so a
   * refusal that is not returned here reaches the person as a click that did
   * nothing.
   */
  const restCommand = useCallback(
    async (
      threadId: CodeThreadId,
      command: (thread: CodeThread) => CodeCommand,
    ): Promise<CodeThreadRestOutcome> => {
      const thread = findCodeThread(bootstrapRef.current?.threads, threadId);
      if (thread === undefined) {
        return { status: "refused", message: "This thread is no longer in the list." };
      }
      const result = await execute(command(thread));
      if (result !== undefined) return { status: "ok" };
      return {
        status: "refused",
        message: lastExecuteError.current?.message ?? "The host could not change this thread.",
      };
    },
    [execute],
  );
  const completeThread = useCallback(
    (threadId: CodeThreadId) => restCommand(threadId, completeCodeThread),
    [restCommand],
  );
  const reopenThread = useCallback(
    (threadId: CodeThreadId) => restCommand(threadId, reopenCodeThread),
    [restCommand],
  );
  const markThreadDone = useCallback(
    (threadId: CodeThreadId) => restCommand(threadId, markCodeThreadDone),
    [restCommand],
  );
  const unlinkPullRequest = useCallback(
    (
      threadId: CodeThreadId,
      pullRequest: Pick<
        ThreadBoardPullRequestIdentity,
        "repositoryOwner" | "repositoryName" | "number"
      >,
    ) => restCommand(threadId, (thread) => unlinkCodeThreadPullRequest(thread, pullRequest)),
    [restCommand],
  );
  const snoozeThread = useCallback(
    (threadId: CodeThreadId, until: string) =>
      restCommand(threadId, (thread) => snoozeCodeThread(thread, decodeUtcTimestamp(until))),
    [restCommand],
  );
  const wakeThread = useCallback(
    (threadId: CodeThreadId) => restCommand(threadId, wakeCodeThread),
    [restCommand],
  );
  /**
   * A move the person asked to run after the source thread's current turn. The
   * intent stays scoped to that thread and that turn — each queued request is
   * its own record, so closing the dialog cancels only that request, a newer
   * request resolves the one it replaces rather than leaving it open, and it
   * is dropped if a new turn takes over. The host revalidates the real move
   * when it dispatches with the thread's version then current.
   */
  const pendingMoveRef = useRef<PendingThreadMove | undefined>(undefined);
  useEffect(() => {
    const pending = pendingMoveRef.current;
    if (pending === undefined || bootstrap === undefined) return;
    const runtime = bootstrap.runtime.find(
      (entry) => String(entry.threadId) === String(pending.threadId),
    );
    if (runtime !== undefined && (runtime.executing === true || runtime.awaitingInput === true)) {
      if (
        pending.sourceTurnStartedAt !== undefined &&
        runtime.turnStartedAt !== undefined &&
        runtime.turnStartedAt !== pending.sourceTurnStartedAt
      ) {
        pendingMoveRef.current = undefined;
        pending.resolve({
          status: "refused",
          message: "The thread started another turn; move it when it is idle.",
        });
      }
      return;
    }
    pendingMoveRef.current = undefined;
    void restCommand(pending.threadId, (thread) => moveCodeThread(thread, pending.projectId)).then(
      pending.resolve,
    );
  }, [bootstrap, restCommand]);
  const cancelPendingMove = useCallback((pending: PendingThreadMove) => {
    if (pendingMoveRef.current !== pending) return;
    pendingMoveRef.current = undefined;
    pending.resolve({ status: "cancelled" });
  }, []);
  const queuePendingMove = useCallback((pending: PendingThreadMove) => {
    const replaced = pendingMoveRef.current;
    pendingMoveRef.current = pending;
    // A newer queued move supersedes the old one; its promise still resolves
    // so the dialog that asked for it is never left waiting on an answer that
    // can no longer come.
    replaced?.resolve({ status: "cancelled" });
  }, []);
  const moveThread = useCallback(
    async (
      threadId: CodeThreadId,
      projectId: ProjectId,
      options?: { readonly when?: "after-turn" | "stop-now" | undefined },
    ): Promise<CodeThreadMoveOutcome> => {
      const runtime = bootstrapRef.current?.runtime.find(
        (entry) => String(entry.threadId) === String(threadId),
      );
      const turnRunning =
        runtime !== undefined && (runtime.executing === true || runtime.awaitingInput === true);
      const queueAfterTurn = (): CodeThreadMoveOutcome => {
        let resolveSettled: (outcome: CodeThreadMoveOutcome) => void = () => undefined;
        const settled = new Promise<CodeThreadMoveOutcome>((resolve) => {
          resolveSettled = resolve;
        });
        const pending: PendingThreadMove = {
          threadId,
          projectId,
          ...(runtime?.turnStartedAt === undefined
            ? {}
            : { sourceTurnStartedAt: runtime.turnStartedAt }),
          resolve: resolveSettled,
        };
        queuePendingMove(pending);
        return {
          status: "deferred",
          settled,
          cancel: () => cancelPendingMove(pending),
        };
      };
      if (options?.when === "after-turn") {
        if (turnRunning) return queueAfterTurn();
        return await restCommand(threadId, (thread) => moveCodeThread(thread, projectId));
      }
      if (options?.when === "stop-now") {
        if (!turnRunning) {
          return await restCommand(threadId, (thread) => moveCodeThread(thread, projectId));
        }
        const scopedTurn = activeTurnOperations.current.get(String(threadId));
        if (scopedTurn === undefined) {
          // An unscoped cancel could land on a turn that replaced the one the
          // person meant to stop; without that turn's identity the stop is
          // refused and the move is left for them to queue.
          return {
            status: "refused",
            message:
              "The running turn cannot be identified from this window; move the thread after it finishes instead.",
          };
        }
        const thread = findCodeThread(bootstrapRef.current?.threads, threadId);
        if (thread === undefined) {
          return { status: "refused", message: "This thread is no longer in the list." };
        }
        try {
          await client.executeOperation({
            kind: "cancel-provider-turn",
            operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
            threadId,
            checkoutId: thread.checkoutId,
            turnOperationId: scopedTurn.operationId,
          });
        } catch {
          // The stop attempt is best-effort: the queued move still waits for
          // the turn to settle, and the host revalidates the move itself.
        }
        // The move dispatches once the stopped turn has actually settled —
        // moving while it is still draining would hit the same host refusal
        // as moving mid-turn.
        return queueAfterTurn();
      }
      return await restCommand(threadId, (thread) => moveCodeThread(thread, projectId));
    },
    [cancelPendingMove, client, queuePendingMove, restCommand],
  );
  // The coordinator role and both wake switches are a person's choice from a
  // local window; the host refuses the rest (a worker, a fifth coordinator)
  // and the refusal comes back in its words, like a rest command's.
  const setThreadCoordinator = useCallback(
    (threadId: CodeThreadId, coordinator: boolean, workerLevel?: CoordinatorWorkerLevel) =>
      restCommand(threadId, (thread) =>
        setCodeThreadCoordinator(thread, coordinator, coordinator ? workerLevel : undefined),
      ),
    [restCommand],
  );
  const setThreadCoordinatorBounds = useCallback(
    (threadId: CodeThreadId, bounds: CoordinatorBounds) =>
      restCommand(threadId, (thread) => setCodeThreadCoordinatorBounds(thread, bounds)),
    [restCommand],
  );
  const setThreadCoordinatorDoneWhen = useCallback(
    (threadId: CodeThreadId, doneWhen: CoordinatorDoneWhen | undefined) =>
      restCommand(threadId, (thread) => setCodeThreadCoordinatorDoneWhen(thread, doneWhen)),
    [restCommand],
  );
  const setThreadMessageWake = useCallback(
    (threadId: CodeThreadId, wake: boolean) =>
      restCommand(threadId, (thread) => setCodeThreadMessageWake(thread, wake)),
    [restCommand],
  );
  const setThreadCoordinatorWake = useCallback(
    (threadId: CodeThreadId, wake: boolean) =>
      restCommand(threadId, (thread) => setCodeThreadCoordinatorWake(thread, wake)),
    [restCommand],
  );
  const setThreadRestartContinuation = useCallback(
    (threadId: CodeThreadId, continueAfterRestart: boolean) =>
      restCommand(threadId, (thread) =>
        setCodeThreadRestartContinuation(thread, continueAfterRestart),
      ),
    [restCommand],
  );

  /**
   * Hand a finished thread one more turn without opening it. The host starts
   * the turn under the thread's own posture and runs it whether or not this
   * window is watching, so the person can send several threads back in a row
   * from the Review page. Opening the thread afterwards hydrates the running
   * turn from the journal like any other. The answer is a value: a refusal
   * (a turn already running, a checkout still waiting) arrives in the host's
   * words and the caller shows it where the person acted.
   */
  const sendBackTurn = useCallback(
    async (threadId: CodeThreadId, prompt: string): Promise<CodeThreadRestOutcome> => {
      const text = prompt.trim();
      if (text.length === 0) return { status: "refused", message: "Write a follow-up first." };
      const thread = findCodeThread(bootstrapRef.current?.threads, threadId);
      if (thread === undefined) {
        return { status: "refused", message: "This thread is no longer in the list." };
      }
      try {
        const { started } = await beginProviderTurn({
          threadId,
          checkoutId: thread.checkoutId,
          prompt: text,
        });
        if (started.kind === "operation-failed") {
          return { status: "refused", message: started.failure.message };
        }
        if (started.kind !== "provider-turn-state" || started.state !== "running") {
          const refusal =
            started.kind === "provider-turn-state" ? started.failure?.message : undefined;
          return {
            status: "refused",
            message: refusal ?? "The provider turn could not be started.",
          };
        }
        return { status: "ok" };
      } catch (error) {
        return { status: "refused", message: codeFailure(error).message };
      }
    },
    [beginProviderTurn],
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
        failCommand(error);
        return false;
      }
    },
    [client, failCommand, followUps, refreshFollowUp],
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
        failCommand(error);
        return false;
      }
    },
    [client, failCommand, followUps, refreshFollowUp],
  );

  const updateSettings = useCallback(
    async (input: {
      readonly defaultModel?: CodeBootstrap["settings"]["defaultModel"] | null;
      readonly defaultExecutionPolicy: CodeThread["executionPolicy"];
      readonly defaultPermissionPersistence: CodeThread["permissionPersistence"];
      readonly externalEditor?: CodeExternalEditor;
      readonly requireGitRepository?: boolean;
      readonly defaultDiffLayout?: CodeBootstrap["settings"]["defaultDiffLayout"];
      readonly bundledLanguageServer?: boolean;
      readonly androidEmulatorSnapshotBoot?: boolean;
      readonly defaultAutoApprove?: boolean;
      readonly autoReviewer?: AutoReviewer;
      readonly shieldModel?: ShieldModelChoice | null;
      readonly coordinatorStarting?: CoordinatorStartingChoice;
      readonly coordinatorStartingByProject?: CoordinatorStartingByProject;
      readonly coordinatorWorkerListing?: CoordinatorWorkerListing;
      readonly coordinatorWorkerListingByProject?: CoordinatorWorkerListingByProject;
      readonly coordinatorOpenWorkerLimit?: CoordinatorOpenWorkerLimit;
      readonly restartContinuation?: boolean;
      readonly windowsTerminalShell?: WindowsTerminalShell;
      readonly worktrees?: CodeWorktreeSettings;
    }): Promise<boolean> => {
      if (bootstrap === undefined) return false;
      const result = await execute({
        kind: "update-code-settings",
        expectedVersion: bootstrap.settings.version,
        ...input,
      });
      return result?.kind === "settings-updated";
    },
    [bootstrap, execute],
  );

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
      computerUseSelection?: ExtensionSelection,
      extensionSelections?: ReadonlyArray<ExtensionSelection>,
      sideChatReturns: ReadonlyArray<SideChatDraftReturnReference> = [],
      expectedDraftRevision?: number,
      reviewFindingReferences?: ReadonlyArray<CodeReviewFindingReference>,
      toolCatalogHandoff = false,
      contextInputPolicy?: ConversationInputPolicy,
      /**
       * Set for a message composed outside the composer, such as a turn's line
       * notes: the composer's own draft is neither read, cleared nor
       * overwritten, so its unsent text survives this send either way.
       * `onAccepted` fires once the host has accepted the message and started
       * its turn; the returned boolean also reports how that turn ended, and a
       * turn that later waits, stops or fails must not read as a refused send.
       */
      fromOutsideComposer?: {
        readonly onAccepted: () => void;
        readonly onRefused?: (message: string) => void;
        readonly pullRequestLineNotesSource?: CodePullRequestLineNotesSource;
      },
    ): Promise<boolean> => {
      const outsideComposer = fromOutsideComposer !== undefined;
      const trimmed = prompt.trim();
      const view = activeView?.thread.id === activeThreadId.current ? activeView : undefined;
      if (trimmed.length === 0 || view === undefined) return false;
      if (turnStatus === "sending" || turnStatus === "running") return false;

      clearFailure();
      setTurnError(undefined);
      setTurnUsageLimit(undefined);
      setLatestProviderTurnOperationId(undefined);
      setTurnStatus("sending");
      const sendingThreadId = String(view.thread.id);
      const draftRevisionAtDispatch =
        expectedDraftRevision ?? composerDraftRef.current.revisionFor(sendingThreadId);
      const previousDraft = composerDraftRef.current.readFor(sendingThreadId);
      if (!outsideComposer && previousDraft?.reviewFindingReferencesInvalid) {
        setTurnStatus("failed");
        setTurnError(
          "The saved review reference is unavailable. Reopen Review or explicitly clear this draft before sending.",
        );
        return false;
      }
      const reviewReferences =
        reviewFindingReferences ??
        (!outsideComposer && previousDraft?.text.trim() === trimmed
          ? (previousDraft.reviewFindingReferences ?? [])
          : []);
      let internalClearRan = false;
      const restoreFailedPrompt = () => {
        if (outsideComposer) return;
        const currentRevision = composerDraftRef.current.revisionFor(sendingThreadId);
        if (
          currentRevision !== draftRevisionAtDispatch &&
          (!internalClearRan || currentRevision !== draftRevisionAtDispatch + 1)
        ) {
          return;
        }
        composerDraftRef.current.restoreFor(sendingThreadId, {
          ...previousDraft,
          text: trimmed,
          caretIndex: previousDraft?.caretIndex ?? trimmed.length,
          stagedDropped: previousDraft?.stagedDropped === true,
        });
      };
      const userMessage: CodeConversationMessage = {
        id: globalThis.crypto.randomUUID(),
        role: "user",
        text: trimmed,
        checkoutId: view.checkout.id,
        ...(reviewReferences.length === 0 ? {} : { reviewFindingReferences: reviewReferences }),
        ...(threadMentionIds.length === 0 ? {} : { threadMentionIds }),
        providerInstanceId: view.thread.providerInstanceId,
        modelId: view.thread.modelId,
        at: new Date().toISOString(),
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(executionPolicy === undefined ? {} : { executionPolicy }),
      };

      turnAbort.current?.abort();
      const controller = new AbortController();
      turnAbort.current = controller;
      const assistantId = globalThis.crypto.randomUUID();

      try {
        const { operationId, started } = await beginProviderTurn({
          ...(contextInputPolicy === undefined ? {} : { contextInputPolicy }),
          threadId: view.thread.id,
          checkoutId: view.checkout.id,
          prompt: trimmed,
          ...(toolCatalogHandoff ? { toolCatalogHandoff: true } : {}),
          // Only the composer's own send can claim it: text a button composed
          // (a turn's line notes) arrives through `fromOutsideComposer`.
          ...(outsideComposer
            ? {}
            : typedClaimFor(threadDraftScope("code", String(view.thread.id)), trimmed)),
          threadMentionIds,
          sideChatReturns,
          reviewFindingReferences: reviewReferences,
          ...(fromOutsideComposer?.pullRequestLineNotesSource === undefined
            ? {}
            : { pullRequestLineNotesSource: fromOutsideComposer.pullRequestLineNotesSource }),
          attachmentIds: attachments.map((attachment) => attachment.attachmentId),
          fileMentionPaths,
          ...(computerUseSelection === undefined ? {} : { computerUseSelection }),
          ...(extensionSelections === undefined || extensionSelections.length === 0
            ? {}
            : { extensionSelections: [...extensionSelections] }),
          ...(executionPolicy === undefined ? {} : { executionPolicy }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return false;
        if (started.kind === "operation-failed") {
          setTurnStatus("failed");
          setTurnError(started.failure.message, { category: started.failure.category });
          setTurnUsageLimit(started.failure.usageLimit);
          setLatestProviderTurnOperationId(undefined);
          restoreFailedPrompt();
          fromOutsideComposer?.onRefused?.(started.failure.message);
          return false;
        }
        if (started.kind !== "provider-turn-state" || started.state !== "running") {
          setTurnStatus("failed");
          const refusal =
            started.kind === "provider-turn-state" ? started.failure?.message : undefined;
          const message = refusal ?? "The provider turn could not be started.";
          setTurnError(
            message,
            started.kind === "provider-turn-state" && started.failure !== undefined
              ? { category: started.failure.category }
              : undefined,
          );
          if (started.kind === "provider-turn-state") {
            setTurnUsageLimit(started.failure?.usageLimit);
            setLatestProviderTurnOperationId(
              started.failure?.usageLimit === undefined ? undefined : operationId,
            );
          }
          restoreFailedPrompt();
          fromOutsideComposer?.onRefused?.(message);
          return false;
        }
        // The running turn's identity is what Stop names, so a Stop that lands
        // after this turn is replaced cannot stop the next one.
        sentTurnStreaming.current = String(operationId);
        activeTurnOperations.current.set(String(view.thread.id), {
          operationId,
          status: "running",
        });
        setTurnStatus("running");
        fromOutsideComposer?.onAccepted();
        // A steered send may have emptied the composer so the user can keep
        // typing. Clearing here is safe only when no draft revision landed
        // after this dispatch.
        if (
          delayed !== true &&
          !outsideComposer &&
          composerDraftRef.current.revisionFor(sendingThreadId) === draftRevisionAtDispatch
        ) {
          composerDraftRef.current.clearFor(sendingThreadId);
          internalClearRan = true;
        }
        setConversation((current) => [
          // A read that landed before the host answered may already show the
          // host's copy of this turn; the rows this send streams replace it.
          ...current.filter(
            (message) =>
              message.operationId === undefined ||
              String(message.operationId) !== String(operationId),
          ),
          { ...userMessage, operationId },
          {
            id: assistantId,
            role: "assistant",
            checkoutId: view.checkout.id,
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
        let assistantAt: string | undefined;
        let assistantText = "";
        let reasoningText = "";
        const replyBeat = createReplyBeat(() => {
          if (assistantText.length > 0) {
            const nextText = assistantText;
            setConversation((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, text: nextText } : message,
              ),
            );
          }
          if (reasoningText.length > 0) noteReasoning(operationId, reasoningText);
        });
        let terminal = false;
        // No conversation read follows a turn this window sent, so its end
        // reads what the person sent into it, for a read that failed while it
        // ran. A waiting turn may go on, so it stays the running one.
        const endSentTurn = (status: "waiting" | "interrupted" | "failed" | "completed") => {
          void readSteeredMessages();
          const key = String(view.thread.id);
          if (
            status !== "waiting" &&
            activeTurnOperations.current.get(key)?.operationId === operationId
          )
            activeTurnOperations.current.delete(key);
        };
        const settleActiveTurn = (
          status: "waiting" | "interrupted" | "failed",
          message: string,
          category?: CodeOperationFailure["category"],
        ) => {
          endSentTurn(status);
          // The turn ended: what the beat still holds belongs in the row the
          // person is looking at, not one flush away.
          replyBeat.flush();
          setTurnStatus(
            status === "waiting" ? "waiting" : status === "interrupted" ? "interrupted" : "failed",
          );
          if (status !== "waiting") setProviderRequests([]);
          // The same sentence lands on this turn's assistant row below when
          // the provider did not already leave a partial reply.
          setTurnError(message, {
            inTranscript: assistantText.trim().length === 0,
            ...(category === undefined ? {} : { category }),
          });
          restoreFailedPrompt();
          setConversation((current) =>
            current.map((entry) =>
              entry.id === assistantId
                ? {
                    ...entry,
                    ...(assistantAt === undefined ? {} : { at: assistantAt }),
                    text: entry.text.trim().length > 0 ? entry.text : message,
                    status,
                  }
                : entry,
            ),
          );
        };
        try {
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
              assistantAt = frame.occurredAt;
              const event = frame.event;
              noteProviderRequest(event, (contentId) =>
                readOperationText(
                  client,
                  view.thread.id,
                  operationId,
                  contentId,
                  controller.signal,
                ),
              );
              noteActivity(operationId, event);
              noteUsage(operationId, event);
              // The checkpoint is only known once the host has taken it, so the
              // message the user already sees gains its restore point here
              // rather than waiting for the thread to be reopened.
              if (event.kind === "conversation-turn-started") {
                const checkpoint = event.checkpoint;
                const ranUnder = event.executionPolicy;
                setConversation((current) =>
                  current.map((entry) =>
                    entry.id === userMessage.id
                      ? {
                          ...entry,
                          at: frame.occurredAt,
                          ...(checkpoint === undefined ? {} : { checkpoint }),
                          ...(ranUnder === undefined ? {} : { executionPolicy: ranUnder }),
                          ...(event.checkoutId === undefined
                            ? {}
                            : { checkoutId: event.checkoutId }),
                        }
                      : entry.id === assistantId
                        ? { ...entry, startedAt: frame.occurredAt }
                        : entry,
                  ),
                );
              }
              // The host journals the change list just before the turn settles,
              // so the reply gains its files here rather than on the next reopen.
              const updateReply = codeReplyMetadataUpdate(event, frame.occurredAt);
              if (updateReply !== undefined) {
                setConversation((current) =>
                  current.map((message) =>
                    message.id === assistantId ? updateReply(message) : message,
                  ),
                );
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
                if (chunk !== undefined) {
                  reasoningText += chunk;
                  replyBeat.schedule();
                }
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
                  replyBeat.schedule();
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
                          ? "Reply to continue."
                          : `Provider turn ${event.state}.`),
                      event.failure?.category,
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
                        ? "Reply to continue."
                        : `Provider turn ${event.result.state}.`,
                      event.result.failure?.category,
                    );
                    return false;
                  }
                } else if (event.result.kind === "operation-failed") {
                  terminal = true;
                  settleActiveTurn(
                    "failed",
                    event.result.failure.message,
                    event.result.failure.category,
                  );
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
        } finally {
          if (sentTurnStreaming.current === String(operationId)) {
            sentTurnStreaming.current = undefined;
          }
          // Every exit that did not settle the beat leaves whatever text and
          // reasoning arrived in the row the person can see.
          replyBeat.flush();
        }
        setProviderRequests([]);
        replyBeat.flush();
        if (controller.signal.aborted) return false;
        endSentTurn("completed");
        setConversation((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: "completed",
                  ...(assistantAt === undefined ? {} : { at: assistantAt }),
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
        fromOutsideComposer?.onRefused?.(failure.message);
        failCommand(error);
        return false;
      }
    },
    [
      activeView,
      beginProviderTurn,
      clearFailure,
      client,
      failCommand,
      readSteeredMessages,
      turnStatus,
    ],
  );

  /**
   * Sends line notes written on a pull request's diff to one linked Code
   * thread as an ordinary follow-up turn. When the linked thread is open in
   * this controller it reuses `sendFollowUp` (keeping the composer draft
   * untouched); otherwise it dispatches directly through `beginProviderTurn`
   * so the person does not have to leave the pull request view first.
   */
  const sendPullRequestLineNotes = useCallback(
    async (
      threadId: CodeThreadId,
      prompt: string,
      source: CodePullRequestLineNotesSource,
    ): Promise<CodeLineNotesSendResult> => {
      const text = prompt.trim();
      if (text.length === 0) {
        return { status: "refused", message: "Write a note first." };
      }
      if (
        activeView !== undefined &&
        String(activeView.thread.id) === String(threadId) &&
        activeThreadId.current === activeView.thread.id
      ) {
        if (turnStatus === "sending" || turnStatus === "running") {
          return {
            status: "refused",
            message: "Send when the current turn finishes.",
          };
        }
        return new Promise((resolve) => {
          let settled = false;
          const accept = () => {
            if (settled) return;
            settled = true;
            resolve({ status: "sent" });
          };
          const refuse = (message: string) => {
            if (settled) return;
            settled = true;
            resolve({ status: "refused", message });
          };
          sendFollowUp(
            text,
            [],
            [],
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            [],
            false,
            undefined,
            {
              onAccepted: accept,
              onRefused: refuse,
              pullRequestLineNotesSource: source,
            },
          )
            .then((sent) => {
              if (settled) return;
              if (sent) accept();
              else refuse("The thread did not accept the notes; its reason shows there.");
            })
            .catch((error) => {
              if (!settled) refuse(codeFailure(error).message);
            });
        });
      }
      let checkoutId = findCodeThread(bootstrapRef.current?.threads, threadId)?.checkoutId;
      if (checkoutId === undefined) {
        try {
          const view = await client.thread(threadId);
          checkoutId = view.checkout.id;
        } catch (error) {
          return { status: "refused", message: codeFailure(error).message };
        }
      }
      try {
        const { started } = await beginProviderTurn({
          threadId,
          checkoutId,
          prompt: text,
          pullRequestLineNotesSource: source,
        });
        if (started.kind === "operation-failed") {
          return { status: "refused", message: started.failure.message };
        }
        if (started.kind !== "provider-turn-state" || started.state !== "running") {
          const refusal =
            started.kind === "provider-turn-state" ? started.failure?.message : undefined;
          return {
            status: "refused",
            message: refusal ?? "The provider turn could not be started.",
          };
        }
        return { status: "sent" };
      } catch (error) {
        return { status: "refused", message: codeFailure(error).message };
      }
    },
    [activeView, beginProviderTurn, client, sendFollowUp, turnStatus],
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
                ...(answer.rememberForProject === true ? { rememberForProject: true } : {}),
              })
            : answer.secret === true
              ? await client.executeOperation({
                  kind: "answer-provider-input",
                  ...scope,
                  requestId: answer.requestId,
                  secretAnswer: answer.response,
                })
              : await client.executeOperation({
                  kind: "answer-provider-input",
                  ...scope,
                  requestId: answer.requestId,
                  response: await client.putEvidence(view.thread.id, answer.response),
                });
        if (!mounted.current) return false;
        // A refusal can arrive as a failed or interrupted turn state rather
        // than `operation-failed`; the request stays so the person sees why.
        const outcome = providerAnswerOutcome(result);
        if (outcome.status === "refused") {
          setTurnError(outcome.message);
          setRefusedAnswer({ requestKey: providerAnswerKey(answer), message: outcome.message });
          return false;
        }
        const answeredKey = providerAnswerKey(answer);
        setRefusedAnswer((current) => (current?.requestKey === answeredKey ? undefined : current));
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
        const message = codeFailure(error).message;
        setTurnError(message);
        setRefusedAnswer({ requestKey: providerAnswerKey(answer), message });
        return false;
      }
    },
    [activeView, client],
  );

  const forceStopTurn = useCallback(async (): Promise<boolean> => {
    const view = activeView;
    if (view === undefined || latestProviderTurnOperationId === undefined) return false;
    const owner = String(view.thread.id);
    try {
      const result = await client.executeOperation({
        kind: "force-stop-provider-turn",
        operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
        threadId: view.thread.id,
        checkoutId: view.checkout.id,
        turnOperationId: latestProviderTurnOperationId,
      });
      if (result.kind === "provider-turn-state" && result.state === "interrupted") return true;
      if (mounted.current && String(activeThreadId.current) === owner)
        setTurnError(
          result.kind === "operation-failed"
            ? result.failure.message
            : result.kind === "provider-turn-state"
              ? (result.failure?.message ?? "The attempt could not be force-stopped.")
              : "The host refused Force stop.",
        );
    } catch (error) {
      if (mounted.current && String(activeThreadId.current) === owner)
        setTurnError(codeFailure(error).message);
    }
    return false;
  }, [activeView, client, latestProviderTurnOperationId]);

  const cancelTurn = useCallback(async (): Promise<boolean> => {
    const view = activeView;
    if (view === undefined || turnStatus !== "running") {
      return false;
    }
    const cancellationThreadId = String(view.thread.id);
    const stoppingTurn = activeTurnOperations.current.get(cancellationThreadId)?.operationId;
    const scope = {
      operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
      threadId: view.thread.id,
      checkoutId: view.checkout.id,
    } as const;
    const setCancellationError = (message: string) => {
      if (mounted.current && String(activeThreadId.current) === cancellationThreadId) {
        setTurnError(message);
      }
    };
    try {
      const result = await client.executeOperation({
        kind: "cancel-provider-turn",
        ...scope,
        // Naming the turn keeps a Stop that lands after this turn was replaced
        // from stopping the one that replaced it. A turn this window has not
        // learned the identity of yet is stopped as before.
        ...(stoppingTurn === undefined ? {} : { turnOperationId: stoppingTurn }),
      });
      if (result.kind === "operation-failed") {
        setCancellationError(result.failure.message);
        return false;
      }
      // The host answers a Stop its runtime has not confirmed within its bound
      // with the turn still running and a reason; without showing it, a turn
      // the host holds until its runtime really ends just looks stuck.
      if (result.kind === "provider-turn-state" && result.failure !== undefined) {
        setCancellationError(result.failure.message);
      }
      return true;
    } catch (error) {
      setCancellationError(codeFailure(error).message);
      return false;
    }
  }, [activeView, client, turnStatus]);

  const shownConversation = useMemo(
    () => withSteeredMessages(conversation, steeredMessages),
    [conversation, steeredMessages],
  );
  // The Load earlier row's state, or undefined for a thread with nothing earlier.
  const earlierRow = useMemo(
    () =>
      earlierRowState(
        earlierConversation,
        conversation,
        activeView?.thread.id === options.activeThreadId
          ? activeView?.thread.forkedFrom
          : undefined,
      ),
    [activeView, conversation, earlierConversation, options.activeThreadId],
  );
  // A retry issued from a thread view is asking for that thread back, not
  // only for a fresh thread list: a hydration failure leaves the transcript
  // in its error state until the thread is activated again, and nothing else
  // re-activates a tab that is already open.
  const retry = useCallback(async () => {
    const reachable = await loadBootstrap("retry");
    // Fired, not awaited: activation runs the thread's event stream until
    // the thread is left, so its promise settles far after the retry does.
    if (reachable && options.activeThreadId !== undefined) {
      void activateThread(options.activeThreadId);
    }
  }, [activateThread, loadBootstrap, options.activeThreadId]);
  // Offered only while both the view's checkout and the thread record name the
  // checkout the point is bound to: a rebind reaches the thread record before
  // the thread is read again and its new checkout installed.
  const restoreUndo =
    restorePoint !== undefined &&
    restorePoint.checkoutId === String(activeView?.checkout.id) &&
    restorePoint.checkoutId === String(activeView?.thread.checkoutId)
      ? restorePoint.checkpoint
      : undefined;
  // One identity while nothing in it moved, so the surfaces that take the
  // controller whole can bail out of a render that changed none of it.
  const returnedDraftFacts: {
    readonly draftSideChatReturns?: ReadonlyArray<SideChatDraftReturnReference>;
    readonly draftSideChatReturnsInvalid?: boolean;
    readonly draftReviewFindingReferences?: ReadonlyArray<CodeReviewFindingReference>;
    readonly draftReviewFindingReferencesInvalid?: boolean;
    readonly draftRevision?: number;
    readonly readDraftRevision?: (threadId: string) => number;
    readonly restoreComposerDraft?: typeof composerDraft.restoreFor;
  } = {
    draftSideChatReturns: composerDraft.sideChatReturns,
    draftSideChatReturnsInvalid: composerDraft.sideChatReturnsInvalid,
    draftReviewFindingReferences: composerDraft.reviewFindingReferences,
    draftReviewFindingReferencesInvalid: composerDraft.reviewFindingReferencesInvalid,
    draftRevision: composerDraft.revisionFor(String(options.activeThreadId ?? "")),
    readDraftRevision: composerDraft.revisionFor,
    restoreComposerDraft: composerDraft.restoreFor,
  };
  return useRetainedRecord({
    activeView: activeView?.thread.id === options.activeThreadId ? activeView : undefined,
    accessNotice,
    setAccessNotice,
    announceFirstPrompt,
    answerProviderRequest,
    cancelTurn,
    forceStopTurn,
    archiveThread,
    completeThread,
    reopenThread,
    markThreadDone,
    unlinkPullRequest,
    snoozeThread,
    wakeThread,
    moveThread,
    sendBackTurn,
    bootstrap,
    client,
    conversation: shownConversation,
    /** The Load earlier row's state, or undefined for a thread with nothing earlier. */
    earlierConversation: earlierRow,
    loadEarlierConversation,
    completeFollowUp,
    errorCategory,
    errorMessage,
    firstPromptInFlight: conversationStarted ? undefined : firstPromptInFlight,
    followUps,
    forkThread,
    mergeForkContext,
    lastExecuteError,
    lastStartRefusal,
    editorDrafts,
    execute,
    markFollowUp,
    markThreadRead,
    navigation,
    pendingDraft,
    pendingDraftCaret: composerDraft.caretIndex,
    draftStagedDropped: composerDraft.stagedDropped,
    ...returnedDraftFacts,
    draftPersistError: composerDraft.persistError,
    markDraftStagedDropped: composerDraft.markStagedDropped,
    purgeThreadDraft: composerDraft.purge,
    pinThread,
    setThreadCoordinator,
    setThreadCoordinatorBounds,
    setThreadCoordinatorDoneWhen,
    setThreadCoordinatorWake,
    setThreadMessageWake,
    setThreadRestartContinuation,
    rebindThreadCheckout,
    reloadThreadView,
    renameThread,
    providerRequests,
    providerAnswerRefusal,
    refreshFollowUp,
    refreshConversation,
    refreshNavigation,
    restoreUndo,
    noteRestoreUndo,
    // A retry issued from a thread view is asking for that thread back, not
    // only for a fresh thread list: a hydration failure leaves the transcript
    // in its error state until the thread is activated again, and nothing else
    // re-activates a tab that is already open.
    retry,
    conversationHistory,
    keepThread,
    sendFollowUp,
    sendPullRequestLineNotes,
    setPendingDraft,
    setPendingDraftCaret,
    showTurnRefusal,
    writePendingDraftFor,
    startThreadTurn,
    status,
    threadUsage,
    turnActivity,
    turnError,
    turnErrorCategory,
    turnErrorInTranscript,
    turnStatus,
    turnUsageLimit,
    latestProviderTurnOperationId,
    updateSettings,
  });
}

type CodeControllerResult = ReturnType<typeof useCodeController>;
export type CodeController = Omit<CodeControllerResult, "keepThread" | "writePendingDraftFor"> & {
  /** Optional for injected fixtures, which have no transcript to come back to. */
  readonly keepThread?: CodeControllerResult["keepThread"];
  /** Optional for injected fixtures and hosts that do not persist drafts by thread. */
  readonly writePendingDraftFor?: (threadId: string, value: string) => void;
};

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("Code controller requires launch authority.");
  return value;
}

function providerRequestKey(request: CodeProviderRequest): string {
  return request.kind === "approval"
    ? `approval:${String(request.approvalId)}`
    : `input:${request.requestId}`;
}

function providerAnswerKey(answer: CodeProviderAnswer): string {
  return answer.kind === "approval"
    ? `approval:${String(answer.approvalId)}`
    : `input:${answer.requestId}`;
}

/** A reply gains each merge its turn carried once, however often the event replays. */
