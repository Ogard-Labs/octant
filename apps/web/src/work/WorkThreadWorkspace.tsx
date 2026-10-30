import { threadCompactionSubject } from "../context/CompactionDivider";
import { useComposerCompacting } from "../context/composerContextMeterScope";
import { ComposerAttachButton } from "../composer/ComposerAttachButton";
import {
  decodeWorkAttachmentId,
  decodeWorkAttachmentMediaType,
  decodeThreadWorkingDirectory,
  decodeWorkMutationRequestId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type ProviderModelOptionValues,
  type ThreadDocumentDelivery,
  type UsageResumeThreadState,
  type WorkAttachmentId,
  type WorkRequest,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnRequestId,
  type WorkTurnId,
  type WorkTurnState,
  type WorkTurnStreamFrame,
  type HarnessRetryNotice,
} from "@octant/contracts";
import type { ProjectSummary, ProjectId } from "@octant/contracts/projects";
import type { BrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import {
  prependEarlierTurns,
  refreshNewestTurns,
  startedConversationPickerGroups,
  type PickerGroup,
} from "@octant/domain";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import {
  WorkTurnClientFailure,
  type WorkTurnClient,
} from "@octant/client-runtime/work-turn-client";
import type { FileMentionClient, ThreadMentionClient } from "@octant/client-runtime";
import { announceShellSettingsWritten } from "../shell/shellSettingsNotifications";
import { Check, CirclePause, Ellipsis, FileText, FolderOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  applyComposerCaret,
  COMPOSER_STAGED_DROPPED_NOTE,
  type ComposerThreadDraftStore,
} from "../composer/composerThreadDraftStore";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import { useThreadMessageQueue } from "../messageQueue/useThreadMessageQueue";
import { ThreadMessageQueue } from "../messageQueue/ThreadMessageQueue";
import type { ThreadMessageQueueClient } from "../messageQueue/threadMessageQueueClient";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { OctantMenu } from "../ui/base/OctantMenu";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ComposerVoiceButton } from "../voice/ComposerVoiceButton";
import { appendTranscript } from "../voice/appendTranscript";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView } from "@octant/contracts";
import { decodeBrowserThreadId, decodeImageGenerationScopeId } from "@octant/contracts";
import { BrowserCaptureList } from "../browser/BrowserCaptureList";
import { GeneratedImageList } from "../image/GeneratedImageList";
import { ImageGenerationAction } from "../image/ImageGenerationAction";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { CanvasThreadReferenceCardList } from "../canvas/CanvasThreadReferenceCardList";
import { ThreadCanvases } from "../canvas/InlineThreadCanvas";
import {
  ThreadArtifactsConfirm,
  ThreadArtifactsOffer,
  threadArtifactsOfferRow,
  threadMayChooseArtifacts,
} from "../canvas/ThreadArtifactsChoice";
import { publishedSnapshotRunRuntimeFor } from "../canvas/blocks/designRunningFrame";
import { placeThreadCanvases, threadTurnSpans } from "../canvas/threadCanvasPlacement";
import { useThreadCanvasCards } from "../canvas/useThreadCanvasCards";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../chat/ThreadMentionPicker";
import { useThreadMentions } from "../chat/useThreadMentions";
import { useComposerThreadDropRegistration } from "../chat/composerThreadDrop";
import { clipboardHasImage } from "../chat/composerImagePaste";
import { PathMentionTypeahead } from "../code/CodePathMentionPicker";
import { selectedModelReadsImages, useWorkComposerImages } from "./composer/useWorkComposerImages";
import { WorkImageAttachmentChips } from "./composer/WorkImageAttachmentChips";
import { useWorkFileMentions } from "./useWorkFileMentions";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { TrackerReferenceComposerHints } from "../tracker/TrackerReferenceComposerHints";
import { TrackerReferenceText } from "../tracker/TrackerReferenceText";
import { ChildResultCards } from "../agents/ChildResultCards";
import { AssistantMessageBody } from "../transcript/AssistantMessageBody";
import {
  documentIsVisible,
  scheduleVisibleInterval,
  waitUntilDocumentVisible,
} from "../polling/documentVisibility";
import { TranscriptWindow } from "../transcript/TranscriptWindow";
import {
  LoadEarlierMessages,
  type LoadEarlierMessagesState,
} from "../transcript/LoadEarlierMessages";
import { ThreadTasksPanel } from "../transcript/ThreadTasksPanel";
import { TurnActivityRows } from "../transcript/TurnActivityRows";
import { toolStepsActivity } from "../transcript/turnActivity";
import { ProviderApprovalPrompt } from "../transcript/ProviderApprovalPrompt";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { ExtensionToolApprovalPrompt } from "../extensions/ExtensionToolApprovalPrompt";
import { ProviderQuestionCard } from "../transcript/ProviderQuestionCard";
import { UsageLimitNotice } from "../transcript/UsageLimitNotice";
import {
  TurnHeader,
  TurnTime,
  turnWorkedFor,
  type TurnHeaderOutcome,
} from "../transcript/TurnHeader";
import { HarnessRetryStatus, type HarnessRetryStreamEvent } from "../transcript/HarnessRetryStatus";
import {
  pendingThreadHandoffNotice,
  threadHandoffDisclosure,
} from "../providers/conversationHandoff";
import { providerModelLabel } from "../providers/providerModelLabel";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { providerFamilyForThread } from "../providers/providerFamily";
import { useExtensionDraftSelections } from "../chat/useExtensionDraftSelections";
import {
  ComposerSlashTypeahead,
  useComposerSlashCommands,
} from "../composer/useComposerSlashCommands";
import { useComposerSuggestionInput } from "../composer/useComposerSuggestionInput";

/** Only the person's messages carry a time here; the rows after one share it. */
function workRowHappenedAt(row: WorkTranscriptRow): string | undefined {
  return row.kind === "message" ? row.at : undefined;
}

type WorkTranscriptRow =
  | { readonly kind: "empty"; readonly key: "empty" }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly entry: WorkTurnState["transcript"][number];
      readonly streaming: boolean;
      /** When the person's message was accepted; assistant entries carry the time on their header. */
      readonly at?: string;
      /** The host wrote this user entry to carry a subagent's result into the thread. */
      readonly delivered?: true;
      /** The turn header, when this is the turn's first reply and so opens with it. */
      readonly head?: WorkTurnState;
    }
  | { readonly kind: "request"; readonly key: string; readonly request: WorkRequest }
  | {
      readonly kind: "files";
      readonly key: string;
      readonly wrote: NonNullable<WorkTurnState["wroteFiles"]>;
    }
  | {
      readonly kind: "tasks";
      readonly key: string;
      readonly turn: WorkTurnState;
      readonly tasks: NonNullable<WorkTurnState["tasks"]>;
    }
  | { readonly kind: "status"; readonly key: "status"; readonly text: string }
  | {
      readonly kind: "head";
      readonly key: string;
      readonly turn: WorkTurnState;
    };

const WORK_TRANSCRIPT_RECONNECTING_MESSAGE = "Work transcript is reconnecting.";

/** How many turns a Work thread opens on, and how many each Load earlier adds. */
const WORK_TRANSCRIPT_PAGE_TURNS = 30;

/**
 * The newest page of a Work thread, read through the window route, or through
 * the whole-transcript route from a host that has no window route. That host
 * answers with everything it will send, so nothing earlier is offered.
 */
interface WorkNewestTurns {
  readonly turns: ReadonlyArray<WorkTurnState>;
  readonly liveCursor: number;
  readonly hasEarlier: boolean;
}

/**
 * What this view holds of one thread: one run of turns that ends at the
 * newest. `offerEarlier` stays set once the thread has offered earlier
 * messages, so the Load earlier row keeps its place after the last page.
 */
interface WorkLoadedTurns {
  readonly threadKey: string | undefined;
  readonly turns: ReadonlyArray<WorkTurnState>;
  readonly hasEarlier: boolean;
  readonly offerEarlier: boolean;
}

const NO_LOADED_TURNS: WorkLoadedTurns = {
  threadKey: undefined,
  turns: [],
  hasEarlier: false,
  offerEarlier: false,
};

const workTurnKey = (turn: WorkTurnState) => String(turn.requestId);

/** Clients that already answered 404 for the window route; asked once per client. */
const clientsWithoutWorkWindow = new WeakSet<WorkTurnClient>();

async function readNewestWorkTurns(
  client: WorkTurnClient,
  threadId: WorkThreadId,
  signal: AbortSignal,
): Promise<WorkNewestTurns> {
  // A test double or an older client may not carry the window read at all.
  if (typeof client.transcriptWindow === "function" && !clientsWithoutWorkWindow.has(client)) {
    try {
      const window = await client.transcriptWindow(
        threadId,
        { limit: WORK_TRANSCRIPT_PAGE_TURNS },
        signal,
      );
      return { turns: window.turns, liveCursor: window.liveCursor, hasEarlier: window.hasEarlier };
    } catch (error) {
      if (!(error instanceof WorkTurnClientFailure && error.status === 404)) throw error;
      clientsWithoutWorkWindow.add(client);
    }
  }
  const transcript = await client.transcript(threadId, signal);
  return { turns: transcript.turns, liveCursor: transcript.liveCursor, hasEarlier: false };
}

/** Join a newest read onto what the view holds, keeping earlier pages when they still touch. */
function withNewestWorkTurns(
  current: WorkLoadedTurns,
  threadKey: string,
  newest: WorkNewestTurns,
): WorkLoadedTurns {
  if (current.threadKey !== threadKey) {
    return {
      threadKey,
      turns: newest.turns,
      hasEarlier: newest.hasEarlier,
      offerEarlier: newest.hasEarlier,
    };
  }
  const refreshed = refreshNewestTurns(current.turns, newest.turns, workTurnKey);
  const turns = samePollingData(current.turns, refreshed.turns) ? current.turns : refreshed.turns;
  const hasEarlier = refreshed.kind === "spliced" ? current.hasEarlier : newest.hasEarlier;
  if (turns === current.turns && hasEarlier === current.hasEarlier) return current;
  return { threadKey, turns, hasEarlier, offerEarlier: current.offerEarlier || hasEarlier };
}

