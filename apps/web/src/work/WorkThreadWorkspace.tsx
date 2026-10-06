import {
  BrowserUseMention,
  ComputerUseMention,
  useBrowserUseMention,
  useComputerUseMention,
} from "../computerUse/ComputerUseMention";
import { ComposerAttachButton } from "../composer/ComposerAttachButton";
import {
  decodeWorkAttachmentId,
  decodeWorkAttachmentMediaType,
  decodeThreadWorkingDirectory,
  decodeWorkMutationRequestId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type ProviderModelOptionValues,
  type UsageResumeThreadState,
  type WorkAttachmentId,
  type WorkRequest,
  type WorkThread,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnId,
  type WorkTurnState,
  type WorkTurnStreamFrame,
} from "@octant/contracts";
import type { ProjectSummary, ProjectId } from "@octant/contracts/projects";
import type { BrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import {
  pickerGroupCarriesAppManagedTools,
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
  type ComposerThreadDraftStore,
} from "../composer/composerThreadDraftStore";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import { useThreadMessageQueue } from "../messageQueue/useThreadMessageQueue";
import { ThreadMessageQueue } from "../messageQueue/ThreadMessageQueue";
import type { ThreadMessageQueueClient } from "../messageQueue/threadMessageQueueClient";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { OctantMenu } from "../ui/base/OctantMenu";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ComposerVoiceButton } from "../voice/ComposerVoiceButton";
import { appendTranscript } from "../voice/appendTranscript";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView } from "@octant/contracts";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import {
  unattachedCapabilityMentionCopy,
  unattachedCapabilityMentions,
} from "@octant/plugin-host/capability-mentions";
import { GeneratedImageList } from "../image/GeneratedImageList";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { CanvasThreadReferenceCardList } from "../canvas/CanvasThreadReferenceCardList";
import { ThreadCanvases } from "../canvas/InlineThreadCanvas";
import { placeThreadCanvases, threadTurnSpans } from "../canvas/threadCanvasPlacement";
import { useThreadCanvasCards } from "../canvas/useThreadCanvasCards";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../chat/ThreadMentionPicker";
import { useThreadMentions } from "../chat/useThreadMentions";
import { clipboardHasImage } from "../chat/composerImagePaste";
import { PathMentionTypeahead } from "../code/CodePathMentionPicker";
import { selectedModelReadsImages, useWorkComposerImages } from "./composer/useWorkComposerImages";
import { WorkImageAttachmentChips } from "./composer/WorkImageAttachmentChips";
import { useWorkFileMentions } from "./useWorkFileMentions";
import { samePollingData } from "../polling/samePollingData";
import { TrackerReferenceComposerHints } from "../tracker/TrackerReferenceComposerHints";
import { TrackerReferenceText } from "../tracker/TrackerReferenceText";
import { AssistantMessageBody } from "../transcript/AssistantMessageBody";
import {
  documentIsVisible,
  scheduleVisibleInterval,
  waitUntilDocumentVisible,
} from "../polling/documentVisibility";
import { TranscriptWindow } from "../transcript/TranscriptWindow";
import { ThreadTasksPanel } from "../transcript/ThreadTasksPanel";
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
import { providerModelLabel } from "../providers/providerModelLabel";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { providerFamilyForThread } from "../providers/providerFamily";
import { useExtensionDraftSelections } from "../chat/useExtensionDraftSelections";
import {
  ComposerSlashTypeahead,
  useComposerSlashCommands,
} from "../composer/useComposerSlashCommands";

type WorkTranscriptRow =
  | { readonly kind: "empty"; readonly key: "empty" }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly entry: WorkTurnState["transcript"][number];
      readonly streaming: boolean;
      /** When the person's message was accepted; assistant entries carry the time on their header. */
      readonly at?: string;
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
      return "failed";
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
  readonly hostId?: HostId;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly messageQueueClient?: ThreadMessageQueueClient;
  readonly extensionClient?: ExtensionClient;
  readonly browserAvailable?: boolean;
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

