import {
  MAX_CODE_THREAD_TITLE_LENGTH,
  type CodeApprovalId,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts/code";
import type { CodeCheckpoint, CodeThreadChangedFileState } from "@octant/contracts/code-operations";
import type {
  CodeAttachmentReference,
  MentionableThreadId,
  ProviderExecutionPolicy,
} from "@octant/contracts";
import {
  clampTurnAccessPosture,
  decidesCodeEffectsByApproval,
  type PickerGroup,
} from "@octant/domain";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { CirclePause, UserRoundCog } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ComposerVoiceButton } from "../voice/ComposerVoiceButton";
import { appendTranscript } from "../voice/appendTranscript";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView } from "@octant/contracts";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import { GeneratedImageList } from "../image/GeneratedImageList";
import { useSteeredSend } from "../composer/useSteeredSend";
import type { TurnSettlement } from "../composer/steeredSend";
import {
  applyComposerCaret,
  COMPOSER_STAGED_DROPPED_NOTE,
} from "../composer/composerThreadDraftStore";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSeparatorWithLabel } from "../ui/base/OctantSeparator";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import type { CodeConversationMessage, CodeController, CodeTurnStatus } from "./useCodeController";
import { ChatRichText } from "../chat/ChatRichText";
import { CodeCheckoutBar } from "./CodeCheckoutBar";
import { TrackerReferenceComposerHints } from "../tracker/TrackerReferenceComposerHints";
import { TrackerReferenceText } from "../tracker/TrackerReferenceText";
import { InlineThreadPlan } from "../plan/InlineThreadPlan";
import { useThreadPlan } from "../plan/ThreadPlanContext";
import type { ThreadTaskChangedFiles } from "../plan/ThreadTaskViewer";
import { ThreadChildRunStatusSlot } from "../agents/ThreadChildRunStatusSlot";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { HostId } from "@octant/contracts/host";
import type { CodeClient, ThreadMentionClient } from "@octant/client-runtime";
import { useCodeAttachments, type StagedCodeAttachment } from "./useCodeAttachments";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
  type ThreadMentionChip,
} from "../chat/ThreadMentionPicker";
import { useThreadMentions } from "../chat/useThreadMentions";
import { CodeAttachmentGallery } from "./CodeAttachmentGallery";
import { CodeTranscriptRow } from "./CodeTranscriptRow";
import { providerModelLabel } from "../providers/providerModelLabel";
import { providerLimitWindowLabel } from "../providers/providerLimitWindow";
import {
  TurnHeader,
  turnTimeLabel,
  turnTimeTitle,
  type TurnHeaderOutcome,
} from "../transcript/TurnHeader";
import { TranscriptWindow } from "../transcript/TranscriptWindow";
import { copyText, TurnActionMenu, type TurnAction } from "../transcript/TurnActionMenu";
import { ThreadCheckpointControls } from "../checkpoints/ThreadCheckpointControls";
import { useThreadCheckpoints } from "../checkpoints/useThreadCheckpoints";
import { ScaffoldPicker } from "../scaffolds/ScaffoldPicker";
import { useScaffoldCatalog } from "../scaffolds/useScaffoldCatalog";
import { WorkspacePresetPicker } from "../workspacePresets/WorkspacePresetPicker";
import { useWorkspacePresets } from "../workspacePresets/useWorkspacePresets";
import { PathMentionTypeahead, useCodePathMentions } from "./CodePathMentionPicker";
import { CODE_ACCESS_POSTURE_LABEL, CodeAccessPicker } from "./CodeAccessPicker";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { useAgentProfileName } from "../agentProfile/AgentProfileNames";

export type CodeAttachmentClient = Pick<
  CodeClient,
  "putAttachment" | "discardAttachment" | "attachment"
>;

/**
 * Stands in when the host serves no attachment route. Its methods are never
 * called: the composer only offers attaching when a real client is present.
 */
const UNAVAILABLE_ATTACHMENT_CLIENT: CodeAttachmentClient = {
  putAttachment: () => Promise.reject(new Error("Code attachments are unavailable.")),
  discardAttachment: () => Promise.reject(new Error("Code attachments are unavailable.")),
  attachment: () => Promise.reject(new Error("Code attachments are unavailable.")),
};

/**
 * A message the user sent while a turn was still running.
 *
 * Everything the send would have carried is captured when the user presses
 * Enter, so the message that reaches the host is the one they wrote — not
 * whatever the composer happens to hold when the running turn finally stops.
 */
interface CodeSteeredMessage {
  readonly id: string;
  readonly threadKey: string;
  readonly restore: (message: CodeSteeredMessage) => void;
  readonly prompt: string;
  readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
  readonly threadMentionChips: ReadonlyArray<ThreadMentionChip>;
  readonly attachments: ReadonlyArray<CodeAttachmentReference>;
  readonly detachedAttachments: ReadonlyArray<StagedCodeAttachment>;
  readonly fileMentionPaths: ReadonlyArray<string>;
  readonly access: ProviderExecutionPolicy;
  /** The one-shot posture the composer had selected, to put back on refusal. */
  readonly accessOverride: ProviderExecutionPolicy | undefined;
  /** Revision before this message cleared the composer. */
  readonly draftRevision: number;
}