/**
 * The turn header: it opens the turn's first reply, or stands alone when the
 * turn ended without one. A turn the provider stopped on its own usage-limit
 * signal also speaks in the notice beside it — the header's reason line is
 * the failure's words; the notice is the provider-reported fact about why.
 */
function WorkTurnHeader(props: {
  readonly copyValue?: string;
  readonly turn: WorkTurnState;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  /** Puts the stopped turn's prompt back in the composer to send again. */
  readonly onRestorePrompt?: (prompt: string) => void;
  readonly usageResume?: UsageResumeThreadState;
  readonly resumable?: boolean;
  readonly onScheduleResume?: (turnId: WorkTurnId) => void;
  readonly onCancelResume?: () => void;
  /** Hides the thread until this stop's declared reset; no provider turn. */
  readonly onSnoozeAtReset?: () => void;
}) {
  const outcome = turnHeaderOutcome(props.turn);
  const usageLimit = props.turn.failure?.usageLimit;
  const workedFor = turnWorkedFor(outcome, props.turn.acceptedAt, props.turn.updatedAt);
  return (
    <>
      <TurnHeader
        at={props.turn.updatedAt}
        copyValue={props.copyValue}
        outcome={outcome}
        provider={providerModelLabel(props.providerGroups, props.turn.authority)}
        {...(workedFor === undefined ? {} : { workedFor })}
        {...(props.turn.failure === undefined ? {} : { reason: props.turn.failure.message })}
      />
      {props.turn.handoff === undefined ? null : (
        <p className="work-thread-workspace__handoff" role="note">
          {threadHandoffDisclosure(props.turn.handoff, (selection) =>
            providerModelLabel(props.providerGroups, selection),
          )}
        </p>
      )}
      {usageLimit === undefined ? null : (
        <UsageLimitNotice
          limit={usageLimit}
          provider={providerModelLabel(props.providerGroups, props.turn.authority)}
          {...(props.usageResume === undefined ? {} : { usageResume: props.usageResume })}
          {...(props.resumable === undefined ? {} : { resumable: props.resumable })}
          {...(props.onScheduleResume === undefined
            ? {}
            : {
                onScheduleResume: () => props.onScheduleResume?.(props.turn.turnId),
              })}
          {...(props.onCancelResume === undefined ? {} : { onCancelResume: props.onCancelResume })}
          {...(props.onSnoozeAtReset === undefined
            ? {}
            : { onSnoozeAtReset: props.onSnoozeAtReset })}
          {...(props.onRestorePrompt === undefined
            ? {}
            : {
                action: (
                  <OctantButton
                    onClick={() => props.onRestorePrompt?.(props.turn.prompt)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Edit and resend
                  </OctantButton>
                ),
              })}
        />
      )}
    </>
  );
}

/**
 * The turn's tool calls as the compact group Code uses. Open while the turn
 * runs; a settled turn folds behind "N tool calls" and shows a tool it never
 * saw end as unfinished.
 */
function WorkToolGroup(props: {
  readonly turn: WorkTurnState;
  readonly canvasClient?: CanvasClient;
}) {
  const activity = toolStepsActivity(props.turn.toolSteps, props.turn.toolStepsTruncated);
  if (activity === undefined) return null;
  const status = props.turn.status;
  const canvasClient = props.canvasClient;
  const threadId = String(props.turn.threadId);
  return (
    <TurnActivityRows
      activity={activity}
      publishedSnapshotRuntime={(toolCallId) =>
        publishedSnapshotRunRuntimeFor(canvasClient, { mode: "work", threadId, toolCallId })
      }
      running={status === "accepted" || status === "running"}
      settled={status === "completed" || status === "failed" || status === "cancelled"}
    />
  );
}

/**
 * Where a turn's header sits: before its first assistant entry, or after the
 * whole turn when no reply exists yet. A turn that ended without a reply used
 * to leave the transcript silent — the journal recorded the failure while the
 * surface showed only the user's own message — so the header is emitted for
 * every turn, reply or not.
 */
function turnHeaderOutcome(turn: WorkTurnState): TurnHeaderOutcome {
  switch (turn.status) {
    case "accepted":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "cancelled":
      return "cancelled";
    case "failed":
      // A turn the host ended because it restarted did not fail; it was cut off.
      return turn.failure?.category === "interrupted" ? "interrupted" : "failed";
    case "completed":
      return "completed";
  }
}

export interface WorkThreadWorkspaceProps {
  readonly title: string;
  readonly threadId: WorkThreadId;
  /** Machine-owned navigation snapshot; avoids rescanning every Project before transcript read. */
  readonly initialThread?: WorkThread;
  readonly projects?: ReadonlyArray<ProjectSummary>;
  readonly onDisplayReadyChange?: (ready: boolean) => void;
  readonly changeRevision?: number;
  readonly threadClient: WorkThreadClient;
  readonly turnClient?: WorkTurnClient;
  readonly requestClient?: WorkRequestClient;
  readonly browserAutomationClient?: BrowserAutomationClient;
  readonly mutationClient?: WorkMutationClient;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly threadMentionClient?: ThreadMentionClient;
  readonly fileMentionClient?: FileMentionClient;
  readonly canvasClient?: CanvasClient;
  readonly imageGenerationClient?: ImageGenerationClient;
  readonly imageGenerationProfiles?: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenSettings?: () => void;
  /** Opens Settings at Image generation, where an image profile is added. */
  readonly onOpenImageSettings?: () => void;
  readonly hostId?: HostId;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly messageQueueClient?: ThreadMessageQueueClient;
  readonly extensionClient?: ExtensionClient;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  /** Opens the dock's Canvas tool on this Canvas; a Canvas drawn in the thread offers it. */
  readonly onOpenCanvasInSidebar?: (card: CanvasThreadReferenceCard) => void;
  /** The Canvas cards the host lists for this thread, each time they are read. */
  readonly onCanvasReferencesObserved?: (
    threadId: string,
    cards: ReadonlyArray<CanvasThreadReferenceCard>,
  ) => void;
  readonly onThreadUpdated?: (thread: WorkThread) => void;
  readonly draftStore?: ComposerThreadDraftStore;
}

function artifactNameFromPrompt(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return "notes.md";
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug.length > 0 ? slug : "notes"}.md`;
}

function workRetryEvents(
  retries: ReadonlyMap<string, HarnessRetryNotice>,
  requestId: string,
): readonly HarnessRetryStreamEvent[] {
  const notice = retries.get(requestId);
  if (notice === undefined) return [];
  return [
    {
      kind: "retrying",
      attempt: notice.attempt,
      maxAttempts: notice.maxAttempts,
      delayMs: notice.delayMs,
      reason: notice.reason,
      announcedAt: notice.announcedAt,
    },
  ];
}

function applyWorkRetryFrame(
  current: ReadonlyMap<string, HarnessRetryNotice>,
  frame: WorkTurnStreamFrame,
): ReadonlyMap<string, HarnessRetryNotice> {
  if (frame.kind === "snapshot-required" || frame.kind === "turn-settled") {
    if (frame.kind === "turn-settled") {
      if (!current.has(String(frame.turn.requestId))) return current;
      const next = new Map(current);
      next.delete(String(frame.turn.requestId));
      return next;
    }
    return new Map();
  }
  if (frame.kind === "provider-retry") {
    const next = new Map(current);
    next.set(String(frame.requestId), {
      attempt: frame.attempt,
      maxAttempts: frame.maxAttempts,
      delayMs: frame.delayMs,
      reason: frame.reason,
      announcedAt: frame.announcedAt,
    });
    return next;
  }
  if (
    (frame.kind === "response-delta" || frame.kind === "provider-retry-cleared") &&
    current.has(String(frame.requestId))
  ) {
    const next = new Map(current);
    next.delete(String(frame.requestId));
    return next;
  }
  return current;
}

function applyWorkTurnStreamFrame(
  turns: ReadonlyArray<WorkTurnState>,
  frame: WorkTurnStreamFrame,
): ReadonlyArray<WorkTurnState> {
  if (frame.kind === "snapshot-required" || frame.kind === "compaction-settled") return turns;
  const index = turns.findIndex(
    (turn) =>
      String(turn.requestId) ===
      String(frame.kind === "turn-settled" ? frame.turn.requestId : frame.requestId),
  );
  if (frame.kind === "turn-settled") {
    if (index === -1) return [...turns, frame.turn];
    const next = turns.slice();
    next[index] = frame.turn;
    return next;
  }
  if (frame.kind === "turn-tasks") {
    if (index === -1) return turns;
    const current = turns[index];
    if (current === undefined) return turns;
    const next = turns.slice();
    next[index] = { ...current, tasks: frame.tasks };
    return next;
  }
  if (frame.kind === "turn-tools") {
    if (index === -1) return turns;
    const current = turns[index];
    if (current === undefined) return turns;
    const next = turns.slice();
    next[index] = {
      ...current,
      toolSteps: frame.toolSteps,
      ...(frame.toolStepsTruncated ? { toolStepsTruncated: true } : {}),
    };
    return next;
  }
  if (frame.kind === "provider-retry" || frame.kind === "provider-retry-cleared") return turns;
  if (index === -1) return turns;
  const current = turns[index];
  if (current === undefined) return turns;
  const assistantIndex = current.transcript.findIndex((entry) => entry.role === "assistant");
  const previousText = current.transcript[assistantIndex]?.text ?? current.response ?? "";
  const text = previousText + frame.text;
  const transcript = current.transcript.slice();
  const assistant = { role: "assistant" as const, text, status: "running" as const };
  if (assistantIndex === -1) transcript.push(assistant);
  else transcript[assistantIndex] = assistant;
  const next = turns.slice();
  next[index] = { ...current, status: "running", response: text, transcript };
  return next;
}

async function consumeWorkTurnStream(input: {
  readonly client: WorkTurnClient;
  readonly threadId: WorkThreadId;
  readonly afterSequence: number;
  readonly signal: AbortSignal;
  readonly active: () => boolean;
  readonly apply: (frame: WorkTurnStreamFrame) => void;
  readonly replace: (snapshot: WorkNewestTurns) => void;
}): Promise<void> {
  let cursor = input.afterSequence;
  let retryMs = 250;
  // A streamed response commits on beats, not per delta: every apply
  // re-renders the workspace and re-flattens the transcript, and a reply's
  // deltas arrive far faster than a frame paints. Deltas of one request
  // combine into one apply; a frame that supersedes them drops what it makes
  // stale, and any other frame flushes them first so fields merge in order.
  let pending:
    | { readonly requestId: WorkTurnRequestId; readonly sequence: number; text: string }
    | undefined;
  let beat: ReturnType<typeof setTimeout> | undefined;
  const clearBeat = () => {
    if (beat !== undefined) {
      clearTimeout(beat);
      beat = undefined;
    }
  };
  const flushPending = () => {
    clearBeat();
    if (pending === undefined) return;
    const delta = pending;
    pending = undefined;
    input.apply({
      kind: "response-delta",
      sequence: delta.sequence,
      threadId: input.threadId,
      requestId: delta.requestId,
      text: delta.text,
    });
  };
  try {
    while (input.active() && !input.signal.aborted) {
      try {
        let received = false;
        for await (const frame of input.client.subscribe(input.threadId, cursor, input.signal)) {
          if (!input.active() || input.signal.aborted) return;
          received = true;
          if (frame.kind === "snapshot-required") {
            const snapshot = await readNewestWorkTurns(input.client, input.threadId, input.signal);
            if (!input.active() || input.signal.aborted) return;
            // The replaced snapshot is the authority; pending deltas belong
            // to the stream it replaces.
            pending = undefined;
            clearBeat();
            input.replace(snapshot);
            cursor = snapshot.liveCursor;
            break;
          }
          cursor = frame.sequence;
          if (frame.kind === "response-delta") {
            if (pending !== undefined && String(pending.requestId) === String(frame.requestId)) {
              pending = { ...pending, text: pending.text + frame.text, sequence: frame.sequence };
            } else {
              flushPending();
              pending = {
                requestId: frame.requestId,
                sequence: frame.sequence,
                text: frame.text,
              };
            }
            if (beat === undefined) {
              beat = setTimeout(() => {
                beat = undefined;
                flushPending();
              }, STREAM_REPLY_BEAT_MS);
            }
            continue;
          }
          if (frame.kind === "turn-settled") {
            // The settled turn carries the whole response; pending deltas of
            // the same request are what it supersedes.
            if (
              pending !== undefined &&
              String(pending.requestId) === String(frame.turn.requestId)
            ) {
              pending = undefined;
              clearBeat();
            } else {
              flushPending();
            }
          } else {
            flushPending();
          }
          input.apply(frame);
        }
        retryMs = received ? 50 : Math.min(retryMs * 2, 2_000);
      } catch {
        if (!input.active() || input.signal.aborted) return;
        retryMs = Math.min(retryMs * 2, 2_000);
      }
      await waitForWorkStreamReconnect(input.signal, retryMs);
    }
  } finally {
    flushPending();
  }
}

/** How often a streaming Work reply commits its accumulated text: see consumeWorkTurnStream. */
const STREAM_REPLY_BEAT_MS = 50;

async function waitForWorkStreamReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function WorkThreadWorkspace(props: WorkThreadWorkspaceProps) {
  const [projectId, setProjectId] = useState<ProjectId | undefined>(props.initialThread?.projectId);
  const [thread, setThread] = useState<WorkThread | undefined>(props.initialThread);
  const composerDraft = useComposerThreadDraft({
    mode: "work",
    threadId: String(props.threadId),
    ...(props.draftStore === undefined ? {} : { store: props.draftStore }),
  });
  const prompt = composerDraft.text;
  const suggestionInput = useComposerSuggestionInput(prompt, (text) =>
    composerDraft.setDraft(text, text.length),
  );
  const providerFamily: ExtensionProviderFamily | undefined = providerFamilyForThread(
    props.providerGroups,
    thread?.providerInstanceId,
  );
  const extensionDraft = useExtensionDraftSelections({
    ...(props.extensionClient === undefined ? {} : { client: props.extensionClient }),
    mode: "work",
    projectId: thread?.projectId ?? projectId ?? null,
    threadId: thread?.id ?? props.threadId,
    ...(providerFamily === undefined ? {} : { providerFamily }),
  });
  const slash = useComposerSlashCommands({
    textarea: () => textareaRef.current,
    draft: composerDraft.text,
    onDraftChange: (next, caret) => composerDraft.setDraft(next, caret),
    onResolveExtensionReference: extensionDraft.resolveReference,
  });
  const [loaded, setLoaded] = useState<WorkLoadedTurns>(NO_LOADED_TURNS);
  const turns = loaded.turns;
  const setTurns = useCallback(
    (update: (current: ReadonlyArray<WorkTurnState>) => ReadonlyArray<WorkTurnState>) =>
      setLoaded((current) => {
        const next = update(current.turns);
        return next === current.turns ? current : { ...current, turns: next };
      }),
    [],
  );
  const [earlierState, setEarlierState] = useState<"idle" | "loading" | "failed">("idle");
  const earlierAbort = useRef<AbortController | undefined>(undefined);
  const [retries, setRetries] = useState<ReadonlyMap<string, HarnessRetryNotice>>(() => new Map());
  const [pendingRequests, setPendingRequests] = useState<ReadonlyArray<WorkRequest>>([]);
  const [browserApprovals, setBrowserApprovals] = useState<ReadonlyArray<BrowserToolApproval>>([]);
  const [browserApprovalBusy, setBrowserApprovalBusy] = useState(false);
  const [browserApprovalMessage, setBrowserApprovalMessage] = useState<string | undefined>(
    undefined,
  );
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [providerChanging, setProviderChanging] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completionFormOpen, setCompletionFormOpen] = useState(false);
  const changeDriven = props.changeRevision !== undefined;
  const transcriptGeneration = useRef(0);
  const initialThread = useRef(props.initialThread);
  if (String(props.initialThread?.id) === String(props.threadId)) {
    initialThread.current = props.initialThread;
  } else if (String(initialThread.current?.id) !== String(props.threadId)) {
    initialThread.current = undefined;
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentThreadKeyRef = useRef(String(props.threadId));
  currentThreadKeyRef.current = String(props.threadId);
  const mentionListId = useId();
  const fileMentionListId = useId();
  const trimmed = prompt.trim();
  const completionLocked = thread?.completionConfirmed === true;
  const [deliveryChanging, setDeliveryChanging] = useState(false);
  const [confirmArtifacts, setConfirmArtifacts] = useState(false);
  // The account must allow Claude artifacts for the thread to choose them; a
  // thread that already chose them can always go back to Canvas.
  const artifactsChoosable =
    thread !== undefined &&
    thread.lifecycle === "active" &&
    threadMayChooseArtifacts(props.providerGroups ?? [], thread.providerInstanceId, "work");
  const changeDocumentDelivery = async (documentDelivery: ThreadDocumentDelivery) => {
    if (thread === undefined || deliveryChanging) return;
    setDeliveryChanging(true);
    setErrorMessage(undefined);
    try {
      const result = await props.threadClient.execute({
        kind: "change-work-thread-document-delivery",
        threadId: thread.id,
        expectedVersion: thread.version,
        documentDelivery,
      });
      if (!("kind" in result) || result.kind !== "thread-updated") {
        setErrorMessage("This task’s document choice could not be saved.");
        return;
      }
      setThread(result.thread);
      props.onThreadUpdated?.(result.thread);
    } catch {
      setErrorMessage("This task’s document choice could not be saved.");
    } finally {
      setDeliveryChanging(false);
      setConfirmArtifacts(false);
    }
  };
  // The next turn starts a new session with the conversation handed over as
  // text when the selected provider keeps its own session and the latest turn
  // ran on another provider; the person hears that before sending.
  const handoffNotice =
    thread === undefined
      ? undefined
      : pendingThreadHandoffNotice({
          groups: props.providerGroups ?? [],
          selected: thread,
          latest: turns.at(-1)?.authority,
        });
  const messageQueue = useThreadMessageQueue({
    mode: "work",
    hostId: props.hostId,
    draft: {
      text: composerDraft.text,
      revision: composerDraft.revisionFor(String(props.threadId)),
      clear: composerDraft.clear,
    },
    onRecoveredRefused: async (command) => {
      if (command.kind !== "enqueue" || command.payload.mode !== "work") return;
      await Promise.allSettled(
        (command.payload.attachmentIds ?? []).map((attachmentId) =>
          props.turnClient?.discardAttachment(props.threadId, attachmentId),
        ),
      );
    },
    threadId: String(props.threadId),
    serverUrl: props.serverUrl,
    windowCapability: props.windowCapability,
    client: props.messageQueueClient,
  });
  const latestStatus = turns.at(-1)?.status;
  const turnRunning =
    latestStatus === "accepted" || latestStatus === "running" || latestStatus === "waiting";
  const queueFollowUp =
    turnRunning ||
    (messageQueue.snapshot?.items.length ?? 0) > 0 ||
    messageQueue.snapshot?.paused === true ||
    messageQueue.snapshot?.holdReason !== undefined;
  const preparingQueue = useRef(false);
  const runningTurn = turns.at(-1);
  const stoppableTurn =
    (runningTurn?.status === "accepted" || runningTurn?.status === "running") &&
    String(runningTurn.threadId) === String(props.threadId)
      ? runningTurn
      : undefined;
  const onStop = useCallback(async () => {
    const turnClient = props.turnClient;
    const turn = stoppableTurn;
    if (turnClient === undefined || turn === undefined) return;
    const threadKey = String(props.threadId);
    try {
      await turnClient.cancelFirstTurn({
        kind: "cancel-work-turn",
        requestId: turn.requestId,
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
    } catch (error) {
      if (currentThreadKeyRef.current !== threadKey) return;
      setErrorMessage(
        error instanceof WorkTurnClientFailure
          ? error.message
          : "The Work turn could not be stopped. Try again.",
      );
    }
  }, [props.threadId, props.turnClient, stoppableTurn]);
  const answerWorkRequest = useCallback(
    async (
      request: WorkRequest,
      resolution:
        | { readonly kind: "approval"; readonly approved: boolean }
        | { readonly kind: "user-input"; readonly answer: string },
    ) => {
      const requestClient = props.requestClient;
      if (requestClient === undefined) return;
      try {
        await requestClient.execute({
          kind: "resolve-work-request",
          requestId: request.requestId,
          expectedVersion: request.version,
          resolution,
        });
        setStatus(undefined);
        setPendingRequests((current) =>
          current.filter((candidate) => String(candidate.requestId) !== String(request.requestId)),
        );
      } catch {
        setStatus("The answer could not be delivered.");
      }
    },
    [props.requestClient],
  );

  useEffect(() => {
    setPendingRequests([]);
    setErrorMessage(undefined);
    setStatus(undefined);
    setEarlierState("idle");
    return () => earlierAbort.current?.abort();
  }, [props.threadId]);
  const loadEarlier = useCallback(async () => {
    const turnClient = props.turnClient;
    const oldest = loaded.turns[0];
    const threadKey = String(props.threadId);
    if (
      turnClient === undefined ||
      oldest === undefined ||
      !loaded.hasEarlier ||
      loaded.threadKey !== threadKey ||
      earlierState === "loading"
    ) {
      return;
    }
    earlierAbort.current?.abort();
    const abort = new AbortController();
    earlierAbort.current = abort;
    setEarlierState("loading");
    try {
      const page = await turnClient.transcriptWindow(
        props.threadId,
        { limit: WORK_TRANSCRIPT_PAGE_TURNS, before: oldest.requestId },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setLoaded((current) =>
        // A newest read that could not prove it touched this run replaced it
        // while the page loaded; the page belongs to a run that is gone.
        current.threadKey !== threadKey ||
        current.turns[0] === undefined ||
        workTurnKey(current.turns[0]) !== workTurnKey(oldest)
          ? current
          : {
              ...current,
              turns: prependEarlierTurns(current.turns, page.turns, workTurnKey),
              hasEarlier: page.hasEarlier,
            },
      );
      setEarlierState("idle");
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof WorkTurnClientFailure && error.status === 409) {
        // The turn this page was anchored on is no longer in the thread, so
        // the loaded run cannot be extended: start again from the newest page.
        try {
          const newest = await readNewestWorkTurns(turnClient, props.threadId, abort.signal);
          if (abort.signal.aborted) return;
          setLoaded((current) =>
            current.threadKey !== threadKey
              ? current
              : {
                  threadKey,
                  turns: newest.turns,
                  hasEarlier: newest.hasEarlier,
                  offerEarlier: current.offerEarlier || newest.hasEarlier,
                },
          );
          setEarlierState("idle");
          return;
        } catch {
          if (abort.signal.aborted) return;
        }
      }
      setEarlierState("failed");
    }
  }, [earlierState, loaded, props.threadId, props.turnClient]);
  const earlierRow: LoadEarlierMessagesState | undefined =
    !loaded.offerEarlier || loaded.threadKey !== String(props.threadId)
      ? undefined
      : earlierState === "loading" || earlierState === "failed"
        ? earlierState
        : loaded.hasEarlier
          ? "idle"
          : "none-left";
  const images = useWorkComposerImages();
  const imageSupport = selectedModelReadsImages(props.providerGroups ?? [], {
    ...(thread === undefined ? {} : { providerInstanceId: thread.providerInstanceId }),
    ...(thread === undefined ? {} : { modelId: thread.modelId }),
  });
  const threadMentions = useThreadMentions({
    ...(props.threadMentionClient === undefined ? {} : { client: props.threadMentionClient }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: prompt,
  });
  const mention = useThreadMentionTypeahead({
    mentions: threadMentions.composer,
    draft: prompt,
    onDraftChange: composerDraft.setDraft,
    textarea: () => textareaRef.current,
    disabled: creating || completionLocked,
  });
  const threadDropKey = useComposerThreadDropRegistration({
    enabled: threadMentions.composer !== undefined,
    currentThreadId: String(props.threadId),
    onDraftChange: composerDraft.setDraft,
    attachDroppedThread: threadMentions.attachDroppedThread,
  });
  const fileMentions = useWorkFileMentions({
    ...(props.fileMentionClient === undefined ? {} : { client: props.fileMentionClient }),
    threadId: props.threadId,
    draft: prompt,
    onDraftChange: composerDraft.setDraft,
    textarea: () => textareaRef.current,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const fileMentionOpen = fileMentions.open && !mention.open;
  const compacting = useComposerCompacting();
  const canSubmit =
    trimmed.length > 0 &&
    !compacting &&
    !creating &&
    !slash.resolving &&
    !completionLocked &&
    !messageQueue.busy &&
    !messageQueue.uncertain &&
    (!queueFollowUp || messageQueue.available) &&
    projectId !== undefined &&
    (props.turnClient !== undefined || props.mutationClient !== undefined);
  // Without a turn client there is no read to wait for.
  const firstPageSettled =
    props.turnClient === undefined || loaded.threadKey === String(props.threadId);
  const settledTurnCount = turns.filter(
    (turn) => turn.status !== "accepted" && turn.status !== "running" && turn.status !== "waiting",
  ).length;
  const transcriptRows = useMemo<ReadonlyArray<WorkTranscriptRow>>(() => {
    const rows: WorkTranscriptRow[] = [];
    // Only a settled first read can say the thread has no turns. Before it
    // arrives an existing thread looks the same as a new one, and the prompt
    // for a new thread would flash over the messages that are on their way.
    if (turns.length === 0 && firstPageSettled) rows.push({ kind: "empty", key: "empty" });
    // A key names the turn, never its position: earlier pages arrive above,
    // and the list keeps the reader's row in place by its key.
    for (const turn of turns) {
      const head: WorkTranscriptRow = {
        kind: "head",
        key: `${String(turn.requestId)}-head`,
        turn,
      };
      let headPlaced = false;
      for (const [index, entry] of turn.transcript.entries()) {
        // The header opens the turn's first reply in the same row, as it does
        // in Chat and Code; a separate header row put a full row gap between
        // the header and the prose it introduces.
        const opensTurn = entry.role === "assistant" && !headPlaced;
        if (opensTurn) headPlaced = true;
        rows.push({
          kind: "message",
          key: `${String(turn.requestId)}-${entry.role}-${String(index)}`,
          entry,
          streaming:
            turn.status === "running" || turn.status === "accepted" || turn.status === "waiting",
          ...(entry.role === "user" ? { at: turn.acceptedAt } : {}),
          ...(entry.role === "user" && turn.delivery !== undefined
            ? { delivered: true as const }
            : {}),
          ...(opensTurn ? { head: turn } : {}),
        });
      }
      if (!headPlaced) rows.push(head);
      // The provider's restated task list lands where the turn it belongs to
      // ends, so the transcript reads as what was said and then what it is
      // working through.
      if (turn.tasks !== undefined && turn.tasks.length > 0) {
        rows.push({
          kind: "tasks",
          key: `${String(turn.requestId)}-tasks`,
          turn,
          tasks: turn.tasks,
        });
      }
      // The files land after the turn that produced them, so the transcript
      // reads as what was said and then what came out of it.
      if (turn.wroteFiles !== undefined) {
        rows.push({
          kind: "files",
          key: `${String(turn.requestId)}-files`,
          wrote: turn.wroteFiles,
        });
      }
    }
    for (const request of pendingRequests) {
      rows.push({ kind: "request", key: `request-${String(request.requestId)}`, request });
    }
    if (status !== undefined) rows.push({ kind: "status", key: "status", text: status });
    return rows;
  }, [firstPageSettled, pendingRequests, status, turns]);

  useEffect(() => {
    const requestGeneration = ++transcriptGeneration.current;
    const streamAbort = new AbortController();
    let cancelled = false;
    props.onDisplayReadyChange?.(false);
    void (async () => {
      try {
        const thread =
          String(initialThread.current?.id) === String(props.threadId)
            ? initialThread.current
            : (await props.threadClient.bootstrap(streamAbort.signal)).threads.find(
                (candidate) => String(candidate.id) === String(props.threadId),
              );
        if (thread === undefined) {
          composerDraft.purge(String(props.threadId));
          setErrorMessage("This task is no longer available.");
          return;
        }
        setThread(thread);
        setProjectId(thread.projectId);
        const transcriptRead = async () => {
          const turnClient = props.turnClient;
          if (turnClient === undefined) {
            props.onDisplayReadyChange?.(true);
            return;
          }
          let retryMs = 250;
          let transcript: WorkNewestTurns;
          for (;;) {
            try {
              transcript = await readNewestWorkTurns(
                turnClient,
                props.threadId,
                streamAbort.signal,
              );
              break;
            } catch (error) {
              if (cancelled || streamAbort.signal.aborted) return;
              const permanentlyRefused =
                error instanceof WorkTurnClientFailure && error.status >= 400 && error.status < 500;
              if (!changeDriven || permanentlyRefused) throw error;
              setErrorMessage(WORK_TRANSCRIPT_RECONNECTING_MESSAGE);
              await waitUntilDocumentVisible(streamAbort.signal);
              if (streamAbort.signal.aborted) return;
              await waitForWorkStreamReconnect(streamAbort.signal, retryMs);
              retryMs = Math.min(retryMs * 2, 2_000);
            }
          }
          if (cancelled || requestGeneration !== transcriptGeneration.current) return;
          setErrorMessage((current) =>
            current === WORK_TRANSCRIPT_RECONNECTING_MESSAGE ? undefined : current,
          );
          setLoaded((current) => withNewestWorkTurns(current, String(props.threadId), transcript));
          props.onDisplayReadyChange?.(true);
          if (typeof turnClient.subscribe === "function") {
            void consumeWorkTurnStream({
              client: turnClient,
              threadId: props.threadId,
              afterSequence: transcript.liveCursor,
              signal: streamAbort.signal,
              active: () => !cancelled && requestGeneration === transcriptGeneration.current,
              apply: (frame) => {
                setTurns((current) => applyWorkTurnStreamFrame(current, frame));
                setRetries((current) => applyWorkRetryFrame(current, frame));
              },
              replace: (next) => {
                setLoaded((current) => withNewestWorkTurns(current, String(props.threadId), next));
                setRetries(new Map());
              },
            });
          }
        };
        const requestRead = async () => {
          const requestClient = props.requestClient;
          if (requestClient === undefined) return;
          const requests = await requestClient.list(
            thread.projectId,
            props.threadId,
            streamAbort.signal,
          );
          if (cancelled || requestGeneration !== transcriptGeneration.current) return;
          const pending = requests.requests.filter((request) => request.status === "pending");
          setPendingRequests((current) => (samePollingData(current, pending) ? current : pending));
        };
        await Promise.all([transcriptRead(), requestRead()]);
      } catch {
        if (!cancelled) setErrorMessage("This task could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
      streamAbort.abort();
      transcriptGeneration.current += 1;
    };
  }, [
    changeDriven,
    composerDraft.purge,
    props.onDisplayReadyChange,
    props.requestClient,
    props.threadClient,
    props.threadId,
    props.turnClient,
  ]);

  useEffect(() => {
    const next = props.initialThread;
    if (next === undefined || String(next.id) !== String(props.threadId)) return;
    setThread((current) => (samePollingData(current, next) ? current : next));
    setProjectId(next.projectId);
  }, [props.initialThread, props.threadId]);

  useEffect(() => {
    const turnClient = props.turnClient;
    const requestClient = props.requestClient;
    if (turnClient === undefined && requestClient === undefined) return;
    if (props.changeRevision !== undefined) return;
    let cancelled = false;
    const pollAbort = new AbortController();
    // A cycle that outlives the interval must finish before the next one
    // starts. Without this guard, a poll slower than the interval is always
    // superseded by the next tick's generation bump before its response
    // arrives, so a host that consistently takes longer than 1s to answer
    // would never see its transcript or pending requests update at all.
    let inFlight = false;
    const stop = scheduleVisibleInterval(() => {
      if (cancelled || inFlight || !documentIsVisible()) return;
      inFlight = true;
      const streamAvailable = typeof turnClient?.subscribe === "function";
      const requestGeneration = streamAvailable
        ? transcriptGeneration.current
        : ++transcriptGeneration.current;
      const transcript =
        turnClient === undefined || streamAvailable
          ? Promise.resolve()
          : readNewestWorkTurns(turnClient, props.threadId, pollAbort.signal).then((next) => {
              if (cancelled || requestGeneration !== transcriptGeneration.current) return;
              setLoaded((current) => withNewestWorkTurns(current, String(props.threadId), next));
            });
      const requests =
        requestClient === undefined || projectId === undefined
          ? Promise.resolve()
          : requestClient.list(projectId, props.threadId, pollAbort.signal).then((next) => {
              if (cancelled || requestGeneration !== transcriptGeneration.current) return;
              const pending = next.requests.filter((request) => request.status === "pending");
              setPendingRequests((current) =>
                samePollingData(current, pending) ? current : pending,
              );
            });
      void Promise.allSettled([transcript, requests]).finally(() => {
        inFlight = false;
      });
    }, 1_000);
    return () => {
      cancelled = true;
      pollAbort.abort();
      stop();
    };
  }, [projectId, props.changeRevision, props.requestClient, props.threadId, props.turnClient]);

  useEffect(() => {
    if (
      props.changeRevision === undefined ||
      props.changeRevision <= 0 ||
      props.requestClient === undefined ||
      projectId === undefined
    )
      return;
    let cancelled = false;
    const refreshAbort = new AbortController();
    void props.requestClient
      .list(projectId, props.threadId, refreshAbort.signal)
      .then((next) => {
        if (cancelled) return;
        const pending = next.requests.filter((request) => request.status === "pending");
        setPendingRequests((current) => (samePollingData(current, pending) ? current : pending));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      refreshAbort.abort();
    };
  }, [projectId, props.changeRevision, props.requestClient, props.threadId]);

  const browserApprovalRevision = useThreadActivityRevision("toolApprovals");
  // A different thread or client starts clean; a notice never clears the list.
  useEffect(() => {
    setBrowserApprovals([]);
  }, [props.browserAutomationClient, props.threadId]);
  const refreshBrowserApprovals = useCallback(
    async (signal: AbortSignal) => {
      const client = props.browserAutomationClient;
      const listApprovals = client?.listApprovals;
      if (listApprovals === undefined) return;
      try {
        const approvals = await listApprovals.call(client, signal);
        if (signal.aborted) return;
        setBrowserApprovals((current) => {
          const next = approvals.filter(
            (approval) => String(approval.threadId) === String(props.threadId),
          );
          return samePollingData(current, next) ? current : next;
        });
      } catch {
        if (!signal.aborted) setBrowserApprovals([]);
      }
    },
    [props.browserAutomationClient, props.threadId],
  );
  useVisibleRefresh(
    refreshBrowserApprovals,
    browserApprovalRevision,
    browserApprovalRevision === undefined
      ? turnRunning
        ? 500
        : 5_000
      : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const pendingBrowserApproval = browserApprovals[0];
  const decideBrowserApproval = async (decision: "approved" | "denied", remember?: boolean) => {
    if (
      pendingBrowserApproval === undefined ||
      props.browserAutomationClient?.decideApproval === undefined ||
      browserApprovalBusy
    ) {
      return;
    }
    setBrowserApprovalBusy(true);
    setBrowserApprovalMessage(undefined);
    try {
      await props.browserAutomationClient.decideApproval({
        approvalId: pendingBrowserApproval.approvalId,
        decision,
        ...(remember === true ? { remember: true } : {}),
      });
      setBrowserApprovals((current) =>
        current.filter((approval) => approval.approvalId !== pendingBrowserApproval.approvalId),
      );
      // An always-allow grant is journaled by the server, outside this
      // window's shell commands — the shell controller re-reads on the signal
      // so its next settings edit does not conflict on a stale version.
      if (decision === "approved" && remember === true) announceShellSettingsWritten();
    } catch {
      setBrowserApprovalMessage(
        "Browser approval could not be sent. Keep this request open and retry.",
      );
    } finally {
      setBrowserApprovalBusy(false);
    }
  };

  const changeProvider = useCallback(
    async (selection: {
      readonly providerInstanceId: WorkThread["providerInstanceId"];
      readonly modelId: WorkThread["modelId"];
      readonly modelOptionValues?: ProviderModelOptionValues;
    }) => {
      if (
        thread === undefined ||
        thread.completionConfirmed === true ||
        providerChanging ||
        (selection.modelOptionValues === undefined &&
          selection.providerInstanceId === thread.providerInstanceId &&
          selection.modelId === thread.modelId)
      ) {
        return;
      }
      setProviderChanging(true);
      setErrorMessage(undefined);
      setStatus(undefined);
      try {
        const result = await props.threadClient.execute({
          kind: "change-work-thread-provider",
          threadId: thread.id,
          expectedVersion: thread.version,
          providerInstanceId: selection.providerInstanceId,
          modelId: selection.modelId,
          ...(selection.modelOptionValues === undefined
            ? {}
            : { modelOptionValues: selection.modelOptionValues }),
        });
        if (!("kind" in result) || result.kind !== "thread-updated") {
          setErrorMessage("The selected Work provider could not be applied.");
          return;
        }
        setThread(result.thread);
        props.onThreadUpdated?.(result.thread);
        setStatus(
          selection.modelOptionValues === undefined
            ? "Provider handoff ready for the next Work turn."
            : "Model options saved for the next Work turn.",
        );
      } catch {
        setErrorMessage(
          "The selected Work provider could not be applied. Choose a ready provider and model.",
        );
      } finally {
        setProviderChanging(false);
      }
    },
    [props.threadClient, providerChanging, thread],
  );

  // The resume opt-in rides the ordinary serialized command path and answers
  // the updated thread, so the banner flips to its scheduled state only from
  // what the host journaled.
  const scheduleUsageResume = useCallback(
    (turnId: WorkTurnId) => {
      if (thread === undefined) return;
      const threadKey = currentThreadKeyRef.current;
      void props.threadClient
        .execute({
          kind: "schedule-work-usage-resume",
          threadId: thread.id,
          expectedVersion: thread.version,
          turnId,
        })
        .then((result) => {
          // The workspace may have switched threads while the command was in
          // flight; only the initiating thread's answer is allowed to land.
          if (currentThreadKeyRef.current !== threadKey) return;
          if ("kind" in result && result.kind === "thread-updated") {
            setThread(result.thread);
            props.onThreadUpdated?.(result.thread);
            return;
          }
          setErrorMessage("The usage-limit resume could not be scheduled.");
        })
        .catch(() => {
          if (currentThreadKeyRef.current !== threadKey) return;
          setErrorMessage("The usage-limit resume could not be scheduled.");
        });
    },
    [props, thread],
  );

  const cancelUsageResume = useCallback(() => {
    if (thread === undefined) return;
    const threadKey = currentThreadKeyRef.current;
    void props.threadClient
      .execute({
        kind: "cancel-work-usage-resume",
        threadId: thread.id,
        expectedVersion: thread.version,
      })
      .then((result) => {
        if (currentThreadKeyRef.current !== threadKey) return;
        if ("kind" in result && result.kind === "thread-updated") {
          setThread(result.thread);
          props.onThreadUpdated?.(result.thread);
          return;
        }
        setErrorMessage("The scheduled resume could not be withdrawn.");
      })
      .catch(() => {
        if (currentThreadKeyRef.current !== threadKey) return;
        setErrorMessage("The scheduled resume could not be withdrawn.");
      });
  }, [props, thread]);

  // Shelving until the limit's reset rides the same serialized command path;
  // the host derives the wake time from the journaled stop, so a stale offer
  // is refused honestly rather than binding an old reset to a new run.
  const snoozeAtUsageReset = useCallback(() => {
    if (thread === undefined) return;
    const threadKey = currentThreadKeyRef.current;
    void props.threadClient
      .execute({
        kind: "snooze-work-thread-at-usage-reset",
        threadId: thread.id,
        expectedVersion: thread.version,
      })
      .then((result) => {
        if (currentThreadKeyRef.current !== threadKey) return;
        if ("kind" in result && result.kind === "thread-updated") {
          setThread(result.thread);
          props.onThreadUpdated?.(result.thread);
          return;
        }
        setErrorMessage("The thread could not be hidden until the limit resets.");
      })
      .catch(() => {
        if (currentThreadKeyRef.current !== threadKey) return;
        setErrorMessage("The thread could not be hidden until the limit resets.");
      });
  }, [props, thread]);

  const sendWorkTurn = useCallback(
    async (enqueue = false): Promise<boolean> => {
      if (
        thread !== undefined &&
        thread.bindingRevisionId === undefined &&
        props.turnClient !== undefined
      ) {
        setErrorMessage(
          "This task must be rebound before sending a follow-up. Its Project folder is no longer authorized.",
        );
        return false;
      }
      if (
        thread === undefined ||
        thread.completionConfirmed === true ||
        providerChanging ||
        props.turnClient === undefined ||
        thread.bindingRevisionId === undefined ||
        projectId === undefined
      ) {
        return false;
      }
      const extensionSelections = extensionDraft.receipts.flatMap((receipt) =>
        receipt.selection === undefined ? [] : [receipt.selection],
      );
      const promptText = composerDraft.text;
      if (promptText.length === 0) return false;
      const sendingThreadId = String(thread.id);
      const draftRevision = composerDraft.revisionFor(String(props.threadId));
      const attachmentIds: WorkAttachmentId[] = [];
      const discardUploadedAttachments = async (): Promise<void> => {
        await Promise.allSettled(
          attachmentIds.map((attachmentId) =>
            props.turnClient?.discardAttachment(props.threadId, attachmentId),
          ),
        );
      };
      setCreating(true);
      setErrorMessage(undefined);
      setStatus(undefined);
      try {
        if (String(props.threadId) !== sendingThreadId) return false;
        const staged = images.filesForSend();
        const fileMentionPaths = [...fileMentions.selectedPaths];
        const threadMentionIds = await threadMentions.resolveForSend();
        for (const file of staged) {
          const attachmentId = decodeWorkAttachmentId(globalThis.crypto.randomUUID());
          await props.turnClient.putAttachment({
            threadId: props.threadId,
            attachmentId,
            displayName: file.name.trim() === "" ? "Pasted image" : file.name,
            mediaType: decodeWorkAttachmentMediaType(file.type),
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
          attachmentIds.push(attachmentId);
        }
        if (enqueue) {
          if (currentThreadKeyRef.current !== sendingThreadId) {
            await discardUploadedAttachments();
            return false;
          }
          const result = await messageQueue.enqueue(
            {
              mode: "work",
              prompt: promptText,
              attachmentIds,
              threadMentionIds,
              fileMentionPaths,
              extensionSelections,
            },
            () => {
              if (currentThreadKeyRef.current !== sendingThreadId) return;
              images.consume(staged);
              if (composerDraft.revisionFor(sendingThreadId) === draftRevision) {
                composerDraft.clear();
                threadMentions.clear();
                fileMentions.clear();
                extensionDraft.clear();
              }
            },
            discardUploadedAttachments,
            { text: promptText, revision: draftRevision },
          );
          return result === "accepted";
        }
        const started = await props.turnClient.startFirstTurn({
          kind: "start-work-thread-turn",
          ...(extensionSelections.length === 0 ? {} : { extensionSelections }),
          requestId: decodeWorkTurnRequestId(globalThis.crypto.randomUUID()),
          threadId: props.threadId,
          turnId: decodeWorkTurnId(globalThis.crypto.randomUUID()),
          prompt: promptText,
          authority: {
            hostId: props.hostId ?? LOCAL_HOST_ID,
            projectId,
            bindingRevisionId: thread.bindingRevisionId,
            workingDirectory: thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
            confinementPosture: "project-root-confined",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
          },
          ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
          ...(threadMentionIds.length === 0 ? {} : { threadMentionIds }),
          ...(fileMentionPaths.length === 0 ? {} : { fileMentionPaths: [...fileMentionPaths] }),
        });
        if (started.kind !== "accepted") {
          await discardUploadedAttachments();
          setErrorMessage("The Work turn could not be started.");
          return false;
        }
        {
          images.consume(staged);
          threadMentions.clear();
          fileMentions.clear();
          // Do not clear text typed while this send was resolving, even when it
          // happens to be identical to the text this send carried.
          if (composerDraft.revisionFor(String(props.threadId)) === draftRevision) {
            composerDraft.clear();
            extensionDraft.clear();
          }
        }
        setTurns((current) =>
          current.some((turn) => String(turn.requestId) === String(started.turn.requestId))
            ? current
            : [...current, started.turn],
        );
        textareaRef.current?.focus();
        return true;
      } catch (error) {
        await discardUploadedAttachments();
        setErrorMessage(
          error instanceof WorkTurnClientFailure
            ? error.message
            : "The Work turn could not be started.",
        );
        return false;
      } finally {
        setCreating(false);
      }
    },
    [
      composerDraft,
      fileMentions,
      images,
      projectId,
      props.hostId,
      props.threadId,
      props.turnClient,
      providerChanging,
      thread,
      threadMentions,
      extensionDraft,
      messageQueue,
    ],
  );
  const submit = useCallback(async () => {
    if (!canSubmit || preparingQueue.current) return;
    if (queueFollowUp) {
      preparingQueue.current = true;
      try {
        await sendWorkTurn(true);
      } finally {
        preparingQueue.current = false;
      }
      return;
    }
    if (!canSubmit || projectId === undefined) {
      return;
    }
    if (props.turnClient !== undefined) {
      await sendWorkTurn();
      return;
    }
    if (props.mutationClient === undefined) return;
    setCreating(true);
    setErrorMessage(undefined);
    setStatus(undefined);
    try {
      const reply = await props.mutationClient.mutate({
        kind: "create-artifact",
        requestId: decodeWorkMutationRequestId(globalThis.crypto.randomUUID()),
        projectId,
        format: "markdown",
        displayName: artifactNameFromPrompt(trimmed),
        content: trimmed,
      });
      if (reply.outcome.kind !== "created") {
        setErrorMessage("The artifact could not be created.");
        return;
      }
      composerDraft.clear();
      setStatus(`Created ${reply.outcome.artifact.displayName} in the bound folder.`);
      textareaRef.current?.focus();
    } catch {
      setErrorMessage("The artifact could not be created. Review the Work project status.");
    } finally {
      setCreating(false);
    }
  }, [
    extensionDraft,
    canSubmit,
    composerDraft,
    projectId,
    props.mutationClient,
    props.turnClient,
    sendWorkTurn,
    queueFollowUp,
    trimmed,
    turnRunning,
  ]);

  const confirmCompletion = useCallback(async () => {
    if (
      thread === undefined ||
      completing ||
      thread.lifecycle !== "active" ||
      thread.completionConfirmed === true
    ) {
      return;
    }
    setCompleting(true);
    setErrorMessage(undefined);
    setStatus(undefined);
    try {
      const result = await props.threadClient.execute({
        kind: "confirm-work-thread-completion",
        threadId: thread.id,
        expectedVersion: thread.version,
        deliveryTarget: thread.title,
      });
      if (!("kind" in result) || result.kind !== "thread-completion-confirmed") {
        setErrorMessage("This task could not be marked Done.");
        return;
      }
      setThread(result.thread);
      props.onThreadUpdated?.(result.thread);
      setStatus("Marked Done.");
    } catch {
      setErrorMessage("This task could not be marked Done. Try again.");
    } finally {
      setCompleting(false);
      setCompletionFormOpen(false);
    }
  }, [completing, props.threadClient, thread]);

  function attachFromTransfer(items: DataTransfer | null): boolean {
    if (items === null) return false;
    if (!clipboardHasImage(items)) return false;
    if (imageSupport === false) {
      images.refuse("The selected model does not accept images. Choose an image-capable model.");
      return true;
    }
    return images.consumePaste(items);
  }

  const restoredCaret = composerDraft.caretIndex;
  const restoredLength = prompt.length;
  useLayoutEffect(() => {
    applyComposerCaret(textareaRef.current, restoredCaret, restoredLength);
    // Restore only when this thread's composer is shown, not on every keystroke.
  }, [props.threadId]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestionInput.takeOnTab(event)) return;
    if (slash.handleKeyDown(event)) return;
    if (mention.handleKeyDown(event)) return;
    if (fileMentions.handleKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function rememberDraft(text: string, caretIndex: number | null) {
    if (caretIndex === null) composerDraft.setDraft(text);
    else composerDraft.setDraft(text, caretIndex);
  }

  function syncMentions(value: string, caret: number | null) {
    slash.sync(value, caret);
    mention.sync(value, caret);
    fileMentions.sync(value, caret);
  }

  const project = props.projects?.find(
    (entry) => entry.type === "work" && String(entry.id) === String(thread?.projectId),
  );
  const folder = thread?.workingDirectory;
  const root =
    project?.type === "work" && project.bindingRevisionId === thread?.bindingRevisionId
      ? project.binding.canonicalRoot
      : undefined;
  const path =
    root === undefined
      ? folder
      : folder === undefined || folder === "."
        ? root
        : `${root.replace(/[/\\]+$/, "")}/${folder}`;
  // The transcript draws the inline Canvases and the card list the rest.
  const threadCanvases = useThreadCanvasCards({
    client: props.canvasClient,
    mode: "work",
    threadId: props.threadId,
    projectId: projectId ?? null,
    // A settled turn may have authored a Canvas; re-read the cards so the
    // document appears without reopening the thread.
    refreshKey: settledTurnCount,
    ...(props.onCanvasReferencesObserved === undefined
      ? {}
      : {
          onCardsObserved: (cards: ReadonlyArray<CanvasThreadReferenceCard>) =>
            props.onCanvasReferencesObserved?.(String(props.threadId), cards),
        }),
  });
  const canvasClient = props.canvasClient;
  const openInSidebar = props.onOpenCanvasInSidebar;
  const canvasPlacement = placeThreadCanvases(
    threadTurnSpans(
      transcriptRows,
      (row) => row.key,
      (row) => (row.kind === "message" && row.entry.role === "user" ? row.at : undefined),
    ),
    threadCanvases.cards,
  );

  // Offered once: an answer either way is the thread's journaled choice.
  const artifactsOfferRow = threadArtifactsOfferRow({
    choosable: artifactsChoosable && !completionLocked,
    documentDelivery: thread?.documentDelivery,
    rowKeys: transcriptRows.map((row) => row.key),
    canvasesByRow: canvasPlacement.byRow,
  });

  return (
    <section aria-label="Task workspace" className="work-thread-workspace">
      <h1 className="sr-only">{props.title}</h1>

      {confirmArtifacts ? (
        <ThreadArtifactsConfirm
          onCancel={() => setConfirmArtifacts(false)}
          onConfirm={() => void changeDocumentDelivery("native-artifacts")}
          pending={deliveryChanging}
        />
      ) : null}

      {completionFormOpen && thread?.lifecycle === "active" && !completionLocked ? (
        <OctantConfirmDialog
          confirmLabel="Mark done"
          onCancel={() => setCompletionFormOpen(false)}
          onConfirm={() => void confirmCompletion()}
          pending={completing}
          title="Mark this task Done?"
        >
          {thread.title} moves to Done on the board. Its composer and provider lock until you
          archive and reactivate it.
        </OctantConfirmDialog>
      ) : null}

      <TranscriptWindow
        ariaLabel="Work transcript"
        className="work-thread-workspace__conversation transcript-scroll"
        estimateSize={92}
        gap={20}
        compactionSubject={threadCompactionSubject("work-thread", String(props.threadId))}
        itemAt={workRowHappenedAt}
        itemKey={(row) => row.key}
        items={transcriptRows}
        {...(earlierRow === undefined
          ? {}
          : {
              lead: <LoadEarlierMessages onLoad={() => void loadEarlier()} state={earlierRow} />,
            })}
        listClassName="thread-column"
        {...(canvasClient === undefined
          ? {}
          : {
              afterItem: (row: WorkTranscriptRow) => (
                <>
                  <ThreadCanvases
                    cards={canvasPlacement.byRow.get(row.key)}
                    client={canvasClient}
                    {...(openInSidebar === undefined ? {} : { onOpen: openInSidebar })}
                  />
                  {row.key === artifactsOfferRow ? (
                    <ThreadArtifactsOffer
                      onChoose={(choice) => void changeDocumentDelivery(choice)}
                      pending={deliveryChanging}
                    />
                  ) : null}
                </>
              ),
            })}
        renderItem={(row) => {
          if (row.kind === "empty") {
            return (
              <p className="work-thread-workspace__opening">
                Describe what you want made. Files this task writes stay inside its folder.
              </p>
            );
          }
          if (row.kind === "message") {
            if (row.entry.role === "user") {
              if (row.delivered === true) {
                return (
                  <article aria-label="Subagent results" className="turn-child-result">
                    <ChildResultCards providerGroups={props.providerGroups} text={row.entry.text} />
                  </article>
                );
              }
              return (
                <article aria-label="Your message" className="turn-user">
                  <div className="bubble">
                    <TrackerReferenceText asParagraph text={row.entry.text} />
                  </div>
                  {row.at === undefined ? null : (
                    <TurnTime at={row.at} copyValue={row.entry.text} />
                  )}
                </article>
              );
            }
            // A reply is markdown, as it is in Chat and Code: the same headings,
            // lists, and code blocks render the same way here.
            return (
              <article aria-label="Assistant message" className="turn-agent">
                {row.head === undefined ? null : (
                  <>
                    <WorkTurnHeader
                      copyValue={row.entry.text}
                      onRestorePrompt={composerDraft.setDraft}
                      onCancelResume={cancelUsageResume}
                      onScheduleResume={scheduleUsageResume}
                      providerGroups={props.providerGroups ?? []}
                      resumable={
                        String(row.head.turnId) === String(turns.at(-1)?.turnId) &&
                        row.head.status === "waiting"
                      }
                      {...(thread?.snooze === undefined
                        ? { onSnoozeAtReset: snoozeAtUsageReset }
                        : {})}
                      turn={row.head}
                      {...(thread?.usageResume === undefined ||
                      String(thread.usageResume.record.turnId) !== String(row.head.turnId)
                        ? {}
                        : { usageResume: thread.usageResume })}
                    />
                    <HarnessRetryStatus
                      events={workRetryEvents(retries, String(row.head.requestId))}
                    />
                    <WorkToolGroup
                      turn={row.head}
                      {...(props.canvasClient === undefined
                        ? {}
                        : { canvasClient: props.canvasClient })}
                    />
                  </>
                )}
                {row.entry.text === "" ? null : (
                  <AssistantMessageBody body={row.entry.text} streaming={row.streaming} />
                )}
              </article>
            );
          }
          if (row.kind === "head") {
            return (
              <div className="turn-agent">
                <WorkTurnHeader
                  onCancelResume={cancelUsageResume}
                  onRestorePrompt={composerDraft.setDraft}
                  onScheduleResume={scheduleUsageResume}
                  providerGroups={props.providerGroups ?? []}
                  resumable={
                    String(row.turn.turnId) === String(turns.at(-1)?.turnId) &&
                    row.turn.status === "waiting"
                  }
                  {...(thread?.snooze === undefined ? { onSnoozeAtReset: snoozeAtUsageReset } : {})}
                  turn={row.turn}
                  {...(thread?.usageResume === undefined ||
                  String(thread.usageResume.record.turnId) !== String(row.turn.turnId)
                    ? {}
                    : { usageResume: thread.usageResume })}
                />
                <HarnessRetryStatus events={workRetryEvents(retries, String(row.turn.requestId))} />
                <WorkToolGroup
                  turn={row.turn}
                  {...(props.canvasClient === undefined
                    ? {}
                    : { canvasClient: props.canvasClient })}
                />
              </div>
            );
          }
          if (row.kind === "files") {
            return (
              <section
                aria-label="Files this turn changed"
                className="work-thread-workspace__files"
              >
                <h3 className="oct-section-label">
                  {/* A watcher that failed reports no paths and marks itself
                      truncated. Counting that as zero told the person nothing
                      changed, which is not what the host observed. An empty
                      list that is not truncated really is nothing. */}
                  {row.wrote.paths.length === 0 && row.wrote.truncated
                    ? "Changed files could not be observed while this ran"
                    : row.wrote.paths.length === 1
                      ? "1 file changed while this ran"
                      : `${String(row.wrote.paths.length)} files changed while this ran`}
                </h3>
                <ul className="work-thread-workspace__file-list">
                  {row.wrote.paths.map((path) => (
                    <li className="work-thread-workspace__file" key={path}>
                      <FileText aria-hidden="true" size={14} strokeWidth={1.7} />
                      <span>{path}</span>
                    </li>
                  ))}
                </ul>
                {row.wrote.truncated ? (
                  <p className="oct-row-detail" role="status">
                    {/* "More changed" claims a file changed. A watcher that
                        failed establishes no such thing. */}
                    {row.wrote.paths.length === 0
                      ? "Octant could not watch the folder while this ran. Open Files for the folder itself."
                      : "More changed than Octant could record. Open Files for the folder itself."}
                  </p>
                ) : null}
              </section>
            );
          }
          if (row.kind === "tasks") {
            return (
              <ThreadTasksPanel
                tasks={{
                  running: row.turn.status === "accepted" || row.turn.status === "running",
                  tasks: row.tasks.map((task) => ({
                    id: task.taskId,
                    state: task.state,
                    summary: task.summary,
                  })),
                }}
              />
            );
          }
          if (row.kind === "request") {
            if (props.requestClient !== undefined && row.request.detail.kind === "approval") {
              return (
                <ProviderApprovalPrompt
                  onAnswer={(decision) => {
                    void answerWorkRequest(row.request, {
                      kind: "approval",
                      approved: decision === "approved",
                    });
                  }}
                  summary={`${row.request.detail.action}: ${row.request.detail.description}`}
                />
              );
            }
            if (props.requestClient !== undefined && row.request.detail.kind === "user-input") {
              return (
                <ProviderQuestionCard
                  onAnswer={(answer) => {
                    void answerWorkRequest(row.request, { kind: "user-input", answer });
                  }}
                  options={row.request.detail.options.map((label) => ({ label }))}
                  prompt={row.request.detail.prompt}
                />
              );
            }
            return (
              <div className="approval-row approval-row--request" role="status">
                <CirclePause aria-hidden="true" size={14} strokeWidth={1.8} />
                <span className="approval-row__text">
                  {row.request.detail.kind === "approval"
                    ? `Approval required — ${row.request.detail.action}: ${row.request.detail.description}`
                    : `Input required — ${row.request.detail.prompt}`}
                </span>
              </div>
            );
          }
          return (
            // The surrounding list is already a live region; a nested status
            // here would announce the same trail line twice.
            <p className="oct-row-detail">{row.text}</p>
          );
        }}
        restoreKey={`work:${String(props.threadId)}`}
        role="log"
        trail={
          (props.imageGenerationClient === undefined ||
            props.imageGenerationProfiles === undefined) &&
          props.browserAutomationClient === undefined ? null : (
            <div className="work-thread-workspace__transcript-trail">
              {props.imageGenerationClient === undefined ||
              props.imageGenerationProfiles === undefined ? null : (
                <GeneratedImageList
                  canSaveToProject
                  client={props.imageGenerationClient}
                  onAttach={(file) => images.attach([file])}
                  onSaveToProject={(job, artifact) => {
                    void props.imageGenerationClient
                      ?.save({
                        jobId: job.id,
                        attachmentId: artifact.attachmentId,
                        relativePath: `generated/${String(artifact.attachmentId).slice(0, 8)}.png`,
                      })
                      .then((result) => {
                        if (result.status === "saved") setStatus(`Saved ${result.relativePath}.`);
                        else setStatus(result.reason);
                      })
                      .catch(() => {
                        setStatus("The image could not be saved.");
                      });
                  }}
                  profiles={props.imageGenerationProfiles}
                  scopeId={decodeImageGenerationScopeId(String(props.threadId))}
                  threadKind="work-thread"
                />
              )}
              {props.browserAutomationClient === undefined ? null : (
                <BrowserCaptureList
                  client={props.browserAutomationClient}
                  threadId={decodeBrowserThreadId(String(props.threadId))}
                />
              )}
            </div>
          )
        }
      />

      {props.canvasClient === undefined ? null : (
        <div className="thread-column">
          <CanvasThreadReferenceCardList
            cards={threadCanvases.cards.filter(
              (card) => !canvasPlacement.placed.has(String(card.canvasId)),
            )}
            error={threadCanvases.error}
            {...(props.onOpenCanvas === undefined ? {} : { onOpen: props.onOpenCanvas })}
          />
        </div>
      )}

      <ExtensionToolApprovalPrompt
        className="thread-column"
        client={props.extensionClient}
        threadId={String(props.threadId)}
        turnActive={turnRunning}
      />
      {pendingBrowserApproval === undefined ? null : (
        <OctantApprovalCard
          actions={
            <>
              <OctantButton
                disabled={browserApprovalBusy}
                onClick={() => void decideBrowserApproval("approved")}
                size="sm"
                type="button"
              >
                Approve once
              </OctantButton>
              <OctantButton
                disabled={browserApprovalBusy}
                onClick={() => void decideBrowserApproval("approved", true)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Always allow
              </OctantButton>
              <OctantButton
                disabled={browserApprovalBusy}
                onClick={() => void decideBrowserApproval("denied")}
                size="sm"
                type="button"
                variant="ghost"
              >
                Deny
              </OctantButton>
            </>
          }
          className="thread-column"
          detail="Shell and file access stay unchanged"
          error={browserApprovalMessage}
          label="Browser origin approval"
          summary={`Allow Browser to open ${pendingBrowserApproval.origin}?`}
        />
      )}
      <ThreadComposer
        queue={<ThreadMessageQueue queue={messageQueue} showUnavailable={queueFollowUp} />}
        threadBusy={turnRunning || (messageQueue.snapshot?.items.length ?? 0) > 0}
        presentation="follow-up"
        {...(threadDropKey === undefined ? {} : { threadDropKey })}
        context={
          <div className="work-folder-bar" role="group" aria-label="Project and folder">
            <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
            {project === undefined ? null : (
              <span className="work-folder-bar__project" title={project.name}>
                {project.name}
              </span>
            )}
            {path === undefined ? null : (
              <span className="work-folder-bar__folder" title={path}>
                {folder === undefined || folder === "."
                  ? (root?.split(/[/\\]/).filter(Boolean).at(-1) ?? "Project folder")
                  : folder}
              </span>
            )}
          </div>
        }
        className="thread-composer thread-column"
        chips={
          <>
            {extensionDraft.receipts.length > 0 ? (
              <ul aria-label="Selected extensions" className="composer-chips">
                {extensionDraft.receipts.map((receipt) => (
                  <li className="chip" key={receipt.reference}>
                    <span>{receipt.label}</span>
                    {receipt.status.kind === "blocked" ? (
                      <span>{`Blocked: ${receipt.status.reason}`}</span>
                    ) : null}
                    <OctantButton
                      aria-label={`Remove ${receipt.label} extension`}
                      className="chip-x window-no-drag"
                      onClick={() => extensionDraft.remove(receipt.reference)}
                      type="button"
                      variant="bare"
                    >
                      ×
                    </OctantButton>
                  </li>
                ))}
              </ul>
            ) : null}
            <ThreadMentionChips
              chips={threadMentions.chips}
              onRemove={(mentionedThreadId) =>
                threadMentions.composer?.onRemoveChip(mentionedThreadId)
              }
            />
            <TrackerReferenceComposerHints draft={prompt} />
            <WorkImageAttachmentChips images={images} />
            {composerDraft.stagedDropped === true ? (
              <p className="work-thread-workspace__hint" role="status">
                {COMPOSER_STAGED_DROPPED_NOTE}
              </p>
            ) : null}
            {composerDraft.persistError === undefined ? null : (
              <p className="work-thread-workspace__hint" role="status">
                {composerDraft.persistError}
              </p>
            )}
          </>
        }
        input={
          <OctantTextarea
            aria-label="Work prompt"
            aria-autocomplete="list"
            aria-expanded={slash.open}
            aria-controls={slash.open ? slash.listId : undefined}
            aria-activedescendant={
              slash.active === undefined ? undefined : `${slash.listId}-${slash.active.id}`
            }
            autoFocus
            className="composer-input"
            disabled={
              (creating && !preparingQueue.current) ||
              completionLocked ||
              (props.mutationClient === undefined && props.turnClient === undefined)
            }
            onChange={(event) => {
              rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart);
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onClick={(event) => {
              rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart);
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => {
              rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart);
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
              if ((creating && !preparingQueue.current) || completionLocked) return;
              if (attachFromTransfer(event.clipboardData)) event.preventDefault();
            }}
            data-suggested={suggestionInput.suggested ? "true" : undefined}
            placeholder={suggestionInput.placeholder}
            ref={textareaRef}
            rows={3}
            value={prompt}
          />
        }
        typeahead={
          slash.open ? (
            <ComposerSlashTypeahead controller={slash} />
          ) : (
            <>
              {mention.open ? (
                <ThreadMentionTypeahead
                  activeIndex={mention.activeIndex}
                  {...(threadMentions.composer?.busy === undefined
                    ? {}
                    : { busy: threadMentions.composer.busy })}
                  candidates={threadMentions.composer?.candidates ?? []}
                  listId={mentionListId}
                  onChoose={mention.choose}
                  onHover={mention.setActiveIndex}
                />
              ) : null}
              {fileMentionOpen ? (
                <PathMentionTypeahead
                  activeIndex={fileMentions.activeIndex}
                  busy={fileMentions.busy}
                  candidates={fileMentions.candidates}
                  listId={fileMentionListId}
                  onChoose={fileMentions.choose}
                  onHover={fileMentions.setActiveIndex}
                />
              ) : null}
            </>
          )
        }
        row={{
          leading: (
            <>
              {props.turnClient === undefined ? null : (
                <>
                  <ComposerAttachButton
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    busy={creating || completionLocked}
                    refusedReason={
                      imageSupport === false
                        ? "The selected model does not accept images. Choose an image-capable model."
                        : undefined
                    }
                    onRefused={images.refuse}
                    onFileSelected={(file) => images.attach([file])}
                  />
                </>
              )}
              {props.imageGenerationClient === undefined ||
              props.imageGenerationProfiles === undefined ? null : (
                <ImageGenerationAction
                  client={props.imageGenerationClient}
                  disabled={completionLocked}
                  {...(props.onOpenImageSettings === undefined
                    ? {}
                    : { onOpenSettings: props.onOpenImageSettings })}
                  presentation="icon"
                  profiles={props.imageGenerationProfiles}
                  scopeId={decodeImageGenerationScopeId(String(props.threadId))}
                  threadKind="work-thread"
                />
              )}
              {thread?.lifecycle === "active" && !completionLocked ? (
                <OctantMenu
                  items={[
                    {
                      value: "complete",
                      label: "Mark done",
                      icon: <Check aria-hidden="true" size={14} />,
                      disabled: completing || providerChanging || creating,
                    },
                    ...(thread.documentDelivery === "native-artifacts"
                      ? [
                          {
                            value: "canvas",
                            label: "Use Canvas instead of Claude artifacts",
                            disabled: deliveryChanging,
                          },
                        ]
                      : artifactsChoosable
                        ? [
                            {
                              value: "native-artifacts",
                              label: "Use Claude artifacts instead of Canvas",
                              disabled: deliveryChanging,
                            },
                          ]
                        : []),
                  ]}
                  onValueChange={(value) => {
                    if (value === "canvas") void changeDocumentDelivery("canvas");
                    else if (value === "native-artifacts") setConfirmArtifacts(true);
                    else setCompletionFormOpen(true);
                  }}
                  selectionMode="action"
                  trigger={<Ellipsis aria-hidden="true" size={16} />}
                  triggerClassName="shell-icon-button"
                  triggerLabel="Task actions"
                  value=""
                />
              ) : null}
            </>
          ),
          // Two groups: what the person adds sits left, how the task runs
          // (0073) sits right beside send. The model used to hug the attach
          // button, so it jumped sides between a new task and the thread it
          // became.
          trailing: (
            <>
              {thread === undefined ? null : (
                <span
                  aria-label="Bound provider and model"
                  className="work-thread-workspace__bound-model"
                >
                  <ComposerModelPicker
                    ariaLabel="Provider and model"
                    disabled={providerChanging || creating || completionLocked}
                    // Once any turn ran, the host checks the latest one
                    // whatever its status, so the thread's history lives with
                    // its provider kind; offering a move the host refuses led
                    // straight to a stuck thread.
                    groups={
                      turns.length > 0
                        ? startedConversationPickerGroups(props.providerGroups ?? [], {
                            providerInstanceId: thread.providerInstanceId,
                            modelId: thread.modelId,
                          })
                        : (props.providerGroups ?? [])
                    }
                    {...(thread.modelOptionValues === undefined
                      ? {}
                      : { modelOptionValues: thread.modelOptionValues })}
                    onModelOptionChange={(optionId, value) => {
                      const values = { ...thread.modelOptionValues };
                      if (value === undefined) delete values[optionId];
                      else values[optionId] = value;
                      void changeProvider({
                        providerInstanceId: thread.providerInstanceId,
                        modelId: thread.modelId,
                        modelOptionValues: values,
                      });
                    }}
                    onSelect={changeProvider}
                    {...(props.onOpenSettings === undefined
                      ? {}
                      : { onOpenSettings: props.onOpenSettings })}
                    selectedModelId={thread.modelId}
                    selectedProviderInstanceId={thread.providerInstanceId}
                  />
                </span>
              )}
              <ComposerVoiceButton
                disabled={creating || completionLocked}
                onTranscript={(transcript) =>
                  rememberDraft(appendTranscript(prompt, transcript), null)
                }
              />
            </>
          ),
          actions: {
            kind: "send-or-stop",
            cellClassName: "composer-actions",
            sending: turnRunning,
            send: {
              ariaLabel: queueFollowUp
                ? "Queue message"
                : props.turnClient === undefined && !turnRunning
                  ? "Create artifact"
                  : "Send follow-up",
              disabled: !canSubmit,
              onSend: () => void submit(),
            },
            stop: {
              ariaLabel: "Stop turn",
              ...(props.turnClient === undefined || stoppableTurn === undefined
                ? { disabledReason: "Stopping is available once the turn has started." }
                : {}),
              onStop: () => void onStop(),
            },
          },
        }}
        footer={
          <div aria-live="polite" className="composer-status">
            {errorMessage === undefined ? null : (
              /* ui-boundary-exception: compact-status */
              <span className="composer-status__notice" role="alert" title={errorMessage}>
                {errorMessage}
              </span>
            )}
            {handoffNotice === undefined || completionLocked || turnRunning ? null : (
              <span className="composer-status__hint" role="status">
                {handoffNotice}
              </span>
            )}
            {completionLocked || turnRunning || props.turnClient === undefined ? (
              <span className="composer-status__hint" role="status">
                {completionLocked
                  ? "Reactivate this task before creating another file or changing its provider."
                  : turnRunning
                    ? "Submit adds this message to the host queue"
                    : "Enter saves a Markdown artifact · Shift+Enter for a new line"}
              </span>
            ) : null}
          </div>
        }
      />
    </section>
  );
}
