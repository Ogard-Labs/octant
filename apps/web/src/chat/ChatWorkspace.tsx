import type { ProviderModelOptionValues } from "@octant/contracts";
import {
  decodeChatAttachmentId,
  type ChatAttachmentId,
  type ChatAttempt,
  type ChatResearchRouting,
  type ChatThread,
  type ChatThreadView,
  type ChatTurnId,
} from "@octant/contracts/chat";
import type { MentionableThreadId, SideChatSidecar } from "@octant/contracts";
import type { ThreadMentionClient } from "@octant/client-runtime";
import {
  buildAttachmentCapability,
  buildImageAttachmentCapability,
  supportsAttachmentFile,
} from "./composerAttachmentCapability";
import { pastedImageName } from "./composerImagePaste";
import { COMPOSER_STAGED_DROPPED_NOTE } from "../composer/composerThreadDraftStore";
import { useThreadMentions } from "./useThreadMentions";
import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type { PreviewContextSelection } from "@octant/contracts/previews";
import type { ProviderObservedState, ProviderRegistrySnapshot } from "@octant/contracts/providers";
import { decodeProviderModelId } from "@octant/contracts/providers";
import { startedConversationPickerGroups, type PickerGroup } from "@octant/domain";
import { buildComposerPoolModel } from "@octant/domain/composer-pool-policy";
import { useEffect, useRef, useState } from "react";
import { useThreadMessageQueue } from "../messageQueue/useThreadMessageQueue";
import { ThreadMessageQueue } from "../messageQueue/ThreadMessageQueue";
import type { ThreadMessageQueueClient } from "../messageQueue/threadMessageQueueClient";
import { ComposerPoolControl } from "../providers/ComposerPoolControl";
import {
  ChatComposer,
  type ChatComposerAttachmentCapability,
  type ChatComposerExtensionSelection,
  type ChatComposerThreadMentionChip,
  type ChatComposerModelOption,
  type ChatComposerOption,
  type ChatComposerProps,
  type ChatComposerResearchBackend,
} from "./ChatComposer";
import { ChatThreadActionsMenu } from "./ChatThreadActionsMenu";
import { ChatTranscript } from "./ChatTranscript";
import { formatOutgoingMessageWithQuotes, type TranscriptQuoteChip } from "./quoteSelection";
import {
  unattachedCapabilityMentionCopy,
  unattachedCapabilityMentions,
} from "@octant/plugin-host/capability-mentions";
import { useThreadCheckpoints } from "../checkpoints/useThreadCheckpoints";
import { ThreadWorkShelf } from "./ThreadWorkShelf";
import type { ChatController } from "./useChatController";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import type { BrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import { useExtensionDraftSelections } from "./useExtensionDraftSelections";
import { LinkedThreadParallelReviewFlow } from "../linkedThread/LinkedThreadParallelReviewFlow";
import { useLinkedThreadParallelReview } from "../linkedThread/useLinkedThreadParallelReview";
import { isReviewInParallelReference } from "../linkedThread/parseReviewInParallelDraft";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { listEligibleImageProfiles } from "@octant/domain";
import { GeneratedImageList } from "../image/GeneratedImageList";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { ThreadHandOffOutcome } from "@octant/contracts/thread-hand-off";
import type { HostId } from "@octant/contracts/host";
import { activeChatTurns } from "@octant/domain/chat-policy";
import { CanvasCreatePanel } from "../canvas/CanvasCreatePanel";
import { CanvasThreadReferenceCardList } from "../canvas/CanvasThreadReferenceCardList";
import { ThreadCanvases } from "../canvas/InlineThreadCanvas";
import { placeThreadCanvases, threadTurnSpans } from "../canvas/threadCanvasPlacement";
import { useThreadCanvasCards } from "../canvas/useThreadCanvasCards";
import { buildCanvasCreationContext } from "../canvas/buildCanvasCreationContext";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { ExtensionToolApprovalPrompt } from "../extensions/ExtensionToolApprovalPrompt";
import { ShellState } from "../shell/ShellState";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantAlert } from "../ui/base/OctantAlert";
import {
  ThreadConnectionLostContext,
  ThreadConnectionNotice,
} from "../transcript/ThreadConnectionNotice";

export interface ChatWorkspaceProps {
  readonly controller: ChatController;
  readonly extensionClient?: ExtensionClient;
  readonly browserAutomationClient?: BrowserAutomationClient;
  readonly narrow?: boolean;
  readonly onAttachCanvasContext?: (selection: CanvasContextSelection) => void;
  readonly onClearCanvasSelections?: () => void;
  readonly onRemoveCanvasSelection?: ChatComposerProps["onRemoveCanvasSelection"];
  readonly pendingCanvasSelections?: ReadonlyArray<CanvasContextSelection>;
  readonly providerSnapshot?: ProviderRegistrySnapshot;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly onOpenSettings?: () => void;
  readonly pendingExtensionSelections?: ReadonlyArray<ChatComposerExtensionSelection>;
  readonly onRemoveExtensionSelection?: ChatComposerProps["onRemoveExtensionSelection"];
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly messageQueueClient?: ThreadMessageQueueClient;
  readonly canvasClient?: CanvasClient;
  readonly imageGenerationClient?: ImageGenerationClient;
  readonly hostId?: HostId;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  /** Told which Canvas the host wrote when the thread is handed off. */
  readonly onThreadHandedOff?: (threadId: string, outcome: ThreadHandOffOutcome) => void;
  /** The Canvas cards the host lists for this thread, each time they are read. */
  readonly onCanvasReferencesObserved?: (
    threadId: string,
    cards: ReadonlyArray<CanvasThreadReferenceCard>,
  ) => void;
  /** Injected thread-mention client; otherwise built from serverUrl. */
  readonly threadMentionClient?: ThreadMentionClient;
  /** Called with the host's sidecar linkage so the shell can open its tab. */
  readonly onOpenSideChat?: (sidecar: SideChatSidecar) => void;
  /** Called with the thread a branch command created, so the shell can open it. */
  readonly onThreadBranched?: (thread: ChatThread) => void;
  /** Scroll the transcript to this turn when the thread view is ready. */
  readonly revealTurnId?: ChatTurnId;
}

/**
 * The composer's single message slot. Uploads are tracked separately, because
 * one paste can start several at once and a single slot cannot say when the
 * last of them has settled.
 */
type AttachmentStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "removing"; readonly fileName: string }
  | { readonly kind: "failed"; readonly message: string };

interface PendingAttachment {
  readonly id: ChatAttachmentId;
  readonly displayName: string;
}

interface ChatSendContext {
  readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
  readonly previewSelections: ReadonlyArray<PreviewContextSelection>;
  readonly canvasSelections: ReadonlyArray<CanvasContextSelection>;
  readonly quotes: ReadonlyArray<TranscriptQuoteChip>;
  readonly extensionReceipts: ReadonlyArray<ChatComposerExtensionSelection>;
  readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
  readonly threadMentionChips: ReadonlyArray<ChatComposerThreadMentionChip>;
}

/**
 * The authoritative thread state a queued model option change builds on.
 *
 * The provider and model travel with the version because an option control is
 * rendered against one model. A queued command that assumes a different model
 * than the one the thread has actually reached cannot be applied as written.
 */
interface ModelOptionBase {
  readonly threadId: string;
  readonly version: ChatThread["version"];
  readonly providerInstanceId: ChatThread["providerInstanceId"];
  readonly modelId: ChatThread["modelId"];
  readonly values: Readonly<Record<string, string>>;
}