export interface CodeThreadWorkspaceProps {
  readonly agentRunClient?: AgentRunClient;
  readonly onAddAgent?: () => void;
  readonly controller: CodeController;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly threadId: CodeThreadId;
  readonly canvasClient?: CanvasClient;
  readonly imageGenerationClient?: ImageGenerationClient;
  readonly imageGenerationProfiles?: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenSettings?: () => void;
  /** Opens the pull-request surface from the checkout bar. Absent hides the control. */
  readonly onCreatePullRequest?: () => void;
  readonly hostId?: HostId;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  /**
   * Reach for the host's `#thread` mention surface. Absent on a host that does
   * not serve it, which keeps the picker closed rather than offering threads
   * nothing can resolve.
   */
  readonly threadMentionClient?: ThreadMentionClient;
  /** Lists this checkout's files for `@path` mentions. */
  readonly fileListingClient?: CodeFileListingClient;
  /**
   * Stages pasted or dropped images with the host. Absent on a host that
   * serves no attachment route, which keeps the composer from offering an
   * attachment it could never send.
   */
  readonly attachmentClient?: CodeAttachmentClient;
  /**
   * Raises the host's native Full access confirmation. Absent on a host that
   * cannot raise one, which keeps Full access out of reach rather than letting
   * the composer ask for a change the host would refuse.
   */
  readonly requestFullAccessApproval?: (effect: {
    readonly kind: "change-thread-full-access";
    readonly threadId: CodeThreadId;
    readonly expectedVersion: number;
    readonly permissionPersistence: "current-session" | "project-default";
  }) => Promise<CodeApprovalId | undefined>;
  /**
   * Runs the checkpoint restore. Absent on a host that serves no operation
   * route, which keeps the control off the transcript rather than offering an
   * undo nothing could carry out.
   */
  readonly operationClient?: Pick<CodeClient, "executeOperation">;
  /** Mints the operation identities a restore needs. */
  readonly nextUuid?: () => string;
  /**
   * Raises the approval a destructive Code operation needs under an
   * approval-deciding posture. Absent when the host cannot raise one, which
   * keeps the restore control hidden on those threads.
   */
  readonly requestApproval?: (
    command: Parameters<CodeClient["executeOperation"]>[0],
  ) => Promise<CodeApprovalId | undefined>;
  /**
   * Opens a thread this workspace started. Absent on a host with no tab
   * surface, which keeps the fork control off the transcript rather than
   * creating a thread the user would then have to go looking for.
   */
  readonly onOpenCodeThread?: (
    threadId: CodeThreadId,
    title: string,
    projectId: CodeThread["projectId"],
  ) => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

/**
 * Conversation-first Code thread center (design §6.3).
 * Overview/Git/Terminal remain secondary surfaces opened from the thread toolbar.
 */
export function CodeThreadWorkspace(props: CodeThreadWorkspaceProps) {
  const view =
    props.controller.activeView?.thread.id === props.threadId
      ? props.controller.activeView
      : undefined;
  const profileName = useAgentProfileName(view?.thread.profileId);
  const displayReady = props.controller.conversationHistory === "loaded";
  const emptyConversation =
    props.controller.conversationHistory === "loaded" && props.controller.conversation.length === 0;
  const plan = useThreadPlan()?.plan;
  // The board observation is the host's changed-file evidence. Ask only when
  // the plan surface will render it: a thread with no plan has nowhere to put
  // the count, and querying every open conversation would rescan every worktree.
  const changedFiles = useObservedChangedFiles({
    client: props.controller.client,
    enabled: displayReady && view !== undefined && plan != null && plan.status !== "withdrawn",
    projectId: view?.thread.projectId,
    threadId: props.threadId,
  });
  const [draft, setDraft] = useState(props.controller.pendingDraft);
  // User edits are counted separately from the internal clear performed when
  // a steered message leaves the composer, so an async mention lookup cannot
  // erase a newer draft typed while that lookup is pending.
  const draftRevisionRef = useRef(0);
  const activeThreadKeyRef = useRef(String(props.threadId));
  activeThreadKeyRef.current = String(props.threadId);
  const [providerChanging, setProviderChanging] = useState(false);
  const [accessChanging, setAccessChanging] = useState(false);
  const [accessMessage, setAccessMessage] = useState<string>();
  const [turnAccessOverride, setTurnAccessOverride] = useState<ProviderExecutionPolicy>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [confirmingRestore, setConfirmingRestore] = useState<string>();
  const [checkpointDraft, setCheckpointDraft] = useState<
    { readonly messageId: string; readonly kind: "mark" | "restore" } | undefined
  >();
  const checkpoints = useThreadCheckpoints({
    enabled: displayReady && props.controller.conversation.length > 0,
    threadId: String(props.threadId),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const scaffolds = useScaffoldCatalog({
    enabled: emptyConversation,
    threadId: String(props.threadId),
    checkoutId: String(view?.checkout.id ?? ""),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  // The preset needs the checkout the thread is bound to. A thread without one
  // yet has nothing to arrange around, so the picker offers nothing.
  const presets = useWorkspacePresets({
    enabled: emptyConversation,
    threadId: props.threadId,
    ...(view === undefined ? {} : { checkoutId: view.checkout.id }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string>();
  // The way back from the last restore is the controller's, not this
  // component's: switching tabs unmounts this surface, and a handle held here
  // would take the only reachable copy of the overwritten state with it.
  const restoreUndo = props.controller.restoreUndo;
  const setRestoreUndo = props.controller.noteRestoreUndo;
  const [forking, setForking] = useState(false);
  const [forkMessage, setForkMessage] = useState<string>();

  useEffect(() => {
    setDraft(props.controller.pendingDraft);
  }, [props.controller.pendingDraft, props.threadId]);
  const sendSteeredRef = useRef<(message: CodeSteeredMessage) => Promise<boolean>>(
    async () => false,
  );
  const restoreSteeredRef = useRef<(message: CodeSteeredMessage) => void>(() => {});
  // Pasting or dropping a picture uploads it now and keeps only its id. The
  // turn names ids, so the host sends the provider bytes it accepted itself.
  const attachments = useCodeAttachments({
    client: props.attachmentClient ?? UNAVAILABLE_ATTACHMENT_CLIENT,
    threadId: props.attachmentClient === undefined ? undefined : props.threadId,
  });
  const steered = useSteeredSend<CodeSteeredMessage>({
    threadKey: String(props.threadId),
    settlement: codeTurnSettlement(props.controller.turnStatus),
    ready: !attachments.busy,
    send: (message) => sendSteeredRef.current(message),
    restore: (message) => message.restore(message),
  });

  const composerReady = view !== undefined && props.controller.status !== "disconnected";
  useLayoutEffect(() => {
    if (!composerReady) return;
    applyComposerCaret(
      textareaRef.current,
      props.controller.pendingDraftCaret ?? draft.length,
      draft.length,
    );
  }, [composerReady, props.threadId]);
  useEffect(() => {
    setTurnAccessOverride(undefined);
  }, [props.threadId, view?.thread.executionPolicy]);

  // §8.1: `#` must open the same cross-mode picker here as in Chat. The host
  // owns which threads are mentionable and how much of each transcript rides
  // along; this composer only names them.
  const threadMentions = useThreadMentions({
    ...(props.threadMentionClient === undefined ? {} : { client: props.threadMentionClient }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft,
  });
  const mention = useThreadMentionTypeahead({
    mentions: threadMentions.composer,
    draft,
    onDraftChange: (next, caretIndex) => {
      draftRevisionRef.current += 1;
      setDraft(next);
      props.controller.setPendingDraft?.(next, caretIndex);
    },
    textarea: () => textareaRef.current,
  });
  const mentionListId = `code-thread-mentions-${String(props.threadId)}`;

  // `@` names a file or folder in the checkout this thread is already bound to.
  // The path travels as ordinary prompt text; the host still decides what the
  // turn may read, so naming a file here reaches nothing on its own.
  const pathMentions = useCodePathMentions({
    ...(props.fileListingClient === undefined ? {} : { client: props.fileListingClient }),
    threadId: props.threadId,
    checkoutId: view?.checkout.id,
    draft,
    onDraftChange: (next, caretIndex) => {
      draftRevisionRef.current += 1;
      setDraft(next);
      props.controller.setPendingDraft?.(next, caretIndex);
    },
    textarea: () => textareaRef.current,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const pathMentionListId = `code-path-mentions-${String(props.threadId)}`;
  const pathMentionOpen = pathMentions.open && !mention.open;
  const peekAbandoned = attachments.peekAbandoned;
  const markDraftStagedDropped = props.controller.markDraftStagedDropped;
  useEffect(() => {
    const abandonedThreadId = String(props.threadId);
    return () => {
      if (peekAbandoned()) {
        markDraftStagedDropped?.(abandonedThreadId);
      }
    };
  }, [markDraftStagedDropped, peekAbandoned, props.threadId]);

  function syncMentions(value: string, caret: number | null) {
    mention.sync(value, caret);
    pathMentions.sync(value, caret);
  }

  const childRunStatus =
    props.agentRunClient === undefined ? undefined : (
      <ThreadChildRunStatusSlot
        client={props.agentRunClient}
        enabled={displayReady}
        {...(props.onAddAgent === undefined ? {} : { onAddAgent: props.onAddAgent })}
        threadId={String(props.threadId)}
      />
    );

  if (props.controller.status === "disconnected") {
    return (
      <section aria-label="Code thread" className="code-thread-workspace">
        {childRunStatus === undefined ? null : (
          <header className="code-thread-workspace__header">
            <div className="code-thread-workspace__header-row thread-column">{childRunStatus}</div>
          </header>
        )}
        <ShellState
          action={{ label: "Retry Code", onClick: props.controller.retry }}
          eyebrow="Code workspace"
          message={props.controller.errorMessage ?? "The local Code service is unavailable."}
          role="alert"
          state="disconnected"
          title="Code is disconnected"
        />
      </section>
    );
  }

  if (view === undefined) {
    const unavailable = props.controller.errorCategory;
    return (
      <section aria-label="Code thread" className="code-thread-workspace">
        {childRunStatus === undefined ? null : (
          <header className="code-thread-workspace__header">
            <div className="code-thread-workspace__header-row thread-column">{childRunStatus}</div>
          </header>
        )}
        <ShellState
          {...(unavailable === undefined
            ? {}
            : { action: { label: "Retry Code", onClick: props.controller.retry } })}
          eyebrow="Code workspace"
          message={
            props.controller.errorMessage ??
            (props.controller.status === "conflict-reload"
              ? "Loading current authoritative Code state."
              : "Loading the selected Code thread.")
          }
          {...(unavailable === undefined ? {} : { role: "alert" as const })}
          state={unavailable === undefined ? "loading" : "warning"}
          title={unavailable === undefined ? "Loading Code thread" : "Code thread unavailable"}
        />
      </section>
    );
  }

  const { checkout, thread } = view;
  const nextTurnAccess = clampTurnAccessPosture({
    thread: thread.executionPolicy,
    ...(turnAccessOverride === undefined ? {} : { requested: turnAccessOverride }),
  });
  const trimmed = draft.trim();
  const busy =
    props.controller.turnStatus === "sending" || props.controller.turnStatus === "running";
  // A running turn never blocks the composer: the host admits one turn per
  // thread, so a message sent during one is held by the surface and sent the
  // moment that turn stops, without the user having to manage it.
  const canSend = trimmed.length > 0 && !attachments.busy && steered.pending === undefined;
  const providerGroups = props.providerGroups ?? [];
  const messages = props.controller.conversation;
  // A message sent while a turn was running is already the user's message. It
  // belongs at the end of the transcript, where every other sent message is,
  // rather than parked in the composer waiting to be administered. It sits
  // outside the virtualized list because it is the surface's own intent, not
  // part of the host's authoritative conversation.
  const pendingMessage =
    steered.pending === undefined ? null : (
      <article className="code-thread-workspace__message code-thread-workspace__message--user">
        <TrackerReferenceText asParagraph text={steered.pending.prompt} />
        {steered.pending.access === previousUserPolicy(messages, messages.length) ? null : (
          <p className="code-thread-workspace__turn-access">
            Access · {CODE_ACCESS_POSTURE_LABEL[steered.pending.access]}
          </p>
        )}
      </article>
    );
  // An unreachable history is not an empty thread. Treating it as one puts the
  // new-thread copy and the project scaffolds under a banner that says this
  // thread's own turns are missing, and offers to scaffold into a checkout that
  // may already hold work.
  const showEmptyConversation =
    messages.length === 0 && props.controller.conversationHistory === "loaded";
  // Restoring rewrites files on disk, so the control appears only where this
  // thread may change the checkout and the renderer can raise whatever
  // approval the posture demands.
  const mayRestore =
    thread.executionPolicy !== "plan" &&
    props.operationClient !== undefined &&
    props.nextUuid !== undefined &&
    (!decidesCodeEffectsByApproval(thread.executionPolicy) || props.requestApproval !== undefined);
  async function submitFollowUp() {
    if (!canSend || steered.pending !== undefined) return;
    const draftRevision = draftRevisionRef.current;
    const originThreadKey = String(props.threadId);
    // The one-shot override is consumed when the message is sent, not when the
    // turn later finishes: a long running turn must not leave Plan selected for
    // whatever the user writes next. A refused send puts it back.
    const override = turnAccessOverride;
    const access = nextTurnAccess;
    setTurnAccessOverride(undefined);
    if (busy) {
      const threadMentionChips = threadMentions.chips;
      const fileMentionPaths = pathMentions.selectedPaths;
      const detachedAttachments = attachments.detachForSend();
      const prompt = trimmed;
      // Clear immediately so typing during a slow mention lookup edits the
      // next draft instead of appending to the message being prepared.
      if (draftRevisionRef.current === draftRevision) {
        setDraft("");
        props.controller.setPendingDraft?.("");
      }
      // Resolve the captured chips rather than whatever a later draft names;
      // the host still rechecks authority when the message runs.
      const threadMentionIds = await threadMentions.resolveForSend();
      if (activeThreadKeyRef.current !== originThreadKey) {
        // The user left while the host checked the mention ids. Keep the
        // abandoned prompt with its originating thread and dispose of its
        // detached host attachments; never steer them into the new thread.
        props.controller.writePendingDraftFor?.(originThreadKey, prompt);
        attachments.discardDetached(detachedAttachments);
        return;
      }
      // Sending while a turn runs is still sending. The message leaves the
      // composer now and joins the transcript, and the host is asked to run it
      // as soon as this thread stops running one — the user never administers
      // a parked message. The first message's context is detached atomically;
      // a refusal restores it, while later edits stay with the composer.
      const steeredMessage: CodeSteeredMessage = {
        id: globalThis.crypto.randomUUID(),
        threadKey: String(props.threadId),
        restore: restoreSteeredRef.current,
        prompt,
        threadMentionIds,
        threadMentionChips,
        attachments: detachedAttachments.map((entry) => entry.reference),
        detachedAttachments,
        fileMentionPaths,
        access,
        accessOverride: override,
        draftRevision,
      };
      if (!steered.steer(steeredMessage)) {
        if (draftRevisionRef.current === draftRevision) {
          attachments.restoreDetached(detachedAttachments);
          setDraft(prompt);
          props.controller.setPendingDraft?.(prompt);
          threadMentions.restore(threadMentionChips);
          pathMentions.restore(fileMentionPaths);
          setTurnAccessOverride((current) => current ?? override);
        } else {
          // A newer draft won the race to steer this message. Its detached
          // host attachments and access override must not bleed into that draft.
          attachments.discardDetached(detachedAttachments);
        }
        return;
      }
      return;
    }
    // The chips stay until the host accepts the turn: a refused or dropped send
    // must leave the message retryable with the same images, not just its text.
    const threadMentionIds = await threadMentions.resolveForSend();
    const fileMentionPaths = pathMentions.selectedPaths;
    const sent = await props.controller.sendFollowUp(
      trimmed,
      threadMentionIds,
      attachments.peekForSend(),
      fileMentionPaths,
      access,
    );
    if (sent) {
      attachments.takeForSend();
      // Only the draft that was sent is cleared: typing during the awaited send
      // bumps the revision, and that newer draft stays. The host keeps the
      // draft per thread and hands it back whenever the composer re-syncs, so
      // the sent message came back into the box until the stored copy was
      // cleared as well.
      if (draftRevisionRef.current === draftRevision) {
        setDraft("");
        props.controller.setPendingDraft?.("");
        threadMentions.clear();
        pathMentions.clear();
      }
    } else {
      setTurnAccessOverride((current) => current ?? override);
    }
  }
  sendSteeredRef.current = async (message) => {
    try {
      attachments.markDetachedInFlight(message.detachedAttachments);
      const sent = await props.controller.sendFollowUp(
        message.prompt,
        message.threadMentionIds,
        message.attachments,
        message.fileMentionPaths,
        message.access,
        true,
      );
      if (sent) {
        // The detached images belong to this message only. Keep any images
        // attached after the steer for the editable draft that follows.
        attachments.commitDetached(message.detachedAttachments);
        if (draftRevisionRef.current === message.draftRevision) {
          threadMentions.clear();
          pathMentions.clear();
        }
      }
      return sent;
    } catch {
      return false;
    }
  };
  restoreSteeredRef.current = (message) => {
    if (!mountedRef.current || activeThreadKeyRef.current !== message.threadKey) {
      props.controller.writePendingDraftFor?.(message.threadKey, message.prompt);
      attachments.discardDetached(message.detachedAttachments);
      return;
    }
    setTurnAccessOverride((current) => current ?? message.accessOverride);
    if (draftRevisionRef.current !== message.draftRevision) {
      attachments.discardDetached(message.detachedAttachments);
      return;
    }
    // Restore every captured context alongside the words so a refused message
    // can be retried exactly as it was sent.
    attachments.restoreDetached(message.detachedAttachments);
    setDraft(message.prompt);
    props.controller.setPendingDraft?.(message.prompt);
    threadMentions.restore(message.threadMentionChips);
    pathMentions.restore(message.fileMentionPaths);
  };

  function attachFromTransfer(items: DataTransfer | null): boolean {
    if (props.attachmentClient === undefined || items === null) return false;
    const files = [...items.files];
    if (files.length === 0) return false;
    // The host refuses this turn anyway. Saying so at the paste is kinder than
    // letting the user write the message first and lose it at send.
    if (boundModelReadsImages(providerGroups, thread) === false) {
      attachments.refuse(
        `${providerModelLabel(providerGroups, thread)} does not support images. Choose a vision model to attach one.`,
      );
      return true;
    }
    void attachments.attach(files);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.handleKeyDown(event)) return;
    if (pathMentions.handleKeyDown(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitFollowUp();
  }

  /**
   * Put the checkout's files back the way they were just before this message
   * was sent.
   *
   * The host records what it replaced, so this is reversible; it still asks
   * first, because the files on disk are what the user has been reading.
   */
  async function restoreCheckpoint(message: CodeConversationMessage) {
    setConfirmingRestore(undefined);
    await runRestore(message.checkpoint, "Files restored to this point.");
  }

  /**
   * Put the files back the way they were just before the last restore.
   *
   * The host returns what a restore replaced precisely so the overwrite is not
   * final. Undoing is itself a restore, so it runs the same authoritative
   * command and leaves its own undo point behind.
   */
  async function undoRestore() {
    await runRestore(restoreUndo, "The restore was undone.");
  }

  async function runRestore(
    checkpoint: CodeCheckpoint | undefined,
    completedMessage: string,
  ): Promise<void> {
    const client = props.operationClient;
    const nextUuid = props.nextUuid;
    if (checkpoint === undefined || client === undefined || nextUuid === undefined) return;
    if (view === undefined) return;
    setRestoreMessage(undefined);
    setRestoreUndo(undefined);
    setRestoring(true);
    try {
      const command = {
        kind: "restore-git-checkpoint",
        operationId: nextUuid() as never,
        gitOperationId: nextUuid() as never,
        threadId: view.thread.id,
        checkoutId: view.checkout.id,
        checkpoint,
      } as const;
      if (
        decidesCodeEffectsByApproval(thread.executionPolicy) &&
        (await props.requestApproval?.(command)) === undefined
      ) {
        setRestoreMessage("The files were not restored. Nothing changed.");
        return;
      }
      const result = await client.executeOperation(command);
      if (result.kind === "operation-failed") setRestoreMessage(result.failure.message);
      else if (result.kind === "git-mutation-state" && result.state === "completed") {
        setRestoreMessage(completedMessage);
        // Keeping what the host replaced is what makes the overwrite reversible;
        // dropping it here would strand the only copy of the previous state.
        if (result.undo !== undefined) setRestoreUndo(result.undo);
      } else if (result.kind === "git-mutation-state" && result.undo !== undefined) {
        // A failed restore reports the state it replaced, which means it may
        // have moved files before it stopped. Saying "untouched" here would be
        // a guess, and it would bury the only way back.
        setRestoreMessage(`The restore ${result.state}. Some files may already have changed.`);
        setRestoreUndo(result.undo);
      } else if (result.kind === "git-mutation-state")
        setRestoreMessage(`The restore was ${result.state}. The checkout is untouched.`);
      else setRestoreMessage("The restore did not report a result.");
    } catch {
      // The request did not come back. The host may have applied the restore
      // anyway, so claiming the checkout is untouched would be a guess about
      // the user's files.
      setRestoreMessage("The restore did not report back. Refresh before assuming it did nothing.");
    } finally {
      setRestoring(false);
    }
  }

  /**
   * Start a second thread that continues this conversation from this answer.
   *
   * Nothing here changes: the fork is a new thread on the same checkout, and
   * the original keeps every turn it already has. The host decides what
   * history the fork's first turn carries, so this only names the point.
   */
  async function forkFrom(message: CodeConversationMessage) {
    const operationId = message.operationId;
    if (operationId === undefined || view === undefined) return;
    setForkMessage(undefined);
    setForking(true);
    try {
      const forked = await props.controller.forkThread({
        threadId: view.thread.id,
        throughOperationId: String(operationId),
        title: forkTitle(view.thread.title),
      });
      if (forked === undefined) {
        setForkMessage("The thread could not be forked. This thread is unchanged.");
        return;
      }
      props.onOpenCodeThread?.(forked.id, forked.title, forked.projectId);
    } catch {
      setForkMessage("The thread could not be forked. This thread is unchanged.");
    } finally {
      setForking(false);
    }
  }

  async function changeAccess(next: ProviderExecutionPolicy) {
    if (next === thread.executionPolicy) return;
    setAccessMessage(undefined);
    let approvalId: CodeApprovalId | undefined;
    if (next === "full-access") {
      approvalId = await props.requestFullAccessApproval?.({
        kind: "change-thread-full-access",
        threadId: thread.id,
        expectedVersion: thread.version,
        permissionPersistence: thread.permissionPersistence,
      });
      if (approvalId === undefined) {
        setAccessMessage("Full access was not confirmed. This thread keeps its current access.");
        return;
      }
    }
    setAccessChanging(true);
    try {
      await props.controller.execute({
        kind: "change-code-thread-access",
        threadId: thread.id,
        expectedVersion: thread.version,
        executionPolicy: next,
        permissionPersistence: thread.permissionPersistence,
        ...(approvalId === undefined ? {} : { approvalId }),
      });
    } finally {
      setAccessChanging(false);
    }
  }

  async function changeProvider(selection: {
    readonly providerInstanceId: typeof thread.providerInstanceId;
    readonly modelId: typeof thread.modelId;
  }) {
    if (
      selection.providerInstanceId === thread.providerInstanceId &&
      selection.modelId === thread.modelId
    ) {
      return;
    }
    setProviderChanging(true);
    try {
      await props.controller.execute({
        kind: "change-code-thread-provider",
        threadId: thread.id,
        expectedVersion: thread.version,
        providerInstanceId: selection.providerInstanceId,
        modelId: selection.modelId,
      });
    } finally {
      setProviderChanging(false);
    }
  }

  return (
    <section aria-label="Code thread" className="code-thread-workspace">
      {/* No identity header. The title repeated the pane's own grip, the
          lifecycle badge said "Active" on nearly every thread, the branch is
          the Environment summary's fact, and follow-up is the thread row's
          right-click menu — leaving a band that cost height and said nothing.
          Live child runs are the one thing here that has no other home. */}
      {childRunStatus === undefined ? null : (
        <header className="code-thread-workspace__header">
          <div className="code-thread-workspace__header-row thread-column">{childRunStatus}</div>
        </header>
      )}

      {props.controller.errorMessage === undefined ? null : (
        <div
          className="callout callout-warn thread-column code-thread-workspace__callout"
          role="alert"
        >
          <p>{props.controller.errorMessage}</p>
        </div>
      )}

      {props.controller.turnStatus === "waiting" ? (
        <div className="code-thread-workspace__waiting thread-column" role="status">
          <CirclePause aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>
            {props.controller.providerRequests.length === 0 &&
            props.controller.turnError !== undefined
              ? `Waiting · ${props.controller.turnError}`
              : waitingTurnLabel(props.controller.providerRequests)}
          </span>
        </div>
      ) : props.controller.turnError === undefined ||
        (props.controller.turnStatus === "failed" &&
          props.controller.turnErrorInTranscript &&
          props.controller.conversationHistory !== "unavailable") ? null : (
        // A failed turn is already in the transcript with its reason; a second
        // notice above it said the same thing louder. The callout stays for a
        // history the host cannot read, where the retry offer lives, and for a
        // send the host refused before any turn existed to carry the reason.
        <div
          className="callout callout-warn thread-column code-thread-workspace__callout"
          role="alert"
        >
          <p>{props.controller.turnError}</p>
          {/* An unreachable history is worth another ask, and the offer sits
              with the notice rather than leaving a dead end. The composer
              below stays usable either way. */}
          {props.controller.conversationHistory === "unavailable" ? (
            <OctantButton
              onClick={props.controller.retry}
              size="sm"
              type="button"
              variant="secondary"
            >
              Retry
            </OctantButton>
          ) : null}
        </div>
      )}

      {thread.lifecycle === "waiting" || thread.lifecycle === "interrupted" ? (
        <div
          className="callout callout-warn thread-column code-thread-workspace__callout"
          role="alert"
        >
          <p>
            {thread.lifecycle === "waiting"
              ? "This thread is waiting for authoritative recovery or user input."
              : "This thread was interrupted and requires an explicit retry."}
          </p>
        </div>
      ) : null}

      {props.controller.providerRequests.map((request) =>
        request.kind === "approval" ? (
          <ProviderApprovalPrompt
            key={String(request.approvalId)}
            onAnswer={(decision) =>
              void props.controller.answerProviderRequest({
                kind: "approval",
                approvalId: request.approvalId,
                decision,
              })
            }
            summary={request.summary}
          />
        ) : (
          <ProviderInputPrompt
            key={request.requestId}
            onAnswer={(response) =>
              void props.controller.answerProviderRequest({
                kind: "input",
                requestId: request.requestId,
                response,
              })
            }
            options={request.options}
            prompt={request.prompt}
          />
        ),
      )}

      {messages.length === 0 && pendingMessage === null ? (
        <div className="code-thread-workspace__conversation" role="log" aria-live="polite">
          <div className="code-thread-workspace__transcript thread-column">
            {props.controller.conversationHistory === "loading" ? (
              <ShellState
                message="Loading the existing thread transcript from this host."
                state="loading"
                title="Loading conversation"
              />
            ) : showEmptyConversation ? (
              <>
                <p className="code-thread-workspace__empty" role="status">
                  No messages yet. Send a prompt to start this thread.
                </p>
                {/* A thread on an empty checkout has nothing to talk about yet.
                    Offering the curated scaffolds here, and only here, keeps the
                    choice next to the moment it matters. */}
                {presets.available ? (
                  <WorkspacePresetPicker
                    busy={presets.busy}
                    {...(presets.message === undefined ? {} : { message: presets.message })}
                    onApply={(preset) => void presets.apply(preset)}
                    presets={presets.presets}
                    skills={presets.skills}
                  />
                ) : null}
                {scaffolds.available ? (
                  <ScaffoldPicker
                    busy={scaffolds.busy}
                    entries={scaffolds.entries}
                    {...(scaffolds.lastRun === undefined ? {} : { lastRun: scaffolds.lastRun })}
                    {...(scaffolds.message === undefined ? {} : { message: scaffolds.message })}
                    onStart={(entry, directoryName) => {
                      void scaffolds.start(entry, directoryName);
                    }}
                    runnable={scaffolds.runnable}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <TranscriptWindow
          align="start"
          className="code-thread-workspace__conversation"
          estimateSize={96}
          gap={18}
          itemKey={(message) => message.id}
          items={messages}
          key={String(props.threadId)}
          listClassName="code-thread-workspace__transcript thread-column"
          {...(confirmingRestore === undefined ? {} : { pinnedKeys: [confirmingRestore] })}
          renderItem={(message, index) => {
            const previousAssistant = previousAssistantMessage(messages, index);
            const handoff =
              message.role === "assistant" &&
              previousAssistant !== undefined &&
              providerIdentityChanged(previousAssistant, message);
            const activity =
              message.role === "assistant" && message.operationId !== undefined
                ? props.controller.turnActivity.get(String(message.operationId))
                : undefined;
            const markedCheckpoint =
              message.operationId === undefined
                ? undefined
                : checkpoints.byAnchor.get(String(message.operationId));
            return (
              <div className="code-thread-workspace__row">
                {handoff ? (
                  <OctantSeparatorWithLabel
                    aria-label="Provider handoff"
                    className="uppercase tracking-wide"
                  >
                    Provider handoff ·{" "}
                    {providerModelLabel(providerGroups, {
                      providerInstanceId: message.providerInstanceId,
                      modelId: message.modelId,
                    })}
                  </OctantSeparatorWithLabel>
                ) : null}
                <article
                  className={`code-thread-workspace__message code-thread-workspace__message--${message.role === "user" ? "user" : "agent"}`}
                >
                  <TurnActionMenu
                    actions={codeTurnActions({
                      canFork:
                        message.role === "assistant" &&
                        message.operationId !== undefined &&
                        message.status === "completed" &&
                        props.onOpenCodeThread !== undefined,
                      canCopyMarkdown:
                        message.role === "assistant" &&
                        message.status === "completed" &&
                        message.text.trim().length > 0,
                      canCheckpoint:
                        message.role === "assistant" &&
                        message.operationId !== undefined &&
                        message.status === "completed" &&
                        checkpoints.available,
                      canRestoreFiles:
                        message.role === "user" && message.checkpoint !== undefined && mayRestore,
                      checkpointBusy: checkpoints.busy,
                      forking,
                      marked: markedCheckpoint !== undefined,
                      restoring,
                    })}
                    onAction={(value) => {
                      if (value === "fork") void forkFrom(message);
                      else if (value === "checkpoint-mark") {
                        setCheckpointDraft({ messageId: message.id, kind: "mark" });
                      } else if (value === "checkpoint-restore") {
                        setCheckpointDraft({ messageId: message.id, kind: "restore" });
                      } else if (value === "checkpoint-forget") {
                        if (markedCheckpoint !== undefined)
                          void checkpoints.forget(markedCheckpoint);
                      } else if (value === "restore-files") {
                        setRestoreMessage(undefined);
                        setConfirmingRestore(message.id);
                      } else if (value === "copy-markdown") {
                        void copyText(message.text);
                      } else if (value === "copy-references") {
                        void copyText(message.text);
                      }
                    }}
                  >
                    {message.role === "assistant" ? (
                      <TurnHeader
                        outcome={turnHeaderOutcome(message.status)}
                        provider={
                          message.providerInstanceId === undefined || message.modelId === undefined
                            ? "Octant Code"
                            : providerModelLabel(providerGroups, {
                                providerInstanceId: message.providerInstanceId,
                                modelId: message.modelId,
                              })
                        }
                        {...(message.status === undefined || message.status === "completed"
                          ? {}
                          : {
                              label: turnStatusLabel(
                                message.status,
                                props.controller.providerRequests,
                              ),
                            })}
                        {...(message.at === undefined ? {} : { at: message.at })}
                      />
                    ) : null}
                    {message.attachments === undefined ? null : (
                      <CodeAttachmentGallery
                        attachments={message.attachments}
                        {...(props.attachmentClient === undefined
                          ? {}
                          : { client: props.attachmentClient })}
                        threadId={props.threadId}
                      />
                    )}
                    {activity === undefined ? null : (
                      <CodeTranscriptRow
                        activity={activity}
                        running={message.status === "incomplete"}
                        settled={message.status === "completed"}
                      />
                    )}
                    {/* An assistant reply is markdown — a plan arrives as a
                    heading and a numbered list, and rendering it as one long
                    line is what made plans unreadable here. What the user typed
                    stays exactly as they typed it. */}
                    {message.role === "assistant" && message.text.length > 0 ? (
                      <ChatRichText body={message.text} />
                    ) : message.text.length > 0 ? (
                      <TrackerReferenceText asParagraph text={message.text} />
                    ) : (
                      <p>{busy ? "Thinking…" : ""}</p>
                    )}
                    {message.role === "user" && turnTimeLabel(message.at) !== undefined ? (
                      <time
                        className="code-thread-workspace__turn-time code-thread-workspace__turn-time--user"
                        dateTime={message.at}
                        title={turnTimeTitle(message.at)}
                      >
                        {turnTimeLabel(message.at)}
                      </time>
                    ) : null}
                    {message.role === "user" &&
                    message.executionPolicy !== undefined &&
                    message.executionPolicy !== previousUserPolicy(messages, index) ? (
                      <p className="code-thread-workspace__turn-access">
                        Access · {CODE_ACCESS_POSTURE_LABEL[message.executionPolicy]}
                      </p>
                    ) : null}
                    {(markedCheckpoint !== undefined ||
                      checkpointDraft?.messageId === message.id) &&
                    message.role === "assistant" &&
                    message.operationId !== undefined &&
                    message.status === "completed" &&
                    checkpoints.available ? (
                      <footer className="code-thread-workspace__checkpoint">
                        <ThreadCheckpointControls
                          busy={checkpoints.busy}
                          {...(markedCheckpoint === undefined
                            ? {}
                            : { checkpoint: markedCheckpoint })}
                          defaultLabel="Checkpoint"
                          {...(checkpointDraft?.messageId === message.id
                            ? { draft: checkpointDraft.kind }
                            : {})}
                          onCancelDraft={() => setCheckpointDraft(undefined)}
                          onMark={(label) => {
                            const operationId = message.operationId;
                            if (operationId === undefined || view === undefined) return;
                            void checkpoints.mark(
                              { mode: "code", threadId: view.thread.id, operationId },
                              label,
                            );
                            setCheckpointDraft(undefined);
                          }}
                          onRestore={(title) => {
                            const activeView = view;
                            if (markedCheckpoint === undefined || activeView === undefined) return;
                            setCheckpointDraft(undefined);
                            void (async () => {
                              const restored = await checkpoints.restore(markedCheckpoint, title);
                              // The new thread runs on its own worktree at the
                              // marked revision; opening it is what makes that
                              // visible, and this thread is untouched either way.
                              if (restored?.mode === "code") {
                                props.onOpenCodeThread?.(
                                  restored.threadId,
                                  title,
                                  activeView.thread.projectId,
                                );
                              }
                            })();
                          }}
                        />
                      </footer>
                    ) : null}
                    {message.role === "user" &&
                    message.checkpoint !== undefined &&
                    mayRestore &&
                    confirmingRestore === message.id ? (
                      <footer className="code-thread-workspace__restore">
                        <span>Put the files back the way they were before this message?</span>
                        <OctantButton
                          disabled={restoring}
                          onClick={() => void restoreCheckpoint(message)}
                          size="sm"
                          variant="destructive"
                        >
                          Restore files
                        </OctantButton>
                        <OctantButton
                          disabled={restoring}
                          onClick={() => setConfirmingRestore(undefined)}
                          size="sm"
                          variant="ghost"
                        >
                          Keep current files
                        </OctantButton>
                      </footer>
                    ) : null}
                  </TurnActionMenu>
                </article>
              </div>
            );
          }}
          restoreKey={String(props.threadId)}
          role="region"
          {...(pendingMessage === null ? {} : { trail: pendingMessage })}
        />
      )}

      <InlineThreadPlan {...(changedFiles === undefined ? {} : { changedFiles })} />

      {!displayReady ||
      props.imageGenerationClient === undefined ||
      props.imageGenerationProfiles === undefined ? null : (
        <GeneratedImageList
          canSaveToProject
          client={props.imageGenerationClient}
          onAttach={(file) => attachments.attach([file])}
          onSaveToProject={(job, artifact) => {
            void props.imageGenerationClient
              ?.save({
                jobId: job.id,
                attachmentId: artifact.attachmentId,
                relativePath: `generated/${String(artifact.attachmentId).slice(0, 8)}.png`,
              })
              .then((result) => {
                if (result === undefined) return;
                if (result.status !== "saved") attachments.refuse(result.reason);
              })
              .catch(() => {
                attachments.refuse("The image could not be saved.");
              });
          }}
          profiles={props.imageGenerationProfiles}
          scopeId={decodeImageGenerationScopeId(String(thread.id))}
          threadKind="code-thread"
        />
      )}
      <CodeCheckoutBar
        {...(props.onCreatePullRequest === undefined
          ? {}
          : { onCreatePullRequest: props.onCreatePullRequest })}
      />
      <ThreadComposer
        className="code-thread-workspace__composer thread-column"
        chips={
          <>
            {/*
             * Side Chat has no surface in a Code tab, so the chip offers only
             * removal here: rendering a control whose sidecar this workspace
             * cannot open would mint a thread the user never sees.
             */}
            <ThreadMentionChips
              chips={threadMentions.chips}
              onRemove={(mentionedThreadId) =>
                threadMentions.composer?.onRemoveChip(mentionedThreadId)
              }
            />
            <TrackerReferenceComposerHints draft={draft} />
            {attachments.staged.length === 0 && attachments.message === undefined ? null : (
              <div className="code-thread-workspace__attachments" aria-label="Attached images">
                {attachments.staged.map(({ previewUrl, reference }) => (
                  <span
                    className="chip code-thread-workspace__attachment"
                    key={reference.attachmentId}
                  >
                    <img
                      alt={reference.displayName}
                      className="code-thread-workspace__attachment-thumb"
                      src={previewUrl}
                    />
                    <span className="code-thread-workspace__attachment-name">
                      {reference.displayName}
                    </span>
                    <OctantButton
                      aria-label={`Remove ${reference.displayName}`}
                      className="chip-x window-no-drag"
                      onClick={() => attachments.remove(reference.attachmentId)}
                      type="button"
                    >
                      ×
                    </OctantButton>
                  </span>
                ))}
                {attachments.message === undefined ? null : (
                  <span className="code-thread-workspace__hint" role="status">
                    {attachments.message}
                  </span>
                )}
              </div>
            )}
            {props.controller.draftStagedDropped === true ? (
              <p className="code-thread-workspace__hint" role="status">
                {COMPOSER_STAGED_DROPPED_NOTE}
              </p>
            ) : null}
            {props.controller.draftPersistError === undefined ? null : (
              <p className="code-thread-workspace__hint" role="status">
                {props.controller.draftPersistError}
              </p>
            )}
          </>
        }
        label={{
          className: "code-thread-workspace__message-field",
          htmlFor: `code-thread-composer-${String(thread.id)}`,
          text: "Follow-up message",
          textClassName: "visually-hidden",
        }}
        input={
          <OctantTextarea
            aria-activedescendant={
              mention.activeCandidate !== undefined
                ? `${mentionListId}-${String(mention.activeCandidate.threadId)}`
                : pathMentionOpen && pathMentions.activeCandidate !== undefined
                  ? `${pathMentionListId}-${pathMentions.activeCandidate.path}`
                  : undefined
            }
            aria-autocomplete="list"
            aria-controls={
              mention.open ? mentionListId : pathMentionOpen ? pathMentionListId : undefined
            }
            aria-expanded={mention.open || pathMentionOpen}
            className="composer-input window-no-drag"
            id={`code-thread-composer-${String(thread.id)}`}
            onChange={(event) => {
              draftRevisionRef.current += 1;
              setDraft(event.currentTarget.value);
              props.controller.setPendingDraft?.(
                event.currentTarget.value,
                event.currentTarget.selectionStart ?? event.currentTarget.value.length,
              );
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onClick={(event) => {
              const caret = event.currentTarget.selectionStart;
              if (caret !== null) {
                props.controller.setPendingDraft?.(event.currentTarget.value, caret);
              }
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onDragOver={(event) => {
              if (props.attachmentClient === undefined) return;
              event.preventDefault();
            }}
            onDrop={(event) => {
              if (attachFromTransfer(event.dataTransfer)) event.preventDefault();
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => {
              if (event.key === "Escape") return;
              const caret = event.currentTarget.selectionStart;
              if (caret !== null) {
                props.controller.setPendingDraft?.(event.currentTarget.value, caret);
              }
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onPaste={(event) => {
              if (attachFromTransfer(event.clipboardData)) event.preventDefault();
            }}
            placeholder={busy ? "Send the next message…" : "Ask for follow-up changes…"}
            ref={textareaRef}
            rows={2}
            value={draft}
          />
        }
        typeahead={
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
            {pathMentionOpen ? (
              <PathMentionTypeahead
                activeIndex={pathMentions.activeIndex}
                busy={pathMentions.busy}
                candidates={pathMentions.candidates}
                listId={pathMentionListId}
                onChoose={pathMentions.choose}
                onHover={pathMentions.setActiveIndex}
              />
            ) : null}
          </>
        }
        row={{
          ariaLabel: "Thread context",
          leading: (
            <>
              <ComposerVoiceButton
                disabled={busy}
                onTranscript={(transcript) => {
                  const next = appendTranscript(draft, transcript);
                  draftRevisionRef.current += 1;
                  setDraft(next);
                  props.controller.setPendingDraft?.(next, next.length);
                }}
              />
              <ComposerModelPicker
                ariaLabel="Provider and model"
                disabled={busy || providerChanging}
                groups={providerGroups}
                onSelect={(selection) => void changeProvider(selection)}
                selectedModelId={thread.modelId}
                selectedProviderInstanceId={thread.providerInstanceId}
              />
              <CodeAccessPicker
                ceiling={thread.executionPolicy}
                disabled={accessChanging}
                nativeConfirmationAvailable={props.requestFullAccessApproval !== undefined}
                onRaiseThread={(next) => void changeAccess(next)}
                onSelect={setTurnAccessOverride}
                value={nextTurnAccess}
              />
              {/*
              Provenance, not a control: the profile narrowed this thread once,
              when it started, and is never consulted again. Editing the profile
              afterwards cannot change what this thread may do, so the chip says
              which working mode produced the posture and stops there.
            */}
              {profileName === undefined ? null : (
                <span className="code-thread-workspace__profile" title="Started under this profile">
                  <UserRoundCog aria-hidden="true" size={12} strokeWidth={1.8} />
                  <span>{profileName}</span>
                </span>
              )}
            </>
          ),
          actions: {
            kind: "send",
            send: {
              ariaLabel: "Send follow-up",
              disabled: !canSend || steered.pending !== undefined,
              onSend: () => void submitFollowUp(),
            },
          },
        }}
        footer={
          <div aria-live="polite" className="code-thread-workspace__status">
            <span className="code-thread-workspace__hint">
              {providerChanging
                ? "Checking the selected provider…"
                : steered.pending !== undefined
                  ? "Sent · runs when the response in progress finishes"
                  : busy
                    ? "Enter sends when this response finishes"
                    : "Enter to send · Shift+Enter for a new line"}
            </span>
            {accessMessage === undefined ? null : (
              <span className="code-thread-workspace__hint" role="status">
                {accessMessage}
              </span>
            )}
            {/*
              A restore point outlives the message that announced it, so the
              offer stands on the undo point alone. Returning to the thread
              after a tab switch finds the way back still here, described
              plainly rather than as the sentence the last restore printed.
            */}
            {restoreMessage === undefined && restoreUndo === undefined ? null : (
              <span className="code-thread-workspace__hint" role="status">
                {restoreMessage ?? "Files were restored to an earlier point."}
                {restoreUndo === undefined ? null : (
                  <OctantButton
                    disabled={restoring}
                    onClick={() => {
                      void undoRestore();
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    Undo restore
                  </OctantButton>
                )}
              </span>
            )}
            {forkMessage === undefined ? null : (
              <span className="code-thread-workspace__hint" role="alert">
                {forkMessage}
              </span>
            )}
            {/* Spend and limits sit at the far end of the same line. A provider
                that has reported nothing shows nothing here rather than a
                sentence saying so, and a limit appears only once it is worth
                acting on; the context meter's panel keeps the full account. */}
            <span className="code-thread-workspace__usage">
              {threadUsageLabel(props.controller.threadUsage) === undefined ? null : (
                <span className="code-thread-workspace__hint" aria-label="Thread usage">
                  {threadUsageLabel(props.controller.threadUsage)}
                </span>
              )}
              {props.controller.threadUsage.limits
                .filter((limit) => limit.status !== "allowed")
                .map((limit) => (
                  <span
                    className={`code-thread-workspace__limit code-thread-workspace__limit--${limit.status}`}
                    key={limit.window}
                  >
                    {providerLimitLabel(limit)}
                  </span>
                ))}
            </span>
          </div>
        }
      />
    </section>
  );
}

function codeTurnActions(input: {
  readonly canFork: boolean;
  readonly canCopyMarkdown: boolean;
  readonly canCheckpoint: boolean;
  readonly canRestoreFiles: boolean;
  readonly checkpointBusy: boolean;
  readonly forking: boolean;
  readonly marked: boolean;
  readonly restoring: boolean;
}): ReadonlyArray<TurnAction> {
  const actions: TurnAction[] = [];
  if (input.canFork) {
    actions.push({
      label: input.forking ? "Forking…" : "Fork from here",
      value: "fork",
      ...(input.forking ? { disabled: true } : {}),
    });
  }
  if (input.canCopyMarkdown) {
    actions.push({ label: "Copy as Markdown", value: "copy-markdown" });
  }
  if (input.canCheckpoint) {
    if (input.marked) {
      actions.push({
        label: "Restore from here",
        value: "checkpoint-restore",
        ...(input.checkpointBusy ? { disabled: true } : {}),
      });
      actions.push({
        label: "Forget",
        value: "checkpoint-forget",
        ...(input.checkpointBusy ? { disabled: true } : {}),
      });
    } else {
      actions.push({
        label: "Checkpoint",
        value: "checkpoint-mark",
        ...(input.checkpointBusy ? { disabled: true } : {}),
      });
    }
  }
  if (input.canRestoreFiles) {
    actions.push({
      label: "Restore files to this point",
      value: "restore-files",
      ...(input.restoring ? { disabled: true } : {}),
    });
  }
  actions.push({ label: "Copy references", value: "copy-references" });
  return actions;
}

/**
 * The posture a message ran under is worth a line only where it changed.
 * Printing "Access · Ask for approvals" under every message repeated the
 * thread's default on each turn and buried the one turn that differed.
 */
function previousUserPolicy(
  messages: ReadonlyArray<CodeController["conversation"][number]>,
  index: number,
) {
  for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = messages[candidateIndex];
    if (candidate?.role === "user" && candidate.executionPolicy !== undefined) {
      return candidate.executionPolicy;
    }
  }
  return undefined;
}

function previousAssistantMessage(
  messages: ReadonlyArray<CodeController["conversation"][number]>,
  index: number,
) {
  for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = messages[candidateIndex];
    if (candidate?.role === "assistant") return candidate;
  }
  return undefined;
}

/**
 * What this thread has spent, in the provider's own figures. A provider that
 * reports no tokens says so plainly rather than reading as a free thread, and
 * a cost appears only when the provider stated one.
 */
/**
 * Name a fork after the thread it came from, without stacking one suffix on
 * another when a fork is itself forked.
 */
function forkTitle(sourceTitle: string): string {
  const base = sourceTitle.replace(/ \(fork(?: \d+)?\)$/, "").trim();
  const title = `${base.length === 0 ? "Code thread" : base} (fork)`;
  return title.length > MAX_CODE_THREAD_TITLE_LENGTH
    ? `${title.slice(0, MAX_CODE_THREAD_TITLE_LENGTH - 7).trimEnd()} (fork)`
    : title;
}

function threadUsageLabel(usage: CodeController["threadUsage"]): string | undefined {
  // Zero tokens with no report is not a free thread; it is nothing to say yet.
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return undefined;
  const tokens = `${compactTokens(usage.inputTokens)} in · ${compactTokens(usage.outputTokens)} out`;
  return usage.costUsd === undefined ? tokens : `${tokens} · ${formatUsd(usage.costUsd)}`;
}

function providerLimitLabel(limit: CodeController["threadUsage"]["limits"][number]): string {
  const share =
    limit.utilization === undefined ? undefined : `${Math.round(limit.utilization * 100)}% used`;
  const resets =
    limit.resetsAt === undefined
      ? undefined
      : `resets ${new Date(limit.resetsAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`;
  const state =
    limit.status === "exhausted" ? "spent" : limit.status === "warning" ? "low" : undefined;
  const parts = [providerLimitWindowLabel(limit.window), state, share, resets].filter(
    (part): part is string => part !== undefined,
  );
  return parts.join(" · ");
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatUsd(cost: number): string {
  return cost < 0.01 && cost > 0 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

function waitingTurnLabel(requests: CodeController["providerRequests"]): string {
  const latest = requests.at(-1);
  if (latest?.kind === "approval") return "Waiting for approval";
  if (latest?.kind === "input") return "Waiting for your input";
  return "Waiting";
}

function codeTurnSettlement(status: CodeTurnStatus): TurnSettlement | "idle" {
  if (status === "sending" || status === "running") return "running";
  if (status === "waiting") return "waiting";
  if (status === "failed") return "failed";
  return "completed";
}

function providerIdentityChanged(
  previous: CodeController["conversation"][number],
  current: CodeController["conversation"][number],
): boolean {
  if (
    previous.providerInstanceId === undefined ||
    previous.modelId === undefined ||
    current.providerInstanceId === undefined ||
    current.modelId === undefined
  ) {
    return false;
  }
  return (
    previous.providerInstanceId !== current.providerInstanceId ||
    previous.modelId !== current.modelId
  );
}

/**
 * Clock time for a turn from today, and a date for anything older: a bare
 * "09:14" on a week-old message reads as if it just happened.
 */
/**
 * Whether the model a thread is bound to reads images.
 *
 * `undefined` when this renderer cannot tell — an unlisted provider, a model
 * the picker never described. The host decides in that case; the composer does
 * not refuse an attachment on a guess.
 */
function boundModelReadsImages(
  groups: ReadonlyArray<PickerGroup>,
  thread: { readonly providerInstanceId: unknown; readonly modelId: unknown },
): boolean | undefined {
  const model = groups
    .find((candidate) => String(candidate.instance.id) === String(thread.providerInstanceId))
    ?.sections.flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(thread.modelId));
  const modalities = model?.model.inputModalities;
  return modalities === undefined ? undefined : modalities.includes("image");
}

function turnHeaderOutcome(
  status: "waiting" | "completed" | "interrupted" | "failed" | "incomplete" | undefined,
): TurnHeaderOutcome {
  return status === undefined || status === "completed"
    ? "completed"
    : status === "incomplete"
      ? "running"
      : status;
}

function turnStatusLabel(
  status: "waiting" | "interrupted" | "failed" | "incomplete",
  requests: CodeController["providerRequests"],
): string {
  switch (status) {
    case "waiting":
      // A turn waits for an approval or an answer only while the host holds
      // the request; a turn parked by the host itself (a rate limit, an
      // unconfirmed checkout, a lost session) is waiting on nothing the
      // person can click, and used to be mislabelled as an approval.
      return waitingTurnLabel(requests);
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "incomplete":
      return "Working";
  }
}

function ProviderApprovalPrompt(props: {
  readonly summary: string;
  readonly onAnswer: (decision: "approved" | "denied") => void;
}) {
  return (
    <div
      className="callout callout-warn thread-column code-thread-workspace__callout code-thread-workspace__provider-request"
      role="group"
      aria-label="Provider approval"
    >
      <span>{props.summary}</span>
      <OctantButton onClick={() => props.onAnswer("approved")} type="button">
        Approve
      </OctantButton>
      <OctantButton onClick={() => props.onAnswer("denied")} type="button" variant="ghost">
        Deny
      </OctantButton>
    </div>
  );
}

function ProviderInputPrompt(props: {
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
  readonly onAnswer: (response: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const trimmed = answer.trim();
  return (
    <form
      className="callout callout-warn thread-column code-thread-workspace__callout code-thread-workspace__provider-request"
      aria-label="Provider question"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed.length > 0) props.onAnswer(trimmed);
      }}
    >
      <span>{props.prompt}</span>
      {props.options.map((option) => (
        <OctantButton
          key={option}
          onClick={() => props.onAnswer(option)}
          type="button"
          variant="ghost"
        >
          {option}
        </OctantButton>
      ))}
      <OctantInput
        aria-label="Answer"
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Type an answer"
        value={answer}
      />
      <OctantButton disabled={trimmed.length === 0} type="submit">
        Send answer
      </OctantButton>
    </form>
  );
}

function useObservedChangedFiles(options: {
  readonly client: CodeClient | undefined;
  readonly enabled: boolean;
  readonly projectId: CodeThread["projectId"] | undefined;
  readonly threadId: CodeThreadId;
}): ThreadTaskChangedFiles | undefined {
  const [changedFiles, setChangedFiles] = useState<ThreadTaskChangedFiles>();
  const { client, enabled, projectId, threadId } = options;

  useEffect(() => {
    if (!enabled || client === undefined) {
      setChangedFiles(undefined);
      return;
    }
    let active = true;
    setChangedFiles(undefined);
    void client
      .queryBoard({
        version: 1,
        ...(projectId === undefined ? {} : { projectIds: [projectId] }),
      })
      .then(
        (view) => {
          if (!active) return;
          const card = view.cards.find((entry) => String(entry.threadId) === String(threadId));
          setChangedFiles(observedTaskChangedFiles(card?.changedFiles));
        },
        () => {
          if (active) setChangedFiles(undefined);
        },
      );
    return () => {
      active = false;
    };
  }, [client, enabled, projectId, threadId]);

  return changedFiles;
}

function observedTaskChangedFiles(
  state: CodeThreadChangedFileState | undefined,
): ThreadTaskChangedFiles | undefined {
  if (state?.kind !== "observed") return undefined;
  return {
    kind: "observed",
    changedPathCount: state.changedPathCount,
    freshness: state.freshness,
    insertions: state.insertions,
    deletions: state.deletions,
  };
}