function applyWorkTurnStreamFrame(
  turns: ReadonlyArray<WorkTurnState>,
  frame: WorkTurnStreamFrame,
): ReadonlyArray<WorkTurnState> {
  if (frame.kind === "snapshot-required") return turns;
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
  readonly replace: (snapshot: WorkThreadTranscript) => void;
}): Promise<void> {
  let cursor = input.afterSequence;
  let retryMs = 250;
  while (input.active() && !input.signal.aborted) {
    try {
      let received = false;
      for await (const frame of input.client.subscribe(input.threadId, cursor, input.signal)) {
        if (!input.active() || input.signal.aborted) return;
        received = true;
        if (frame.kind === "snapshot-required") {
          const snapshot = await input.client.transcript(input.threadId, input.signal);
          if (!input.active() || input.signal.aborted) return;
          input.replace(snapshot);
          cursor = snapshot.liveCursor;
          break;
        }
        cursor = frame.sequence;
        input.apply(frame);
      }
      retryMs = received ? 50 : Math.min(retryMs * 2, 2_000);
    } catch {
      if (!input.active() || input.signal.aborted) return;
      retryMs = Math.min(retryMs * 2, 2_000);
    }
    await waitForWorkStreamReconnect(input.signal, retryMs);
  }
}

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
  const computer = useComputerUseMention({
    textarea: () => textareaRef.current,
    draft: prompt,
    scopeKey: String(props.threadId),
    onDraftChange: (next, caret) => composerDraft.setDraft(next, caret),
    onSelectionEdited: () => composerDraft.setDraft(composerDraft.text),
  });
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
  const browser = useBrowserUseMention({
    textarea: () => textareaRef.current,
    draft: composerDraft.text,
    onDraftChange: (next, caret) => composerDraft.setDraft(next, caret),
    scopeKey: String(props.threadId),
    available:
      props.browserAvailable === true &&
      pickerGroupCarriesAppManagedTools(
        props.providerGroups ?? [],
        thread === undefined
          ? undefined
          : { providerInstanceId: thread.providerInstanceId, modelId: thread.modelId },
      ),
    onChoose: () => void extensionDraft.resolveReference("@browser"),
  });
  const slash = useComposerSlashCommands({
    textarea: () => textareaRef.current,
    draft: composerDraft.text,
    onDraftChange: (next, caret) => composerDraft.setDraft(next, caret),
    onResolveExtensionReference: extensionDraft.resolveReference,
  });
  const [turns, setTurns] = useState<ReadonlyArray<WorkTurnState>>([]);
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
  const [completionEvidence, setCompletionEvidence] = useState("");
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
  }, [props.threadId]);
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
  const canSubmit =
    trimmed.length > 0 &&
    !creating &&
    !slash.resolving &&
    !completionLocked &&
    !messageQueue.busy &&
    !messageQueue.uncertain &&
    (!queueFollowUp || messageQueue.available) &&
    projectId !== undefined &&
    (props.turnClient !== undefined || props.mutationClient !== undefined);
  const settledTurnCount = turns.filter(
    (turn) => turn.status !== "accepted" && turn.status !== "running" && turn.status !== "waiting",
  ).length;
  const transcriptRows = useMemo<ReadonlyArray<WorkTranscriptRow>>(() => {
    const rows: WorkTranscriptRow[] = [];
    if (turns.length === 0) rows.push({ kind: "empty", key: "empty" });
    for (const [turnIndex, turn] of turns.entries()) {
      const head: WorkTranscriptRow = {
        kind: "head",
        key: `${String(turn.requestId)}-${String(turnIndex)}-head`,
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
          key: `${String(turn.requestId)}-${String(turnIndex)}-${entry.role}-${String(index)}`,
          entry,
          streaming:
            turn.status === "running" || turn.status === "accepted" || turn.status === "waiting",
          ...(entry.role === "user" ? { at: turn.acceptedAt } : {}),
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
          key: `${String(turn.requestId)}-${String(turnIndex)}-tasks`,
          turn,
          tasks: turn.tasks,
        });
      }
      // The files land after the turn that produced them, so the transcript
      // reads as what was said and then what came out of it.
      if (turn.wroteFiles !== undefined) {
        rows.push({
          kind: "files",
          key: `${String(turn.requestId)}-${String(turnIndex)}-files`,
          wrote: turn.wroteFiles,
        });
      }
    }
    for (const request of pendingRequests) {
      rows.push({ kind: "request", key: `request-${String(request.requestId)}`, request });
    }
    if (status !== undefined) rows.push({ kind: "status", key: "status", text: status });
    return rows;
  }, [pendingRequests, status, turns]);

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
          let transcript: WorkThreadTranscript;
          for (;;) {
            try {
              transcript = await turnClient.transcript(props.threadId, streamAbort.signal);
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
          setTurns((current) =>
            samePollingData(current, transcript.turns) ? current : transcript.turns,
          );
          props.onDisplayReadyChange?.(true);
          if (typeof turnClient.subscribe === "function") {
            void consumeWorkTurnStream({
              client: turnClient,
              threadId: props.threadId,
              afterSequence: transcript.liveCursor,
              signal: streamAbort.signal,
              active: () => !cancelled && requestGeneration === transcriptGeneration.current,
              apply: (frame) => setTurns((current) => applyWorkTurnStreamFrame(current, frame)),
              replace: (next) =>
                setTurns((current) =>
                  samePollingData(current, next.turns) ? current : next.turns,
                ),
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
          : turnClient.transcript(props.threadId, pollAbort.signal).then((next) => {
              if (cancelled || requestGeneration !== transcriptGeneration.current) return;
              setTurns((current) => (samePollingData(current, next.turns) ? current : next.turns));
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

  useEffect(() => {
    const client = props.browserAutomationClient;
    const listApprovals = client?.listApprovals;
    if (listApprovals === undefined) {
      setBrowserApprovals([]);
      return;
    }
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const approvals = await listApprovals(controller.signal);
        if (!controller.signal.aborted) {
          setBrowserApprovals(
            approvals.filter((approval) => String(approval.threadId) === String(props.threadId)),
          );
        }
      } catch {
        if (!controller.signal.aborted) setBrowserApprovals([]);
      } finally {
        inFlight = false;
      }
    };
    const stop = scheduleVisibleInterval(() => void refresh(), turnRunning ? 500 : 5_000, {
      runImmediately: true,
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [props.browserAutomationClient, props.threadId, turnRunning]);

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
      const computerUseSelection = computer.selection;
      const extensionSelections = extensionDraft.receipts.flatMap((receipt) =>
        receipt.selection === undefined ? [] : [receipt.selection],
      );
      const promptText = composerDraft.text;
      if (promptText.length === 0) return false;
      const unattachedMentions = unattachedCapabilityMentions(promptText, [
        ...extensionSelections,
        ...(computerUseSelection === undefined ? [] : [computerUseSelection]),
      ]);
      if (unattachedMentions.length > 0) {
        setErrorMessage(unattachedCapabilityMentionCopy(unattachedMentions));
        return false;
      }
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
              ...(computerUseSelection === undefined ? {} : { computerUseSelection }),
            },
            () => {
              if (currentThreadKeyRef.current !== sendingThreadId) return;
              images.consume(staged);
              computer.consume(computerUseSelection);
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
          ...(computerUseSelection === undefined ? {} : { computerUseSelection }),
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
        computer.consume(computerUseSelection);
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
      computer.selection,
      computer.consume,
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
    computer.selection,
    computer.consume,
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
    const evidence = completionEvidence.trim();
    if (
      thread === undefined ||
      completing ||
      thread.lifecycle !== "active" ||
      thread.completionConfirmed === true ||
      evidence.length === 0
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
        satisfactionEvidence: evidence,
      });
      if (!("kind" in result) || result.kind !== "thread-completion-confirmed") {
        setErrorMessage("This task could not be marked complete.");
        return;
      }
      setThread(result.thread);
      props.onThreadUpdated?.(result.thread);
      setCompletionFormOpen(false);
      setCompletionEvidence("");
      setStatus("Delivery marked complete.");
    } catch {
      setErrorMessage("This task could not be marked complete. Try again.");
    } finally {
      setCompleting(false);
    }
  }, [completing, completionEvidence, props.threadClient, thread]);

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
    if (computer.handleKeyDown(event)) return;
    if (browser.handleKeyDown(event)) return;
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
    computer.sync(value, caret);
    browser.sync(value, caret);
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

  return (
    <section aria-label="Task workspace" className="work-thread-workspace">
      <h1 className="sr-only">{props.title}</h1>

      {completionFormOpen && thread?.lifecycle === "active" && !completionLocked ? (
        <section aria-label="Mark this task complete" className="work-thread-workspace__completion">
          <p>
            Say what <strong>{thread.title}</strong> delivered. Octant records your words as the
            evidence that this task is done.
          </p>
          <OctantTextarea
            aria-label="What this task delivered"
            disabled={completing}
            onChange={(event) => setCompletionEvidence(event.target.value)}
            placeholder="Describe what was delivered…"
            rows={3}
            value={completionEvidence}
          />
          <OctantButton
            aria-label="Confirm this task is complete"
            disabled={completing || completionEvidence.trim().length === 0}
            onClick={() => void confirmCompletion()}
            size="sm"
            type="button"
            variant="default"
          >
            {completing ? "Confirming completion" : "Confirm completion"}
          </OctantButton>
        </section>
      ) : null}

      <TranscriptWindow
        ariaLabel="Work transcript"
        className="work-thread-workspace__conversation transcript-scroll"
        estimateSize={92}
        gap={20}
        itemKey={(row) => row.key}
        items={transcriptRows}
        listClassName="thread-column"
        {...(canvasClient === undefined
          ? {}
          : {
              afterItem: (row: WorkTranscriptRow) => (
                <ThreadCanvases
                  cards={canvasPlacement.byRow.get(row.key)}
                  client={canvasClient}
                  {...(openInSidebar === undefined ? {} : { onOpen: openInSidebar })}
                />
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
          props.imageGenerationClient === undefined ||
          props.imageGenerationProfiles === undefined ? null : (
            <div className="work-thread-workspace__transcript-trail">
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
        presentation="follow-up"
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
            <ComputerUseMention controller={computer} surface="chips" />
            <BrowserUseMention controller={browser} surface="chips" />
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
                      variant="ghost"
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
            aria-expanded={computer.open || browser.open || slash.open}
            aria-controls={
              computer.open
                ? computer.listId
                : browser.open
                  ? browser.listId
                  : slash.open
                    ? slash.listId
                    : undefined
            }
            aria-activedescendant={
              computer.open
                ? `${computer.listId}-computer`
                : browser.open
                  ? `${browser.listId}-browser`
                  : slash.active === undefined
                    ? undefined
                    : `${slash.listId}-${slash.active.id}`
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
            placeholder={turnRunning ? "Send the next message…" : "Reply…"}
            ref={textareaRef}
            rows={4}
            value={prompt}
          />
        }
        typeahead={
          computer.open ? (
            <ComputerUseMention controller={computer} surface="typeahead" />
          ) : browser.open ? (
            <BrowserUseMention controller={browser} surface="typeahead" />
          ) : slash.open ? (
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
              <ComposerVoiceButton
                disabled={creating || completionLocked}
                onTranscript={(transcript) =>
                  rememberDraft(appendTranscript(prompt, transcript), null)
                }
              />
              {thread?.lifecycle === "active" && !completionLocked ? (
                <OctantMenu
                  items={[
                    {
                      value: "complete",
                      label: "Mark complete",
                      icon: <Check aria-hidden="true" size={14} />,
                      disabled: completing || providerChanging || creating,
                    },
                  ]}
                  onValueChange={() => setCompletionFormOpen(true)}
                  selectionMode="action"
                  trigger={<Ellipsis aria-hidden="true" size={16} />}
                  triggerClassName="shell-icon-button"
                  triggerLabel="Task actions"
                  value=""
                />
              ) : null}
              {/* Two groups with space between: what the person adds sits left,
                  how the task runs (0073) sits right beside send. The model
                  used to hug the attach button, so it jumped sides between a
                  new task and the thread it became. */}
              <span aria-hidden="true" className="composer-gap" />
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
