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
import type { PickerGroup } from "@octant/domain";
import { buildComposerPoolModel } from "@octant/domain/composer-pool-policy";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSteeredSend } from "../composer/useSteeredSend";
import type { TurnSettlement } from "../composer/steeredSend";
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
import { useThreadCheckpoints } from "../checkpoints/useThreadCheckpoints";
import { ThreadWorkShelf } from "./ThreadWorkShelf";
import type { ChatController } from "./useChatController";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
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
import { CanvasCreatePanel } from "../canvas/CanvasCreatePanel";
import { CanvasThreadReferenceCardList } from "../canvas/CanvasThreadReferenceCardList";
import { buildCanvasCreationContext } from "../canvas/buildCanvasCreationContext";
import { OctantButton } from "../ui/base/OctantButton";
import { ShellState } from "../shell/ShellState";
import { samePollingData } from "../polling/samePollingData";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";

export interface ChatWorkspaceProps {
  readonly controller: ChatController;
  readonly extensionClient?: ExtensionClient;
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
  /**
   * Compact live child-run chrome for this thread. Rendered in the thread
   * header so it stays visible with the rest of the thread chrome.
   */
  readonly childRunStatus?: ReactNode;
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

/**
 * A message the user sent while a response was still streaming.
 *
 * Only the words travel with it: the images, chips, and selections stay in the
 * composer until the host accepts the message, so a refusal leaves the whole
 * message retryable rather than half-gone.
 */
interface ChatSteeredMessage {
  readonly id: string;
  readonly threadId: ChatThread["id"];
  readonly prompt: string;
  readonly draftEditRevision: number;
  readonly attachments: ReadonlyArray<PendingAttachment>;
  readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
  readonly previewSelections: ReadonlyArray<PreviewContextSelection>;
  readonly canvasSelections: ReadonlyArray<CanvasContextSelection>;
  readonly quotes: ReadonlyArray<TranscriptQuoteChip>;
  readonly extensionReceipts: ReadonlyArray<ChatComposerExtensionSelection>;
  readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
  readonly threadMentionChips: ReadonlyArray<ChatComposerThreadMentionChip>;
}

type ChatSendContext = Pick<
  ChatSteeredMessage,
  | "attachmentIds"
  | "previewSelections"
  | "canvasSelections"
  | "quotes"
  | "extensionReceipts"
  | "threadMentionIds"
  | "threadMentionChips"
>;

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
  const [canvasPanelOpen, setCanvasPanelOpen] = useState(false);
  const [toolApprovals, setToolApprovals] = useState<ReadonlyArray<ExtensionToolApproval>>([]);
  const [toolApprovalBusy, setToolApprovalBusy] = useState(false);
  // One branch dispatch at a time: a second click while the server is still
  // creating the first branch would mint a second thread, not retry the first.
  const [branchPending, setBranchPending] = useState(false);
  const pendingCanvasSelections = props.pendingCanvasSelections ?? localCanvasSelections;
  const [attachmentStatus, setAttachmentStatus] = useState<AttachmentStatus>({ kind: "idle" });
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
  // Attachments captured by a steered message stay visible in the composer,
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
  const threadMentionsRestoreRef = useRef<
    (chips: ReadonlyArray<ChatComposerThreadMentionChip>) => void
  >(() => {});
  const restoreContextAllowedRef = useRef(false);
  const discardAttachmentRef = useRef(props.controller.discard);
  const markDraftStagedDroppedRef = useRef(props.controller.markDraftStagedDropped);
  const mountedRef = useRef(true);
  const activeThreadIdRef = useRef<string | undefined>(
    activeThread === undefined ? undefined : String(activeThread.id),
  );
  const submitTurnRef = useRef<(message: ChatSteeredMessage) => Promise<boolean>>(
    async () => false,
  );
  // Read after an await, so a message sent mid-response sees the draft the user
  // has typed since rather than the one the render that started it captured.
  const pendingDraftRef = useRef(props.controller.pendingDraft);
  pendingDraftRef.current = props.controller.pendingDraft;
  const draftEditRevisionRef = useRef(0);
  const setPendingDraftRef = useRef(props.controller.setPendingDraft);
  setPendingDraftRef.current = props.controller.setPendingDraft;
  const steered = useSteeredSend<ChatSteeredMessage>({
    threadKey: activeThreadId === undefined ? undefined : String(activeThreadId),
    settlement: chatTurnSettlement(view),
    ready: uploadingAttachments.length === 0 && attachmentStatus.kind !== "removing",
    send: async (message) => {
      const laterDraft = pendingDraftRef.current;
      const draftEditRevision = draftEditRevisionRef.current;
      const restoreAllowed = () => {
        restoreContextAllowedRef.current =
          laterDraft.length === 0 &&
          draftEditRevisionRef.current === draftEditRevision &&
          draftEditRevision === message.draftEditRevision;
      };
      try {
        const sent = await submitTurnRef.current(message);
        restoreAllowed();
        if (sent) restoreContextAllowedRef.current = false;
        // The send path owns the composer for the message it is sending: it
        // clears the draft, and puts the message back if the host refused it.
        // A draft the user typed while this message was waiting belongs to
        // neither, so it goes back over whatever that left behind.
        if (laterDraft.length > 0 && draftEditRevisionRef.current === draftEditRevision) {
          setPendingDraftRef.current(laterDraft);
        }
        return sent;
      } catch (error) {
        // A throw follows the same retry/abandon policy as a false result. The
        // restore callback needs the same revision gate before the hook turns
        // the exception into a refused send.
        restoreAllowed();
        throw error;
      }
    },
    // The images, chips, and selections were never taken, so putting the words
    // back leaves the whole message retryable. A newer draft the user typed
    // while this one waited is the one worth keeping.
    restore: (message) => {
      const canRestore =
        mountedRef.current &&
        activeThreadIdRef.current === message.threadId &&
        restoreContextAllowedRef.current &&
        draftEditRevisionRef.current === message.draftEditRevision;
      if (!canRestore) {
        abandonDeferredContext(message);
        restoreContextAllowedRef.current = false;
        return;
      }
      if (pendingDraftRef.current.length === 0) setPendingDraftRef.current(message.prompt);
      threadMentionsRestoreRef.current(message.threadMentionChips);
      restoreDeferredAttachments();
      restoreContextAllowedRef.current = false;
    },
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
    if (props.extensionClient === undefined || activeThreadId === undefined) {
      setToolApprovals([]);
      return;
    }
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const approvals = await props.extensionClient!.listToolApprovals(controller.signal);
        if (!controller.signal.aborted) {
          const next = approvals.filter(
            (approval) => String(approval.threadId) === String(activeThreadId),
          );
          setToolApprovals((current) => (samePollingData(current, next) ? current : next));
        }
      } catch {
        if (!controller.signal.aborted) {
          setToolApprovals((current) => (current.length === 0 ? current : []));
        }
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
  }, [activeThreadId, props.extensionClient, turnActive]);
  const threadMentions = useThreadMentions({
    ...(props.threadMentionClient === undefined ? {} : { client: props.threadMentionClient }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: props.controller.pendingDraft,
    dialogueEnabled: true,
    ...(props.onOpenSideChat === undefined ? {} : { onSideChatOpened: props.onOpenSideChat }),
  });
  threadMentionsRestoreRef.current = threadMentions.restore;
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
  if (view === undefined) {
    return (
      <section aria-label="Chat workspace" className="chat-workspace">
        {props.childRunStatus === undefined ? null : (
          <header className="chat-workspace__header thread-column">{props.childRunStatus}</header>
        )}
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
  const canvasPanelId = `chat-canvas-panel-${thread.id}`;
  const pendingExtensionSelections = props.pendingExtensionSelections ?? extensionDraft.receipts;
  const removeExtensionSelection = props.onRemoveExtensionSelection ?? extensionDraft.remove;
  const pendingToolApproval = toolApprovals[0];

  async function decideToolApproval(decision: "approved" | "denied") {
    if (
      pendingToolApproval === undefined ||
      props.extensionClient === undefined ||
      toolApprovalBusy
    ) {
      return;
    }
    setToolApprovalBusy(true);
    try {
      await props.extensionClient.decideToolApproval({
        approvalId: pendingToolApproval.approvalId,
        decision,
      });
      setToolApprovals((current) =>
        current.filter((approval) => approval.approvalId !== pendingToolApproval.approvalId),
      );
    } finally {
      setToolApprovalBusy(false);
    }
  }

  const providerState = providerPresentation(props.providerSnapshot, view);
  const activeAttempt = latestActiveAttempt(view);
  const isSending = activeAttempt !== undefined;
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
  }) {
    void enqueueThreadCommand(async (previous) => {
      const result = await props.controller.execute({
        kind: "change-chat-provider",
        threadId: thread.id,
        expectedVersion: queuedVersion(previous),
        providerInstanceId: selection.providerInstanceId,
        modelId: selection.modelId,
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

  function detachDeferredAttachments(message: ChatSteeredMessage): void {
    const capturedIds = new Set(message.attachments.map((attachment) => String(attachment.id)));
    pendingAttachmentsRef.current = pendingAttachmentsRef.current.filter(
      (attachment) => !capturedIds.has(String(attachment.id)),
    );
    deferredAttachmentsRef.current = message.attachments;
  }

  function restoreDeferredAttachments(): void {
    const owned = deferredAttachmentsRef.current;
    if (owned.length === 0) return;
    deferredAttachmentsRef.current = [];
    const ownedIds = new Set(owned.map((attachment) => String(attachment.id)));
    pendingAttachmentsRef.current = [
      ...owned,
      ...pendingAttachmentsRef.current.filter((attachment) => !ownedIds.has(String(attachment.id))),
    ];
    // The visible list still contains these entries while a deferred send
    // waits, so restoring ownership only needs to repair the cleanup ledger.
  }

  function abandonDeferredContext(message: ChatSteeredMessage): void {
    const owned = deferredAttachmentsRef.current;
    if (owned.length === 0) return;
    deferredAttachmentsRef.current = [];
    const ownedIds = new Set(owned.map((attachment) => String(attachment.id)));
    if (mountedRef.current && activeThreadIdRef.current === message.threadId) {
      setPendingAttachments((current) =>
        current.filter((attachment) => !ownedIds.has(String(attachment.id))),
      );
      pendingAttachmentsRef.current = pendingAttachmentsRef.current.filter(
        (attachment) => !ownedIds.has(String(attachment.id)),
      );
    }
    for (const attachment of owned) {
      void discardAttachmentRef
        .current({ threadId: message.threadId, attachmentId: attachment.id })
        .catch(() => undefined);
    }
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

  const submitTurn = async (
    draft: string,
    steeredMessage?: ChatSteeredMessage,
  ): Promise<boolean> => {
    const deferred = steeredMessage !== undefined;
    const claimedAttachments = deferred ? [] : pendingAttachmentsRef.current;
    if (!deferred) pendingAttachmentsRef.current = [];
    const quotesForSend = deferred ? steeredMessage.quotes : pendingQuotesRef.current;
    const previewSelectionsForSend = deferred
      ? steeredMessage.previewSelections
      : pendingPreviewSelections;
    const canvasSelectionsForSend = deferred
      ? steeredMessage.canvasSelections
      : pendingCanvasSelections;
    const extensionReceiptsForSend = deferred
      ? steeredMessage.extensionReceipts
      : pendingExtensionRef.current;
    const threadMentionChipsForSend = deferred
      ? steeredMessage.threadMentionChips
      : [...threadMentions.chips];
    // A `#thread` chip names a thread; it never carries one. The turn
    // sends chip ids and the host resolves each one as the turn runs,
    // re-checking that the sender may still open it, so the message
    // stays exactly what the user typed and no later turn replays a
    // thread they pointed at once. This check is the composer's own
    // report: a chip the host refuses is shown as unavailable rather
    // than silently dropped.
    const sendingThreadId = String(view.thread.id);
    const threadMentionIds = deferred
      ? steeredMessage.threadMentionIds
      : await threadMentions.resolveForSend();
    if (activeThreadIdRef.current !== sendingThreadId) return false;
    const outgoing = formatOutgoingMessageWithQuotes({ draft, quotes: quotesForSend });
    const attachmentIds = deferred
      ? steeredMessage.attachmentIds
      : claimedAttachments.map((attachment) => attachment.id);
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
      if (!deferred) {
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
      if (deferred) deferredAttachmentsRef.current = [];
      consumeContext(context);
    } else if (!deferred) {
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
  submitTurnRef.current = (message) => submitTurn(message.prompt, message);

  return (
    <section aria-label="Chat workspace" className="chat-workspace">
      {props.controller.errorMessage === undefined ? null : (
        <p className="chat-workspace__error" role="alert">
          {props.controller.errorMessage}
        </p>
      )}
      <div className="chat-workspace__conversation">
        <header className="chat-workspace__header">
          <h1 className="sr-only">{view.thread.title}</h1>
          {props.childRunStatus}
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
              client={props.canvasClient}
              mode="chat"
              {...(props.onOpenCanvas === undefined ? {} : { onOpen: props.onOpenCanvas })}
              {...(props.onCanvasReferencesObserved === undefined
                ? {}
                : {
                    onCardsObserved: (cards: ReadonlyArray<CanvasThreadReferenceCard>) =>
                      props.onCanvasReferencesObserved?.(String(thread.id), cards),
                  })}
              projectId={thread.projectId ?? null}
              // A settled turn may have authored a Canvas; re-read the cards so
              // the document appears without reopening the thread.
              refreshKey={canvasRefreshKey + settledTurnCount}
              threadId={thread.id}
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
          busy={isSending || branchPending}
          {...(steered.pending === undefined ? {} : { pendingUserMessage: steered.pending.prompt })}
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
          connectionStatus={
            props.controller.status === "disconnected" ? "disconnected" : "connected"
          }
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
      {pendingToolApproval === undefined ? null : (
        <section
          aria-label="Extension tool approval"
          className="chat-workspace__tool-approval"
          role="group"
        >
          <div>
            <strong>Allow {pendingToolApproval.mcpToolName}?</strong>
            <span>One-time extension tool request</span>
          </div>
          <code>
            {pendingToolApproval.inputJson === "" ? "(empty input)" : pendingToolApproval.inputJson}
          </code>
          <div>
            <OctantButton
              disabled={toolApprovalBusy}
              onClick={() => void decideToolApproval("approved")}
              size="sm"
              type="button"
            >
              Approve once
            </OctantButton>
            <OctantButton
              disabled={toolApprovalBusy}
              onClick={() => void decideToolApproval("denied")}
              size="sm"
              type="button"
              variant="secondary"
            >
              Deny
            </OctantButton>
          </div>
        </section>
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
        hasPendingMessage={steered.pending !== undefined}
        model={{ options: providerState.modelOptions, value: view.thread.modelId }}
        onDraftChange={(draft, caretIndex) => {
          draftEditRevisionRef.current += 1;
          props.controller.setPendingDraft(draft, caretIndex);
        }}
        imageAttachment={imageAttachmentCapability}
        onImagePasteRejected={(reason) => setAttachmentStatus({ kind: "failed", message: reason })}
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
              providerGroups: props.providerGroups,
              selectedProviderInstanceId: view.thread.providerInstanceId,
              selectedModelId: view.thread.modelId,
              onSelectModel: (selection: {
                readonly providerInstanceId: (typeof view.thread)["providerInstanceId"];
                readonly modelId: (typeof view.thread)["modelId"];
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
          if (steered.pending !== undefined) return false;
          // Sending during a streaming response is still sending: the message
          // leaves the composer now and joins the transcript, and the host runs
          // it as soon as this thread stops running one.
          if (isSending) {
            const draftRevision = draftEditRevisionRef.current;
            const snapshot = {
              id: globalThis.crypto.randomUUID(),
              threadId: view.thread.id,
              prompt: draft,
              draftEditRevision: draftRevision,
              attachments: [...pendingAttachmentsRef.current],
              attachmentIds: pendingAttachmentsRef.current.map((attachment) => attachment.id),
              previewSelections: [...pendingPreviewRef.current],
              canvasSelections: [...pendingCanvasRef.current],
              quotes: [...pendingQuotesRef.current],
              extensionReceipts: [...pendingExtensionRef.current],
              threadMentionChips: [...threadMentions.chips],
            };
            // Resolve before steering so this message carries the host's
            // availability receipt. The returned ids stay with this snapshot;
            // a later edit must not replace them.
            const threadMentionIds = await threadMentions.resolveForSend();
            if (!mountedRef.current) return false;
            const steeredMessage: ChatSteeredMessage = {
              ...snapshot,
              threadMentionIds,
            };
            if (!steered.steer(steeredMessage)) return false;
            detachDeferredAttachments(steeredMessage);
            // The textarea remains editable while mention resolution is in
            // flight. Never clear text typed after this send began.
            if (draftEditRevisionRef.current === draftRevision) {
              props.controller.setPendingDraft("");
            }
            return true;
          }
          return await submitTurn(draft);
        }}
        pendingCanvasSelections={pendingCanvasSelections}
        pendingAttachments={pendingAttachments}
        pendingPreviewSelections={pendingPreviewSelections}
        pendingQuotes={pendingQuotes}
        pendingExtensionSelections={pendingExtensionSelections}
        {...(steered.pending === undefined
          ? {}
          : { sendDisabledReason: "A message is already waiting to run." })}
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
          options: providerState.providerOptions,
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
              : attachmentStatus.kind === "failed"
                ? {
                    statusMessage: composeComposerNotice(
                      attachmentStatus.message,
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
    const attempts = view.turns[turnIndex]!.attempts;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      const attempt = attempts[attemptIndex]!;
      if (attempt.outcome === "queued" || attempt.outcome === "streaming") return attempt;
    }
  }
  return undefined;
}

function latestAttempt(view: ChatThreadView): ChatAttempt | undefined {
  for (let turnIndex = view.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const attempts = view.turns[turnIndex]!.attempts;
    const attempt = attempts[attempts.length - 1];
    if (attempt !== undefined) return attempt;
  }
  return undefined;
}

function chatTurnSettlement(view: ChatThreadView | undefined): TurnSettlement | "idle" {
  if (view === undefined) return "idle";
  const active = latestActiveAttempt(view);
  if (active !== undefined) return "running";
  const latest = latestAttempt(view);
  if (latest === undefined) return "idle";
  switch (latest.outcome) {
    case "queued":
    case "streaming":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "failed":
      return "failed";
  }
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