const ACTIVE_TOOL_APPROVAL_POLL_MS = 500;
const IDLE_TOOL_APPROVAL_POLL_MS = 5_000;

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const view = props.controller.activeView;
  const [pendingAttachments, setPendingAttachments] = useState<ReadonlyArray<PendingAttachment>>(
    [],
  );
  const [pendingPreviewSelections, setPendingPreviewSelections] = useState<
    ReadonlyArray<PreviewContextSelection>
  >([]);
  const [localCanvasSelections, setLocalCanvasSelections] = useState<
    ReadonlyArray<CanvasContextSelection>
  >([]);
  const [pendingQuotes, setPendingQuotes] = useState<ReadonlyArray<TranscriptQuoteChip>>([]);
  const [canvasRefreshKey, setCanvasRefreshKey] = useState(0);
  const settledTurnCount =
    view === undefined
      ? 0
      : view.turns.filter((turn) => {
          const attempt = turn.attempts.at(-1);
          return (
            attempt !== undefined && attempt.outcome !== "queued" && attempt.outcome !== "streaming"
          );
        }).length;
  const chatStarted = view !== undefined && view.turns.some((turn) => turn.attempts.length > 0);
  const [canvasPanelOpen, setCanvasPanelOpen] = useState(false);
  const [browserApprovals, setBrowserApprovals] = useState<ReadonlyArray<BrowserToolApproval>>([]);
  const [toolApprovalBusy, setToolApprovalBusy] = useState(false);
  const [browserApprovalMessage, setBrowserApprovalMessage] = useState<string | undefined>(
    undefined,
  );
  // One branch dispatch at a time: a second click while the server is still
  // creating the first branch would mint a second thread, not retry the first.
  const [branchPending, setBranchPending] = useState(false);
  const pendingCanvasSelections = props.pendingCanvasSelections ?? localCanvasSelections;
  const [attachmentStatus, setAttachmentStatus] = useState<AttachmentStatus>({ kind: "idle" });
  // A send refused before the host saw it explains itself beside the composer,
  // since no turn exists to carry a reason.
  const [sendNotice, setSendNotice] = useState<string>();
  // Every upload still in flight, so the composer's busy state describes the
  // whole batch a multi-image paste starts. Releasing Send when the first one
  // lands would let a later arrival join the pending list after the turn was
  // sent, and be attached to the *next* message.
  const [uploadingAttachments, setUploadingAttachments] = useState<
    ReadonlyArray<PendingAttachment>
  >([]);
  const activeThread = view?.thread;
  const activeThreadId = activeThread?.id;
  // Tool approvals only arrive while a turn is running, so the fast poll is
  // reserved for that; an idle thread checks rarely. At a flat 500ms every
  // open Chat thread kept two requests a second going for as long as it was
  // on screen.
  const turnActive = view !== undefined && latestActiveAttempt(view) !== undefined;
  const pendingAttachmentsRef = useRef<ReadonlyArray<PendingAttachment>>([]);
  // Attachments captured by a queue submission stay visible in the composer,
  // but their cleanup ownership moves here until that message is accepted or
  // abandoned. This keeps unmount cleanup from purging bytes the host accepted.
  const deferredAttachmentsRef = useRef<ReadonlyArray<PendingAttachment>>([]);
  const cancelledUploadsRef = useRef(new Set<string>());
  const uploadingAttachmentsRef = useRef<ReadonlyArray<PendingAttachment>>([]);
  const pendingExtensionRef = useRef<ReadonlyArray<ChatComposerExtensionSelection>>([]);
  const threadMentionChipsRef = useRef<ReadonlyArray<ChatComposerThreadMentionChip>>([]);
  const pendingCanvasRef = useRef<ReadonlyArray<CanvasContextSelection>>([]);
  const pendingPreviewRef = useRef<ReadonlyArray<PreviewContextSelection>>([]);
  const pendingQuotesRef = useRef<ReadonlyArray<TranscriptQuoteChip>>([]);
  const discardAttachmentRef = useRef(props.controller.discard);
  const markDraftStagedDroppedRef = useRef(props.controller.markDraftStagedDropped);
  const mountedRef = useRef(true);
  const activeThreadIdRef = useRef<string | undefined>(
    activeThread === undefined ? undefined : String(activeThread.id),
  );
  const draftEditRevisionRef = useRef(0);
  const messageQueue = useThreadMessageQueue({
    mode: "chat",
    hostId: props.hostId,
    draft: {
      text: props.controller.pendingDraft,
      revision: draftEditRevisionRef.current,
      clear: () => props.controller.setPendingDraft(""),
    },
    onRecoveredRefused: async (command) => {
      if (
        command.kind !== "enqueue" ||
        command.payload.mode !== "chat" ||
        activeThreadId === undefined
      )
        return;
      await Promise.allSettled(
        (command.payload.attachmentIds ?? []).map((attachmentId) =>
          props.controller.discard({ threadId: activeThreadId, attachmentId }),
        ),
      );
    },
    threadId: activeThreadId === undefined ? undefined : String(activeThreadId),
    serverUrl: props.serverUrl,
    windowCapability: props.windowCapability,
    client: props.messageQueueClient,
  });
  const checkpoints = useThreadCheckpoints({
    threadId: String(activeThreadId ?? ""),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  // Every composer command that carries the thread's expected version shares
  // one queue. Two of them dispatched before the first round trip returns
  // would otherwise both send the rendered version, so the second is rejected
  // as stale and its payload omits the first choice. Queued instead, each one
  // waits for the previous command's authoritative thread and builds on it.
  const threadCommandQueueRef = useRef<Promise<ModelOptionBase | undefined>>(
    Promise.resolve(undefined),
  );
  discardAttachmentRef.current = props.controller.discard;
  markDraftStagedDroppedRef.current = props.controller.markDraftStagedDropped;
  activeThreadIdRef.current = activeThread === undefined ? undefined : String(activeThread.id);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    const threadId = activeThread?.id;
    if (threadId === undefined) return;
    return () => {
      const abandoned = pendingAttachmentsRef.current;
      pendingAttachmentsRef.current = [];
      // Keep the visible chips in step with the cleared ledger; on unmount
      // this is a no-op, on a thread change it drops the old thread's chips.
      setPendingAttachments([]);
      setPendingQuotes([]);
      const droppedStagedContext =
        abandoned.length > 0 ||
        uploadingAttachmentsRef.current.length > 0 ||
        pendingExtensionRef.current.length > 0 ||
        pendingCanvasRef.current.length > 0 ||
        pendingPreviewRef.current.length > 0;
      if (droppedStagedContext) {
        markDraftStagedDroppedRef.current?.(String(threadId));
      }
      for (const attachment of abandoned) {
        void discardAttachmentRef
          .current({ threadId, attachmentId: attachment.id })
          .catch(() => undefined);
      }
    };
  }, [activeThread?.id]);
  const activeProvider = props.providerSnapshot?.instances.find(
    (instance) => String(instance.id) === String(activeThread?.providerInstanceId),
  );
  const extensionDraft = useExtensionDraftSelections({
    ...(props.extensionClient === undefined ? {} : { client: props.extensionClient }),
    ...(activeProvider === undefined
      ? {}
      : { providerFamily: activeProvider.driverKind as ExtensionProviderFamily }),
    ...(activeThread === undefined ? {} : { thread: activeThread }),
  });
  useEffect(() => {
    const client = props.browserAutomationClient;
    const listApprovals = client?.listApprovals;
    if (listApprovals === undefined || activeThreadId === undefined) {
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
            approvals.filter((approval) => String(approval.threadId) === String(activeThreadId)),
          );
        }
      } catch {
        if (!controller.signal.aborted) setBrowserApprovals([]);
      } finally {
        inFlight = false;
      }
    };
    const stop = scheduleVisibleInterval(
      () => void refresh(),
      turnActive ? ACTIVE_TOOL_APPROVAL_POLL_MS : IDLE_TOOL_APPROVAL_POLL_MS,
      { runImmediately: true },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [activeThreadId, props.browserAutomationClient, turnActive]);
  const threadMentions = useThreadMentions({
    ...(props.threadMentionClient === undefined ? {} : { client: props.threadMentionClient }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: props.controller.pendingDraft,
    dialogueEnabled: true,
    ...(props.onOpenSideChat === undefined ? {} : { onSideChatOpened: props.onOpenSideChat }),
  });
  threadMentionChipsRef.current = threadMentions.chips;
  const parallelReview = useLinkedThreadParallelReview({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    ...(activeThread === undefined ? {} : { thread: activeThread }),
  });
  uploadingAttachmentsRef.current = uploadingAttachments;
  pendingCanvasRef.current = pendingCanvasSelections;
  pendingPreviewRef.current = pendingPreviewSelections;
  pendingExtensionRef.current = props.pendingExtensionSelections ?? extensionDraft.receipts;
  pendingQuotesRef.current = pendingQuotes;
  // Read before the early return below, which would otherwise change the hook
  // order. The transcript draws the inline Canvases; the Canvas tools panel
  // lists the rest.
  const threadCanvases = useThreadCanvasCards({
    client: props.canvasClient,
    mode: "chat",
    threadId: view?.thread.id,
    projectId: view?.thread.projectId ?? null,
    // A settled turn may have authored a Canvas; re-read the cards so the
    // document appears without reopening the thread.
    refreshKey: canvasRefreshKey + settledTurnCount,
    ...(props.onCanvasReferencesObserved === undefined || view === undefined
      ? {}
      : {
          onCardsObserved: (cards: ReadonlyArray<CanvasThreadReferenceCard>) =>
            props.onCanvasReferencesObserved?.(String(view.thread.id), cards),
        }),
  });
  if (view === undefined) {
    return (
      <section aria-label="Chat workspace" className="chat-workspace">
        <div className="chat-workspace__load-state">
          <ShellState
            action={{ label: "Retry chat", onClick: props.controller.retry }}
            message={
              props.controller.errorMessage ??
              (props.controller.status === "disconnected"
                ? "The host connection is unavailable."
                : "Reading this thread from the host.")
            }
            role={props.controller.status === "disconnected" ? "alert" : "status"}
            state={props.controller.status === "disconnected" ? "disconnected" : "loading"}
            title={
              props.controller.status === "disconnected"
                ? "Chat is disconnected"
                : "Loading conversation"
            }
          />
        </div>
      </section>
    );
  }
  const thread = view.thread;
  const connectionLost = props.controller.status === "disconnected";
  const canvasClient = props.canvasClient;
  const canvasPlacement = placeThreadCanvases(
    threadTurnSpans(
      activeChatTurns(view.turns),
      (turn) => String(turn.id),
      (turn) => turn.createdAt,
    ),
    threadCanvases.cards,
  );
  const canvasPanelId = `chat-canvas-panel-${thread.id}`;
  const pendingExtensionSelections = props.pendingExtensionSelections ?? extensionDraft.receipts;
  const removeExtensionSelection = props.onRemoveExtensionSelection ?? extensionDraft.remove;
  const pendingBrowserApproval = browserApprovals[0];

  async function decideBrowserApproval(decision: "approved" | "denied") {
    if (
      pendingBrowserApproval === undefined ||
      props.browserAutomationClient?.decideApproval === undefined ||
      toolApprovalBusy
    ) {
      return;
    }
    setToolApprovalBusy(true);
    setBrowserApprovalMessage(undefined);
    try {
      await props.browserAutomationClient.decideApproval({
        approvalId: pendingBrowserApproval.approvalId,
        decision,
      });
      setBrowserApprovals((current) =>
        current.filter((approval) => approval.approvalId !== pendingBrowserApproval.approvalId),
      );
    } catch {
      setBrowserApprovalMessage(
        "Browser approval could not be sent. Keep this request open and retry.",
      );
    } finally {
      setToolApprovalBusy(false);
    }
  }

  const providerState = providerPresentation(props.providerSnapshot, view);
  const activeAttempt = latestActiveAttempt(view);
  const isSending = activeAttempt !== undefined;
  const queueFollowUp =
    isSending ||
    view.turns.at(-1)?.attempts.at(-1)?.outcome === "waiting" ||
    messageQueue.busy ||
    messageQueue.uncertain ||
    (messageQueue.snapshot?.items.length ?? 0) > 0 ||
    messageQueue.snapshot?.paused === true ||
    messageQueue.snapshot?.holdReason !== undefined;
  // Chat pool routing is server-owned and evaluated against LOCAL_HOST_ID, so
  // composer pool candidates always carry the "local" host.
  const composerPoolModel = buildComposerPoolModel({
    snapshot: props.providerSnapshot,
    hostId: "local" as HostId,
    mode: "chat",
    current: {
      providerInstanceId: view.thread.providerInstanceId,
      modelId: view.thread.modelId,
    },
  });
  const attachmentCapability: ChatComposerAttachmentCapability = buildAttachmentCapability(
    providerState.observation,
  );
  // Images ride the ordinary attachment path but need their own honest check:
  // a provider can accept documents while the selected model rejects images.
  const imageAttachmentCapability: ChatComposerAttachmentCapability =
    buildImageAttachmentCapability(providerState.observation, view.thread.modelId);
  const firstUpload = uploadingAttachments[0];
  const uploadingMessage =
    firstUpload === undefined
      ? undefined
      : uploadingAttachments.length === 1
        ? `Uploading ${firstUpload.displayName}.`
        : `Uploading ${uploadingAttachments.length} attachments.`;

  /**
   * Run one thread command after every command already queued.
   *
   * `run` receives the authoritative thread state the previous command
   * reported, when it reported one, and returns the state the next command
   * should build on. A command that moves the thread's version for a reason
   * this queue cannot describe returns no base, so the next one starts from
   * the rendered thread instead of a version the server has moved past.
   */
  function enqueueThreadCommand<T>(
    run: (previous: ModelOptionBase | undefined) => Promise<{
      readonly value: T;
      readonly base?: ModelOptionBase | undefined;
    }>,
  ): Promise<T> {
    const queued = threadCommandQueueRef.current;
    const settled = (async () => {
      const previous = await queued;
      return await run(previous);
    })();
    // A refused command leaves the queue empty so the next one starts from the
    // reloaded thread rather than a version the server rejected.
    threadCommandQueueRef.current = settled.then(
      (outcome) => outcome.base,
      () => undefined,
    );
    return settled.then((outcome) => outcome.value);
  }

  function baseFromResult(
    result: Awaited<ReturnType<typeof props.controller.execute>>,
  ): ModelOptionBase | undefined {
    return result?.kind === "thread-updated"
      ? {
          threadId: String(result.thread.id),
          version: result.thread.version,
          providerInstanceId: result.thread.providerInstanceId,
          modelId: result.thread.modelId,
          values: result.thread.modelOptionValues ?? {},
        }
      : undefined;
  }

  /**
   * The authoritative thread state the next queued command builds on: the one a
   * command already in flight produced, or the rendered thread's when the queue
   * is empty. Reading the rendered state while another command is settling is
   * what makes the second command stale, so every versioned thread mutation
   * goes through here.
   */
  function queuedBase(previous: ModelOptionBase | undefined): ModelOptionBase {
    return previous !== undefined && previous.threadId === String(thread.id)
      ? previous
      : {
          threadId: String(thread.id),
          version: thread.version,
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
          values: thread.modelOptionValues ?? {},
        };
  }

  function queuedVersion(previous: ModelOptionBase | undefined): ChatThread["version"] {
    return queuedBase(previous).version;
  }

  function changeModelOption(optionId: string, value: string | undefined) {
    // The control carries the provider and model it was rendered for. A model
    // switch still settling ahead of this change moves the thread off them, and
    // `change-chat-provider` names the model it applies to — re-sending the
    // rendered one on the authoritative version would silently switch the
    // thread back. An option for a model the thread has left has nothing left
    // to apply to, so it is dropped rather than reinterpreted.
    const renderedProviderInstanceId = String(thread.providerInstanceId);
    const renderedModelId = String(thread.modelId);
    void enqueueThreadCommand(async (previous) => {
      const base = queuedBase(previous);
      if (
        String(base.providerInstanceId) !== renderedProviderInstanceId ||
        String(base.modelId) !== renderedModelId
      ) {
        return { value: undefined, base: previous };
      }
      const { [optionId]: _cleared, ...rest } = base.values;
      const result = await props.controller.execute({
        kind: "change-chat-provider",
        threadId: thread.id,
        expectedVersion: base.version,
        providerInstanceId: base.providerInstanceId,
        modelId: base.modelId,
        modelOptionValues: value === undefined ? rest : { ...rest, [optionId]: value },
      });
      return { value: undefined, base: baseFromResult(result) };
    }).catch(() => undefined);
  }

  /** Select a provider/model behind the same queue an option change uses. */
  function selectProviderModel(selection: {
    readonly providerInstanceId: ChatThread["providerInstanceId"];
    readonly modelId: ChatThread["modelId"];
    readonly modelOptionValues?: ProviderModelOptionValues;
  }) {
    return enqueueThreadCommand(async (previous) => {
      const result = await props.controller.execute({
        kind: "change-chat-provider",
        threadId: thread.id,
        expectedVersion: queuedVersion(previous),
        providerInstanceId: selection.providerInstanceId,
        modelId: selection.modelId,
        ...(selection.modelOptionValues === undefined
          ? {}
          : { modelOptionValues: selection.modelOptionValues }),
      });
      return { value: undefined, base: baseFromResult(result) };
    }).catch(() => undefined);
  }

  async function changeResearch(input: {
    readonly enabled: boolean;
    readonly routing: ChatResearchRouting;
  }) {
    await enqueueThreadCommand(async (previous) => {
      const result = await props.controller.execute({
        kind: "change-chat-research",
        threadId: thread.id,
        expectedVersion: queuedVersion(previous),
        researchEnabled: input.enabled,
        researchRouting: input.routing,
      });
      return { value: undefined, base: baseFromResult(result) };
    }).catch(() => undefined);
  }

  function deferredAttachmentIds(): Set<string> {
    return new Set(deferredAttachmentsRef.current.map((attachment) => String(attachment.id)));
  }

  function appendPendingAttachment(attachment: PendingAttachment): void {
    setPendingAttachments((current) => {
      const next = [...current, attachment];
      const deferredIds = deferredAttachmentIds();
      pendingAttachmentsRef.current = next.filter(
        (candidate) => !deferredIds.has(String(candidate.id)),
      );
      return next;
    });
  }

  function consumeContext(context: ChatSendContext): void {
    const attachmentIds = new Set(context.attachmentIds.map((id) => String(id)));
    setPendingAttachments((current) => {
      const next = current.filter((attachment) => !attachmentIds.has(String(attachment.id)));
      pendingAttachmentsRef.current = next;
      return next;
    });
    const previewIds = new Set(context.previewSelections.map((selection) => String(selection.id)));
    setPendingPreviewSelections((current) =>
      current.filter((selection) => !previewIds.has(String(selection.id))),
    );
    const quoteIds = new Set(context.quotes.map((quote) => quote.id));
    setPendingQuotes((current) => current.filter((quote) => !quoteIds.has(quote.id)));
    const canvasIds = new Set(context.canvasSelections.map((selection) => String(selection.id)));
    if (props.pendingCanvasSelections === undefined) {
      setLocalCanvasSelections((current) =>
        current.filter((selection) => !canvasIds.has(String(selection.id))),
      );
    } else if (props.onRemoveCanvasSelection !== undefined) {
      for (const selection of context.canvasSelections) {
        props.onRemoveCanvasSelection(selection.id);
      }
    } else if (
      props.onClearCanvasSelections !== undefined &&
      pendingCanvasSelections.length === context.canvasSelections.length &&
      pendingCanvasSelections.every((selection) => canvasIds.has(String(selection.id)))
    ) {
      // Keep the legacy all-clear fallback only when no newer selection exists
      // and this send owns every controlled selection.
      props.onClearCanvasSelections();
    }
    const currentExtensionSelections = pendingExtensionRef.current;
    if (props.pendingExtensionSelections === undefined) {
      for (const receipt of context.extensionReceipts) {
        // Remove only the receipt object this send captured. A newer draft may
        // have removed and re-added the same reference; deleting by reference
        // alone would steal that newer context.
        if (currentExtensionSelections.some((candidate) => candidate === receipt)) {
          extensionDraft.remove(receipt.reference);
        }
      }
    } else if (props.onRemoveExtensionSelection !== undefined) {
      for (const receipt of context.extensionReceipts) {
        if (currentExtensionSelections.some((candidate) => candidate === receipt)) {
          props.onRemoveExtensionSelection(receipt.reference);
        }
      }
    }
    const mentionComposer = threadMentions.composer;
    if (mentionComposer !== undefined) {
      for (const chip of context.threadMentionChips) {
        // `onRemoveChip` accepts an id for user interactions, but a send owns
        // one concrete chip instance. Check identity first so an older send
        // cannot remove a same-id chip re-added to a newer draft.
        if (threadMentionChipsRef.current.some((candidate) => candidate === chip)) {
          mentionComposer.onRemoveChip(chip.threadId);
        }
      }
    }
  }

  const submitTurn = async (draft: string): Promise<boolean> => {
    const extensionReceiptsForSend = pendingExtensionRef.current;
    // Refusing before anything is claimed keeps the staged attachments and
    // context with the draft the user fixes.
    const unattachedMentions = unattachedCapabilityMentions(
      draft,
      extensionReceiptsForSend.flatMap((receipt) =>
        receipt.selection === undefined ? [] : [receipt.selection],
      ),
    );
    if (unattachedMentions.length > 0) {
      setSendNotice(unattachedCapabilityMentionCopy(unattachedMentions));
      return false;
    }
    setSendNotice(undefined);
    const claimedAttachments = pendingAttachmentsRef.current;
    pendingAttachmentsRef.current = [];
    const quotesForSend = pendingQuotesRef.current;
    const previewSelectionsForSend = pendingPreviewSelections;
    const canvasSelectionsForSend = pendingCanvasSelections;
    const threadMentionChipsForSend = [...threadMentions.chips];
    // A `#thread` chip names a thread; it never carries one. The turn
    // sends chip ids and the host resolves each one as the turn runs,
    // re-checking that the sender may still open it, so the message
    // stays exactly what the user typed and no later turn replays a
    // thread they pointed at once. This check is the composer's own
    // report: a chip the host refuses is shown as unavailable rather
    // than silently dropped.
    const sendingThreadId = String(view.thread.id);
    const threadMentionIds = await threadMentions.resolveForSend();
    if (activeThreadIdRef.current !== sendingThreadId) return false;
    const outgoing = formatOutgoingMessageWithQuotes({ draft, quotes: quotesForSend });
    const attachmentIds = claimedAttachments.map((attachment) => attachment.id);
    if (outgoing.trim().length === 0 && attachmentIds.length === 0) return false;
    const context: ChatSendContext = {
      attachmentIds,
      canvasSelections: canvasSelectionsForSend,
      extensionReceipts: extensionReceiptsForSend,
      previewSelections: previewSelectionsForSend,
      quotes: quotesForSend,
      threadMentionIds,
      threadMentionChips: threadMentionChipsForSend,
    };
    let sent = false;
    try {
      // Behind the same queue as a model or option change: a turn sent
      // in the same breath as one of those must run the settings the
      // person just chose, not the ones the composer last rendered. The
      // version the earlier command reached travels with the send, since
      // this closure still holds the view from the render that made it.
      // The turn moves the version itself, so it carries no base forward.
      sent = await enqueueThreadCommand(async (previous) => ({
        value: await props.controller.sendTurn(
          outgoing,
          attachmentIds,
          previewSelectionsForSend,
          canvasSelectionsForSend,
          extensionReceiptsForSend.flatMap((item) =>
            item.selection === undefined ? [] : [item.selection],
          ),
          threadMentionIds,
          // Only a send that follows one of this composer's own commands
          // knows a newer version; every other send leaves the
          // controller's own rendered version alone.
          ...(previous !== undefined && previous.threadId === String(thread.id)
            ? ([previous.version] as const)
            : ([] as const)),
        ),
      }));
    } catch (error) {
      {
        recoverClaimedAttachments(
          claimedAttachments,
          mountedRef.current,
          view.thread.id,
          pendingAttachmentsRef,
          discardAttachmentRef,
        );
      }
      throw error;
    }
    if (sent) {
      consumeContext(context);
    } else {
      recoverClaimedAttachments(
        claimedAttachments,
        mountedRef.current,
        view.thread.id,
        pendingAttachmentsRef,
        discardAttachmentRef,
      );
    }
    return sent;
  };

  return (
    <ThreadConnectionLostContext value={connectionLost}>
      <section aria-label="Chat workspace" className="chat-workspace">
        <ThreadConnectionNotice connected={!connectionLost} onRetry={props.controller.retry} />
        {/* While the connection is lost, the failure the controller recorded is
          that loss, which the notice above already says. */}
        {props.controller.errorMessage === undefined || connectionLost ? null : (
          <OctantAlert className="chat-workspace__error" tone="danger">
            {props.controller.errorMessage}
          </OctantAlert>
        )}
        <div className="chat-workspace__conversation">
          <header className="chat-workspace__header">
            <h1 className="sr-only">{view.thread.title}</h1>
            <ChatThreadActionsMenu
              connectionStatus={
                props.controller.status === "disconnected" ? "disconnected" : "connected"
              }
              {...(props.onThreadHandedOff === undefined
                ? {}
                : {
                    onHandedOff: (outcome: ThreadHandOffOutcome) =>
                      props.onThreadHandedOff?.(String(view.thread.id), outcome),
                  })}
              view={view}
              {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
              {...(props.windowCapability === undefined
                ? {}
                : { windowCapability: props.windowCapability })}
              {...(props.canvasClient === undefined
                ? {}
                : {
                    canvas: {
                      open: canvasPanelOpen,
                      onToggle: () => setCanvasPanelOpen((current) => !current),
                    },
                  })}
            />
          </header>
          {props.canvasClient === undefined || !canvasPanelOpen ? null : (
            <section
              aria-label="Canvas tools"
              className="chat-workspace__canvas thread-column"
              id={canvasPanelId}
            >
              <CanvasCreatePanel
                client={props.canvasClient}
                context={buildCanvasCreationContext({
                  hostId: props.hostId ?? ("local" as HostId),
                  mode: "chat",
                  originThreadId: thread.id,
                  projectId: thread.projectId ?? null,
                })}
                onCreated={() => {
                  setCanvasRefreshKey((current) => current + 1);
                  setCanvasPanelOpen(false);
                }}
              />
              <CanvasThreadReferenceCardList
                cards={threadCanvases.cards.filter(
                  (card) => !canvasPlacement.placed.has(String(card.canvasId)),
                )}
                error={threadCanvases.error}
                {...(props.onOpenCanvas === undefined ? {} : { onOpen: props.onOpenCanvas })}
              />
            </section>
          )}
          {props.imageGenerationClient === undefined ? null : (
            <GeneratedImageList
              client={props.imageGenerationClient}
              onAttach={(file) => {
                const displayName = file.name;
                const attachmentId = decodeChatAttachmentId(crypto.randomUUID());
                const threadId = view.thread.id;
                void (async () => {
                  try {
                    const buffer = await file.arrayBuffer();
                    if (!mountedRef.current || activeThreadIdRef.current !== String(threadId)) {
                      return;
                    }
                    await props.controller.upload({
                      threadId,
                      attachmentId,
                      displayName,
                      mediaType: file.type || "image/png",
                      bytes: new Uint8Array(buffer),
                    });
                    if (!mountedRef.current || activeThreadIdRef.current !== String(threadId)) {
                      await discardAttachmentRef
                        .current({ threadId, attachmentId })
                        .catch(() => undefined);
                      return;
                    }
                    appendPendingAttachment({ id: attachmentId, displayName });
                  } catch {
                    await discardAttachmentRef
                      .current({ threadId, attachmentId })
                      .catch(() => undefined);
                    if (mountedRef.current && activeThreadIdRef.current === String(threadId)) {
                      setAttachmentStatus({
                        kind: "failed",
                        message: `${displayName} could not be attached. Try again.`,
                      });
                    }
                  }
                })();
              }}
              profiles={listEligibleImageProfiles(props.providerSnapshot?.instances ?? [])}
              scopeId={decodeImageGenerationScopeId(String(thread.id))}
              threadKind="chat-thread"
            />
          )}
          <ChatTranscript
            {...(canvasClient === undefined
              ? {}
              : {
                  afterTurn: (turn: ChatThreadView["turns"][number]) => (
                    <ThreadCanvases
                      cards={canvasPlacement.byRow.get(String(turn.id))}
                      client={canvasClient}
                      // Chat has no dock, so the Canvas opens as a tab beside the thread.
                      {...(props.onOpenCanvas === undefined ? {} : { onOpen: props.onOpenCanvas })}
                      openLabel="Open Canvas"
                    />
                  ),
                })}
            busy={isSending || branchPending}
            {...(props.revealTurnId === undefined ? {} : { revealTurnId: props.revealTurnId })}
            {...(checkpoints.available
              ? {
                  checkpoints: {
                    byTurnId: checkpoints.byAnchor,
                    busy: checkpoints.busy,
                    ...(checkpoints.message === undefined ? {} : { message: checkpoints.message }),
                    onForget: (checkpoint) => void checkpoints.forget(checkpoint),
                    onMark: (turnId, label) =>
                      void checkpoints.mark(
                        { mode: "chat", threadId: view.thread.id, turnId },
                        label,
                      ),
                    onRestore: (checkpoint, title) => {
                      void (async () => {
                        const restored = await checkpoints.restore(checkpoint, title);
                        // The host owns the new thread; refreshing navigation is
                        // what puts it in front of the user rather than leaving it
                        // somewhere only the journal knows about.
                        if (restored !== undefined) await props.controller.refreshNavigation();
                      })();
                    },
                  },
                }
              : {})}
            {...(props.providerGroups === undefined
              ? {}
              : { providerGroups: props.providerGroups })}
            onQuoteSelection={({ turnId, text }) => {
              setPendingQuotes((current) => [
                ...current,
                {
                  id: crypto.randomUUID(),
                  turnId: String(turnId),
                  text,
                },
              ]);
            }}
            onBranchTurn={(turnId) => {
              if (branchPending) return;
              setBranchPending(true);
              void (async () => {
                try {
                  const result = await props.controller.execute({
                    kind: "branch-chat-thread",
                    threadId: view.thread.id,
                    expectedVersion: view.thread.version,
                    turnId,
                    title: branchTitle(view.thread.title),
                  });
                  // The server owns the branch; opening it is the only honest
                  // acknowledgement — silence here left the thread invisible.
                  if (result?.kind === "thread-created") props.onThreadBranched?.(result.thread);
                } finally {
                  if (mountedRef.current) setBranchPending(false);
                }
              })();
            }}
            onEditTurn={(turnId, prompt) => {
              // Behind the same queue as a model or option change: an edit sent on
              // the rendered version while one of those is settling is refused as
              // stale, and the person's revision is lost with no second chance.
              void enqueueThreadCommand(async (previous) => {
                const result = await props.controller.execute({
                  kind: "edit-chat-turn",
                  threadId: view.thread.id,
                  expectedVersion: queuedVersion(previous),
                  turnId,
                  prompt,
                });
                return { value: undefined, base: baseFromResult(result) };
              }).catch(() => undefined);
            }}
            onRetryAttempt={(turnId, attemptId) => {
              void enqueueThreadCommand(async (previous) => {
                const result = await props.controller.execute({
                  kind: "retry-chat-turn",
                  threadId: view.thread.id,
                  expectedVersion: queuedVersion(previous),
                  turnId,
                  attemptId,
                });
                return { value: undefined, base: baseFromResult(result) };
              }).catch(() => undefined);
            }}
            onScheduleUsageResume={(turnId, attemptId) => {
              void enqueueThreadCommand(async (previous) => {
                const result = await props.controller.execute({
                  kind: "schedule-chat-usage-resume",
                  threadId: view.thread.id,
                  expectedVersion: queuedVersion(previous),
                  turnId,
                  attemptId,
                });
                return { value: undefined, base: baseFromResult(result) };
              }).catch(() => undefined);
            }}
            onCancelUsageResume={() => {
              void enqueueThreadCommand(async (previous) => {
                const result = await props.controller.execute({
                  kind: "cancel-chat-usage-resume",
                  threadId: view.thread.id,
                  expectedVersion: queuedVersion(previous),
                });
                return { value: undefined, base: baseFromResult(result) };
              }).catch(() => undefined);
            }}
            onSnoozeAtUsageReset={() => {
              void enqueueThreadCommand(async (previous) => {
                const result = await props.controller.execute({
                  kind: "snooze-chat-thread-at-usage-reset",
                  threadId: view.thread.id,
                  expectedVersion: queuedVersion(previous),
                });
                return { value: undefined, base: baseFromResult(result) };
              }).catch(() => undefined);
            }}
            onAnswerQuestion={({ turnId, attemptId, requestId, answer }) => {
              void enqueueThreadCommand(async (previous) => {
                const result = await props.controller.execute({
                  kind: "answer-chat-turn-question",
                  threadId: view.thread.id,
                  expectedVersion: queuedVersion(previous),
                  turnId,
                  attemptId,
                  requestId,
                  answer,
                });
                return { value: undefined, base: baseFromResult(result) };
              }).catch(() => undefined);
            }}
            onDismissQuestion={(turnId, attemptId) => {
              void enqueueThreadCommand(async (previous) => {
                const result = await props.controller.execute({
                  kind: "interrupt-chat-turn",
                  threadId: view.thread.id,
                  expectedVersion: queuedVersion(previous),
                  turnId,
                  attemptId,
                });
                return { value: undefined, base: baseFromResult(result) };
              }).catch(() => undefined);
            }}
            view={view}
          />
        </div>
        {view.workItems.length === 0 && view.followUp?.state !== "open" ? null : (
          <ThreadWorkShelf
            aggregateVersion={view.workListVersion}
            followUpVersion={view.followUpVersion}
            {...(view.followUp === undefined ? {} : { followUp: view.followUp })}
            items={view.workItems}
            {...(props.narrow === undefined ? {} : { narrow: props.narrow })}
            onCancel={(command) => void props.controller.execute(command)}
            onComplete={(command) => void props.controller.execute(command)}
            onCompleteFollowUp={(command) => void props.controller.execute(command)}
            onEdit={(command) => void props.controller.execute(command)}
          />
        )}
        <ExtensionToolApprovalPrompt
          className="chat-workspace__tool-approval thread-column"
          client={props.extensionClient}
          threadId={activeThreadId === undefined ? undefined : String(activeThreadId)}
          turnActive={turnActive}
        />
        {pendingBrowserApproval === undefined ? null : (
          <OctantApprovalCard
            actions={
              <>
                <OctantButton
                  disabled={toolApprovalBusy}
                  onClick={() => void decideBrowserApproval("approved")}
                  size="sm"
                  type="button"
                >
                  Approve once
                </OctantButton>
                <OctantButton
                  disabled={toolApprovalBusy}
                  onClick={() => void decideBrowserApproval("denied")}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Deny
                </OctantButton>
              </>
            }
            className="chat-workspace__tool-approval thread-column"
            detail="Shell and file access stay unchanged"
            error={browserApprovalMessage}
            label="Browser origin approval"
            summary={`Allow Browser to open ${pendingBrowserApproval.origin}?`}
          />
        )}
        <ChatComposer
          key={String(thread.id)}
          attachment={attachmentCapability}
          attachmentBusy={uploadingMessage !== undefined || attachmentStatus.kind === "removing"}
          {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
          {...(props.providerSnapshot === undefined || props.imageGenerationClient === undefined
            ? {}
            : {
                imageGeneration: {
                  profiles: listEligibleImageProfiles(props.providerSnapshot.instances),
                  scopeId: decodeImageGenerationScopeId(String(thread.id)),
                  client: props.imageGenerationClient,
                  ...(props.onOpenSettings === undefined
                    ? {}
                    : { onOpenSettings: props.onOpenSettings }),
                },
              })}
          draft={props.controller.pendingDraft}
          caretRestoreKey={String(thread.id)}
          {...(props.controller.pendingDraftCaret === undefined
            ? {}
            : { caretIndex: props.controller.pendingDraftCaret })}
          {...(props.controller.setPendingDraftCaret === undefined
            ? {}
            : { onCaretIndexChange: props.controller.setPendingDraftCaret })}
          isSending={isSending}
          queueing={queueFollowUp}
          queue={
            <ThreadMessageQueue
              connectionLost={connectionLost}
              queue={messageQueue}
              showUnavailable={queueFollowUp}
            />
          }
          model={{
            // Without picker groups there is no ownership to reason about, so a
            // started thread's fallback keeps only its own model.
            options: chatStarted
              ? providerState.modelOptions.filter(
                  (option) => option.id === String(view.thread.modelId),
                )
              : providerState.modelOptions,
            value: view.thread.modelId,
          }}
          onDraftChange={(draft, caretIndex) => {
            draftEditRevisionRef.current += 1;
            props.controller.setPendingDraft(draft, caretIndex);
          }}
          imageAttachment={imageAttachmentCapability}
          onImagePasteRejected={(reason) =>
            setAttachmentStatus({ kind: "failed", message: reason })
          }
          {...(threadMentions.composer === undefined
            ? {}
            : { threadMentions: threadMentions.composer })}
          onFileSelected={(file) => {
            // A pasted image usually has no file name; name it once so the chip,
            // its remove control, and any failure message all agree.
            const displayName = pastedImageName(file);
            if (!supportsAttachmentFile(providerState.observation, view.thread.modelId, file)) {
              setAttachmentStatus({
                kind: "failed",
                message: `${displayName} is unavailable to the selected provider and model.`,
              });
              return;
            }
            const attachmentId = decodeChatAttachmentId(crypto.randomUUID());
            // A new attempt supersedes whatever an earlier one reported; a
            // sibling upload's failure in this batch is set after this point and
            // therefore survives until the batch drains.
            setAttachmentStatus({ kind: "idle" });
            setUploadingAttachments((current) => [...current, { id: attachmentId, displayName }]);
            const settleUpload = () =>
              setUploadingAttachments((current) =>
                current.filter((upload) => upload.id !== attachmentId),
              );
            void (async () => {
              try {
                const buffer = await file.arrayBuffer();
                if (
                  !mountedRef.current ||
                  activeThreadIdRef.current !== String(view.thread.id) ||
                  cancelledUploadsRef.current.has(String(attachmentId))
                ) {
                  cancelledUploadsRef.current.delete(String(attachmentId));
                  settleUpload();
                  await discardAttachmentRef
                    .current({ threadId: view.thread.id, attachmentId })
                    .catch(() => undefined);
                  return;
                }
                await props.controller.upload({
                  threadId: view.thread.id,
                  attachmentId,
                  displayName,
                  mediaType: file.type,
                  bytes: new Uint8Array(buffer),
                });
                if (
                  !mountedRef.current ||
                  activeThreadIdRef.current !== String(view.thread.id) ||
                  cancelledUploadsRef.current.has(String(attachmentId))
                ) {
                  cancelledUploadsRef.current.delete(String(attachmentId));
                  settleUpload();
                  await discardAttachmentRef
                    .current({ threadId: view.thread.id, attachmentId })
                    .catch(() => undefined);
                  return;
                }
                appendPendingAttachment({ id: attachmentId, displayName });
                settleUpload();
              } catch {
                settleUpload();
                await discardAttachmentRef
                  .current({ threadId: view.thread.id, attachmentId })
                  .catch(() => undefined);
                if (mountedRef.current && activeThreadIdRef.current === String(view.thread.id)) {
                  setAttachmentStatus({
                    kind: "failed",
                    message: `${displayName} could not be attached. Paste or choose it again to retry.`,
                  });
                }
              }
            })();
          }}
          onModelChange={(modelId) => {
            // The same queue as the picker rail's selection: a model switch the
            // queue cannot see is one an option change cannot know it has to
            // stand down for.
            selectProviderModel({
              providerInstanceId: view.thread.providerInstanceId,
              modelId: decodeProviderModelId(modelId),
            });
          }}
          modelOptions={providerState.declaredModelOptions}
          onModelOptionChange={changeModelOption}
          {...(props.providerGroups === undefined
            ? {}
            : {
                // Any earlier attempt ties the thread to its provider kind: the
                // host checks the latest attempt whatever its outcome. See
                // startedConversationPickerGroups for which moves stay open.
                providerGroups: chatStarted
                  ? startedConversationPickerGroups(props.providerGroups, {
                      providerInstanceId: view.thread.providerInstanceId,
                      modelId: view.thread.modelId,
                    })
                  : props.providerGroups,
                selectedProviderInstanceId: view.thread.providerInstanceId,
                selectedModelId: view.thread.modelId,
                onSelectModel: (selection: {
                  readonly providerInstanceId: (typeof view.thread)["providerInstanceId"];
                  readonly modelId: (typeof view.thread)["modelId"];
                  readonly modelOptionValues?: ProviderModelOptionValues;
                }) => selectProviderModel(selection),
              })}
          onProviderChange={(providerId) => {
            const selection = providerState.available.find(
              (candidate) => String(candidate.instance.id) === providerId,
            );
            const model = selection?.observation.models[0];
            if (selection === undefined || model === undefined) return;
            selectProviderModel({
              providerInstanceId: selection.instance.id,
              modelId: model.id,
            });
          }}
          onResearchEnabledChange={(enabled) =>
            void changeResearch({ enabled, routing: view.thread.researchRouting })
          }
          onResearchRoutingChange={(routing) =>
            void changeResearch({ enabled: view.thread.researchEnabled, routing })
          }
          onSend={async (draft) => {
            if (!queueFollowUp) return await submitTurn(draft);
            if (!messageQueue.available || messageQueue.busy || messageQueue.uncertain)
              return false;
            const revision = draftEditRevisionRef.current;
            const origin = String(view.thread.id);
            const claimed = [...pendingAttachmentsRef.current];
            const context = {
              attachmentIds: claimed.map((attachment) => attachment.id),
              previewSelections: [...pendingPreviewRef.current],
              canvasSelections: [...pendingCanvasRef.current],
              quotes: [...pendingQuotesRef.current],
              extensionReceipts: [...pendingExtensionRef.current],
              threadMentionChips: [...threadMentions.chips],
            };
            const extensionSelections = context.extensionReceipts.flatMap((receipt) =>
              receipt.selection === undefined ? [] : [receipt.selection],
            );
            const unattached = unattachedCapabilityMentions(draft, extensionSelections);
            if (unattached.length > 0) {
              setSendNotice(unattachedCapabilityMentionCopy(unattached));
              return false;
            }
            pendingAttachmentsRef.current = [];
            deferredAttachmentsRef.current = claimed;
            const releaseClaim = () => {
              const ids = new Set(claimed.map((entry) => String(entry.id)));
              deferredAttachmentsRef.current = deferredAttachmentsRef.current.filter(
                (entry) => !ids.has(String(entry.id)),
              );
            };
            const restoreClaim = () => {
              releaseClaim();
              recoverClaimedAttachments(
                claimed,
                mountedRef.current && activeThreadIdRef.current === origin,
                view.thread.id,
                pendingAttachmentsRef,
                discardAttachmentRef,
              );
            };
            try {
              const threadMentionIds = await threadMentions.resolveForSend();
              if (!mountedRef.current || activeThreadIdRef.current !== origin) {
                restoreClaim();
                return false;
              }
              const result = await messageQueue.enqueue(
                {
                  mode: "chat",
                  prompt: formatOutgoingMessageWithQuotes({ draft, quotes: context.quotes }),
                  attachmentIds: context.attachmentIds,
                  previewSelections: context.previewSelections,
                  canvasSelections: context.canvasSelections,
                  extensionSelections,
                  threadMentionIds,
                },
                () => {
                  releaseClaim();
                  if (!mountedRef.current || activeThreadIdRef.current !== origin) return;
                  consumeContext({ ...context, threadMentionIds });
                  if (draftEditRevisionRef.current === revision)
                    props.controller.setPendingDraft("");
                },
                restoreClaim,
                { text: draft, revision },
              );
              return result === "accepted";
            } catch {
              restoreClaim();
              return false;
            }
          }}
          pendingCanvasSelections={pendingCanvasSelections}
          pendingAttachments={pendingAttachments}
          attachmentRemovalDisabled={messageQueue.busy || messageQueue.uncertain}
          pendingPreviewSelections={pendingPreviewSelections}
          pendingQuotes={pendingQuotes}
          pendingExtensionSelections={pendingExtensionSelections}
          {...(!queueFollowUp ||
          (messageQueue.available && !messageQueue.uncertain && !messageQueue.busy)
            ? {}
            : {
                sendDisabledReason: !messageQueue.available
                  ? connectionLost
                    ? "Waiting for the host to reconnect."
                    : "The host message queue is unavailable."
                  : messageQueue.uncertain
                    ? "Check the previous queue change before sending another message."
                    : "Waiting for the host queue…",
              })}
          onRemoveExtensionSelection={removeExtensionSelection}
          onRemoveQuote={(quoteId) => {
            setPendingQuotes((current) => current.filter((quote) => quote.id !== quoteId));
          }}
          onRemoveAttachment={(attachmentId) => {
            const attachment = pendingAttachmentsRef.current.find(
              (candidate) => candidate.id === attachmentId,
            );
            if (attachment === undefined) return;
            setAttachmentStatus({ kind: "removing", fileName: attachment.displayName });
            void props.controller
              .discard({ threadId: view.thread.id, attachmentId })
              .then(() => {
                setPendingAttachments((current) => {
                  const next = current.filter((candidate) => candidate.id !== attachmentId);
                  pendingAttachmentsRef.current = next;
                  return next;
                });
                setAttachmentStatus({ kind: "idle" });
              })
              .catch(() => {
                setAttachmentStatus({
                  kind: "failed",
                  message: `${attachment.displayName} could not be removed. Try again.`,
                });
              });
          }}
          onResolveExtensionReference={async (draft) => {
            if (isReviewInParallelReference(draft)) {
              const started = await parallelReview.startFromDraft(draft);
              if (started) props.controller.setPendingDraft("");
              return started;
            }
            const resolved = await extensionDraft.resolveReference(draft);
            if (resolved) props.controller.setPendingDraft("");
            return resolved;
          }}
          onRemoveCanvasSelection={
            props.onRemoveCanvasSelection ??
            ((selectionId) =>
              setLocalCanvasSelections((current) =>
                current.filter((selection) => selection.id !== selectionId),
              ))
          }
          onRemovePreviewSelection={(selectionId) =>
            setPendingPreviewSelections((current) =>
              current.filter((selection) => selection.id !== selectionId),
            )
          }
          {...(activeAttempt === undefined
            ? {}
            : {
                onStop: () => {
                  void props.controller.execute({
                    kind: "interrupt-chat-turn",
                    threadId: view.thread.id,
                    expectedVersion: view.thread.version,
                    turnId: activeAttempt.turnId,
                    attemptId: activeAttempt.id,
                  });
                },
              })}
          poolControl={
            <ComposerPoolControl
              model={composerPoolModel}
              onApply={async (pool) =>
                await enqueueThreadCommand(async (previous) => {
                  const result = await props.controller.execute({
                    kind: "select-chat-multi-model-pool",
                    threadId: view.thread.id,
                    expectedVersion: queuedVersion(previous),
                    pool,
                  });
                  return {
                    value: result?.kind === "thread-updated",
                    base: baseFromResult(result),
                  };
                }).catch(() => false)
              }
              pool={view.thread.multiModelPool}
            />
          }
          provider={{
            options: chatStarted
              ? providerState.providerOptions.filter(
                  (option) => option.id === String(view.thread.providerInstanceId),
                )
              : providerState.providerOptions,
            value: String(view.thread.providerInstanceId),
          }}
          research={{
            backend: researchBackend(props.controller, providerState.observation, view),
            enabled: view.thread.researchEnabled,
            routing: view.thread.researchRouting,
          }}
          {...(providerState.selectionReady
            ? uploadingMessage !== undefined
              ? { sendDisabledReason: uploadingMessage }
              : attachmentStatus.kind === "removing"
                ? { sendDisabledReason: `Removing ${attachmentStatus.fileName}.` }
                : attachmentStatus.kind === "failed" || sendNotice !== undefined
                  ? {
                      statusMessage: composeComposerNotice(
                        attachmentStatus.kind === "failed" ? attachmentStatus.message : sendNotice,
                        props.controller.draftStagedDropped,
                        props.controller.draftPersistError,
                      ),
                    }
                  : composerNoticeProps(
                      props.controller.draftStagedDropped,
                      props.controller.draftPersistError,
                    )
            : { sendDisabledReason: "Choose an available provider and model before sending." })}
        />
        <LinkedThreadParallelReviewFlow
          controller={parallelReview}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
        />
      </section>
    </ThreadConnectionLostContext>
  );
}

function composeComposerNotice(
  message: string | undefined,
  stagedDropped: boolean | undefined,
  persistError: string | undefined,
): string {
  const parts: string[] = [];
  if (stagedDropped === true) parts.push(COMPOSER_STAGED_DROPPED_NOTE);
  if (persistError !== undefined) parts.push(persistError);
  if (message !== undefined && message.trim() !== "") parts.push(message);
  return parts.join(" ");
}

function composerNoticeProps(
  stagedDropped: boolean | undefined,
  persistError: string | undefined,
): { readonly statusMessage?: string } {
  const statusMessage = composeComposerNotice(undefined, stagedDropped, persistError);
  return statusMessage.length === 0 ? {} : { statusMessage };
}

function recoverClaimedAttachments(
  attachments: ReadonlyArray<PendingAttachment>,
  mounted: boolean,
  threadId: ChatThreadView["thread"]["id"],
  pendingRef: React.MutableRefObject<ReadonlyArray<PendingAttachment>>,
  discardRef: React.MutableRefObject<ChatController["discard"]>,
): void {
  if (mounted) {
    // An upload that settled during the failed send already appended itself to
    // the ref; overwriting with only the claimed batch would orphan it from
    // the ledger while its chip stays visible. Merge instead, claimed first,
    // matching the visible chip order the state still holds.
    const claimed = new Set(attachments.map((attachment) => String(attachment.id)));
    pendingRef.current = [
      ...attachments,
      ...pendingRef.current.filter((attachment) => !claimed.has(String(attachment.id))),
    ];
    return;
  }
  for (const attachment of attachments) {
    void discardRef.current({ threadId, attachmentId: attachment.id }).catch(() => undefined);
  }
}

/**
 * Title for a branch. The server owns the branch's scope and provenance; only
 * its human-readable name comes from here, and it stays inside the title bound
 * the contract enforces.
 */
function branchTitle(sourceTitle: string): string {
  const suffix = " (branch)";
  const trimmed = sourceTitle.trim();
  const base = trimmed.length === 0 ? "Chat" : trimmed;
  return `${base.slice(0, 200 - suffix.length)}${suffix}`;
}

function latestActiveAttempt(view: ChatThreadView): ChatAttempt | undefined {
  for (let turnIndex = view.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = view.turns[turnIndex];
    if (turn === undefined) continue;
    const attempts = turn.attempts;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      const attempt = attempts[attemptIndex];
      if (attempt === undefined) continue;
      if (attempt.outcome === "queued" || attempt.outcome === "streaming") return attempt;
    }
  }
  return undefined;
}

function providerPresentation(
  snapshot: ProviderRegistrySnapshot | undefined,
  view: ChatThreadView,
) {
  const available: Array<{
    readonly instance: ProviderRegistrySnapshot["instances"][number];
    readonly observation: ProviderObservedState;
  }> = [];
  for (const instance of snapshot?.instances ?? []) {
    if (instance.enabled) {
      const observation = snapshot?.observedStates.find(
        (candidate) =>
          candidate.instanceId === instance.id &&
          (candidate.readiness === "ready" || candidate.readiness === "degraded"),
      );
      if (observation !== undefined) available.push({ instance, observation });
    }
  }
  const selected = available.find(
    (candidate) => candidate.instance.id === view.thread.providerInstanceId,
  );
  const selectedModel = selected?.observation.models.find(
    (model) => model.id === view.thread.modelId,
  );
  const configuredSelected = snapshot?.instances.find(
    (instance) => instance.id === view.thread.providerInstanceId,
  );
  const providerOptions: ReadonlyArray<ChatComposerOption> = available.map(({ instance }) => ({
    id: String(instance.id),
    label: instance.displayName,
  }));
  const modelOptions: ReadonlyArray<ChatComposerOption> = (selected?.observation.models ?? []).map(
    (model) => ({ id: model.id, label: model.displayName }),
  );
  const modelOptionValues = view.thread.modelOptionValues ?? {};
  const declaredModelOptions: ReadonlyArray<ChatComposerModelOption> = (
    selectedModel?.options ?? []
  ).flatMap((option) =>
    option.kind === "selection"
      ? [
          {
            id: option.id,
            displayName: option.displayName,
            values: option.values,
            ...(modelOptionValues[option.id] === undefined
              ? {}
              : { value: modelOptionValues[option.id] }),
          },
        ]
      : [],
  );
  return {
    available,
    declaredModelOptions,
    observation: selectedModel === undefined ? undefined : selected?.observation,
    providerLabel:
      selected?.instance.displayName ?? configuredSelected?.displayName ?? "Provider unavailable",
    modelLabel: selectedModel?.displayName ?? `${view.thread.modelId} unavailable`,
    providerOptions:
      selected === undefined
        ? [
            {
              id: String(view.thread.providerInstanceId),
              label: `${configuredSelected?.displayName ?? "Provider"} (unavailable)`,
              disabled: true,
            },
            ...providerOptions,
          ]
        : providerOptions,
    modelOptions:
      selectedModel === undefined
        ? [
            {
              id: view.thread.modelId,
              label: `${view.thread.modelId} (unavailable)`,
              disabled: true,
            },
            ...modelOptions,
          ]
        : modelOptions,
    selectionReady: selected !== undefined && selectedModel !== undefined,
  };
}

function researchBackend(
  controller: ChatController,
  observation: ProviderObservedState | undefined,
  view: ChatThreadView,
): ChatComposerResearchBackend {
  if (!view.thread.researchEnabled) return { kind: "disabled" };
  // For Foundry, the provider-level appManagedTools stays "unsupported" and
  // tools are gated per-model via verifiedToolModelIds. Use the same
  // effective tool-support check as the server: provider-level "supported"
  // OR the selected model is in verifiedToolModelIds.
  const effectiveAppManagedTools =
    observation?.capabilities.appManagedTools === "supported" ||
    (observation?.verifiedToolModelIds?.some((id) => String(id) === String(view.thread.modelId)) ??
      false);
  if (view.thread.researchRouting === "searxng") {
    return controller.bootstrap?.settings.searxngBaseUrl === undefined || !effectiveAppManagedTools
      ? { kind: "unavailable", reason: "SearXNG is not configured for this provider." }
      : { kind: "selected", backend: "searxng" };
  }
  if (view.thread.researchRouting === "provider-native") {
    return observation?.capabilities.nativeWebResearch === "supported"
      ? { kind: "selected", backend: "provider-native" }
      : { kind: "unavailable", reason: "Provider-native research is unsupported." };
  }
  if (controller.bootstrap?.settings.searxngBaseUrl !== undefined && effectiveAppManagedTools) {
    return { kind: "selected", backend: "searxng" };
  }
  return observation?.capabilities.nativeWebResearch === "supported"
    ? { kind: "selected", backend: "provider-native" }
    : { kind: "unavailable", reason: "No compatible research backend is available." };
}
