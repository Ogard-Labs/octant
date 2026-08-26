import {
  MAX_CODE_THREAD_TITLE_LENGTH,
  type CodeApprovalId,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts/code";
import type { CodeCheckpoint, CodeThreadChangedFileState } from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import {
  clampTurnAccessPosture,
  decidesCodeEffectsByApproval,
  type PickerGroup,
} from "@octant/domain";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { CirclePause, UserRoundCog } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ThreadComposer } from "../composer/ThreadComposer";
import { useQueuedSend } from "../composer/useQueuedSend";
import type { TurnSettlement } from "../composer/queuedSend";
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
import { InlineThreadPlan } from "../plan/InlineThreadPlan";
import { useThreadPlan } from "../plan/ThreadPlanContext";
import type { ThreadTaskChangedFiles } from "../plan/ThreadTaskViewer";
import { ThreadChildRunStatusSlot } from "../agents/ThreadChildRunStatusSlot";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { HostId } from "@octant/contracts/host";
import type { CodeClient, ThreadMentionClient } from "@octant/client-runtime";
import { useCodeAttachments } from "./useCodeAttachments";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../chat/ThreadMentionPicker";
import { useThreadMentions } from "../chat/useThreadMentions";
import { CodeAttachmentGallery } from "./CodeAttachmentGallery";
import { CodeTranscriptRow } from "./CodeTranscriptRow";
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
 * Whether two lists carry the same items, by a caller-supplied identity.
 * Used to tell whether a queued send's attachments, paths, or mentions are
 * still exactly what the composer holds now — order matters, since these
 * lists are only ever appended to or removed from, never reordered.
 */
function sameByKey<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>, key: (item: T) => string): boolean {
  return JSON.stringify(a.map(key)) === JSON.stringify(b.map(key));
}

export interface CodeThreadWorkspaceProps {
  readonly agentRunClient?: AgentRunClient;
  readonly onAddAgent?: () => void;
  readonly controller: CodeController;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly threadId: CodeThreadId;
  readonly canvasClient?: CanvasClient;
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
  const plan = useThreadPlan()?.plan;
  // The board observation is the host's changed-file evidence. Ask only when
  // the plan surface will render it: a thread with no plan has nowhere to put
  // the count, and querying every open conversation would rescan every worktree.
  const changedFiles = useObservedChangedFiles({
    client: props.controller.client,
    enabled: view !== undefined && plan != null && plan.status !== "withdrawn",
    projectId: view?.thread.projectId,
    threadId: props.threadId,
  });
  const [draft, setDraft] = useState(props.controller.pendingDraft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
    threadId: String(props.threadId),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const scaffolds = useScaffoldCatalog({
    threadId: String(props.threadId),
    checkoutId: String(view?.checkout.id ?? ""),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  // The preset needs the checkout the thread is bound to. A thread without one
  // yet has nothing to arrange around, so the picker offers nothing.
  const presets = useWorkspacePresets({
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
  const sendQueuedRef = useRef<() => Promise<boolean>>(async () => false);
  // Pasting or dropping a picture uploads it now and keeps only its id. The
  // turn names ids, so the host sends the provider bytes it accepted itself.
  const attachments = useCodeAttachments({
    client: props.attachmentClient ?? UNAVAILABLE_ATTACHMENT_CLIENT,
    threadId: props.attachmentClient === undefined ? undefined : props.threadId,
  });
  const queued = useQueuedSend({
    threadKey: String(props.threadId),
    settlement: codeTurnSettlement(props.controller.turnStatus),
    ready: !attachments.busy,
    send: () => sendQueuedRef.current(),
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
      setDraft(next);
      props.controller.setPendingDraft?.(next, caretIndex);
    },
    textarea: () => textareaRef.current,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const pathMentionListId = `code-path-mentions-${String(props.threadId)}`;
  const pathMentionOpen = pathMentions.open && !mention.open;
  // Read inside the queued send's async closure, after an await, to see
  // whether the user has since changed what a queued send would carry.
  // Plain closure captures of these hook-returned values would only ever see
  // the render that started the send, never a later one.
  const pathMentionsSelectedRef = useRef(pathMentions.selectedPaths);
  pathMentionsSelectedRef.current = pathMentions.selectedPaths;
  const threadMentionChipsRef = useRef(threadMentions.chips);
  threadMentionChipsRef.current = threadMentions.chips;
  const turnAccessOverrideRef = useRef(turnAccessOverride);
  turnAccessOverrideRef.current = turnAccessOverride;
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
  // A running turn queues rather than blocks: the host admits one turn per
  // thread, so the composer parks the next one instead of making the user wait.
  const canSend = trimmed.length > 0 && !attachments.busy;
  const providerGroups = props.providerGroups ?? [];
  const messages = props.controller.conversation;
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
    if (!canSend) return;
    // A `#thread` chip names a thread; it never carries one. The turn sends
    // chip ids and the host reads each one as the turn runs, re-checking that
    // the sender may still open it, so the follow-up the journal keeps is
    // exactly what the user typed and no later turn replays a thread they
    // pointed at once. This check is the composer's own report: a chip the
    // host refuses is shown as unavailable rather than silently dropped.
    const threadMentionIds = await threadMentions.resolveForSend();
    const fileMentionPaths = pathMentions.selectedPaths;
    if (busy) {
      queued.enqueue();
      return;
    }
    // The one-shot override is consumed when the host accepts this start, not
    // when the turn later finishes: a long running turn must not leave Plan
    // selected so a queued follow-up inherits it. A refused start puts it back.
    const override = turnAccessOverride;
    setTurnAccessOverride(undefined);
    // The chips stay until the host accepts the turn: a refused or dropped send
    // must leave the message retryable with the same images, not just its text.
    const sent = await props.controller.sendFollowUp(
      trimmed,
      threadMentionIds,
      attachments.peekForSend(),
      fileMentionPaths,
      nextTurnAccess,
    );
    if (sent) {
      attachments.takeForSend();
      setDraft("");
      threadMentions.clear();
      pathMentions.clear();
      queued.discard();
    } else {
      setTurnAccessOverride((current) => current ?? override);
    }
  }
  sendQueuedRef.current = async () => {
    const threadKey = String(props.threadId);
    const prompt = draft.trim();
    if (prompt.length === 0) return false;
    // The full intent this queued send is carrying. A settlement that
    // arrives after the user has changed any of it belongs to a draft this
    // send never carried, so clearing state on success must compare against
    // this whole snapshot rather than the draft text alone. Attachments are
    // NOT taken here — `takeForSend` also revokes their preview URLs, and a
    // refused or dropped send must leave the queued images retryable, not
    // silently gone.
    const attachmentSnapshot = attachments.peekForSend();
    const fileMentionPaths = pathMentions.selectedPaths;
    const threadMentionChips = threadMentions.chips;
    const access = nextTurnAccess;
    const queuedAccessOverride = turnAccessOverride;
    const stillHoldsQueuedSnapshot = () =>
      String(props.threadId) === threadKey &&
      draftRef.current.trim() === prompt &&
      turnAccessOverrideRef.current === queuedAccessOverride &&
      sameByKey(attachments.peekForSend(), attachmentSnapshot, (ref) => String(ref.attachmentId)) &&
      sameByKey(pathMentionsSelectedRef.current, fileMentionPaths, (path) => path) &&
      sameByKey(threadMentionChipsRef.current, threadMentionChips, (chip) => String(chip.threadId));
    const restoreQueuedSend = () => {
      if (String(props.threadId) !== threadKey) return;
      // A queued send is still an ordinary, refusal-capable command. The
      // staged images were never taken, so restoring the text alone is
      // enough to leave the whole queued message retryable — but only when
      // the composer still holds the empty state this queued send cleared
      // it to. If the user typed a newer draft while resolveForSend or
      // sendFollowUp was pending, that draft is the one worth keeping; a
      // stale queued prompt must not overwrite it.
      if (draftRef.current.length > 0) return;
      setDraft(prompt);
      props.controller.setPendingDraft?.(prompt);
    };
    setDraft("");
    props.controller.setPendingDraft?.("");
    try {
      const threadMentionIds = await threadMentions.resolveForSend();
      if (String(props.threadId) !== threadKey) return false;
      const sent = await props.controller.sendFollowUp(
        prompt,
        threadMentionIds,
        attachmentSnapshot,
        fileMentionPaths,
        access,
      );
      if (sent) {
        // Do not clear or take context the user added while this queued turn
        // was in flight. The queued prompt owns its original text,
        // attachments, mentions, paths, and access choice; a newer draft
        // owns anything changed after it was parked.
        if (stillHoldsQueuedSnapshot()) {
          attachments.takeForSend();
          threadMentions.clear();
          pathMentions.clear();
          setTurnAccessOverride(undefined);
        }
      } else {
        restoreQueuedSend();
      }
      return sent;
    } catch {
      restoreQueuedSend();
      return false;
    }
  };

  function attachFromTransfer(items: DataTransfer | null): boolean {
    if (props.attachmentClient === undefined || items === null) return false;
    const files = [...items.files];
    if (files.length === 0) return false;
    // The host refuses this turn anyway. Saying so at the paste is kinder than
    // letting the user write the message first and lose it at send.
    if (boundModelReadsImages(providerGroups, thread) === false) {
      attachments.refuse(
        `${boundProviderModelLabel(providerGroups, thread)} does not support images. Choose a vision model to attach one.`,
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
          <span>{waitingTurnLabel(props.controller.providerRequests)}</span>
        </div>
      ) : props.controller.turnError === undefined ? null : (
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

      {messages.length === 0 ? (
        <div className="code-thread-workspace__conversation" role="log" aria-live="polite">
          <div className="code-thread-workspace__transcript thread-column">
            {showEmptyConversation ? (
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
                    {boundProviderModelLabel(providerGroups, {
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
                      } else if (value === "copy-references") {
                        void copyText(message.text);
                      }
                    }}
                  >
                    {message.role === "assistant" ? (
                      <header>
                        <span>
                          {message.providerInstanceId === undefined || message.modelId === undefined
                            ? "Octant Code"
                            : boundProviderModelLabel(providerGroups, {
                                providerInstanceId: message.providerInstanceId,
                                modelId: message.modelId,
                              })}
                        </span>
                        {message.status === undefined || message.status === "completed" ? null : (
                          <span className="code-thread-workspace__turn-status">
                            {turnStatusLabel(message.status)}
                          </span>
                        )}
                      </header>
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
                      />
                    )}
                    {/* An assistant reply is markdown — a plan arrives as a
                    heading and a numbered list, and rendering it as one long
                    line is what made plans unreadable here. What the user typed
                    stays exactly as they typed it. */}
                    {message.role === "assistant" && message.text.length > 0 ? (
                      <ChatRichText body={message.text} />
                    ) : (
                      <p>{message.text.length > 0 ? message.text : busy ? "Thinking…" : ""}</p>
                    )}
                    {message.role === "user" && message.executionPolicy !== undefined ? (
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
        />
      )}

      <InlineThreadPlan {...(changedFiles === undefined ? {} : { changedFiles })} />

      <ThreadComposer
        className={`code-thread-workspace__composer thread-column${
          queued.state.status === "idle"
            ? ""
            : ` code-thread-workspace__composer--${queued.state.status}`
        }`}
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
            {queued.statusMessage === undefined ? null : (
              <p className="code-thread-workspace__hint" role="status">
                {queued.statusMessage}
              </p>
            )}
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
            placeholder={busy ? "Queue the next message…" : "Ask for follow-up changes…"}
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
              ariaLabel: busy ? "Queue follow-up" : "Send follow-up",
              disabled: !canSend,
              onSend: () => void submitFollowUp(),
            },
            ...(queued.state.status === "idle"
              ? {}
              : {
                  discard: {
                    ariaLabel: "Discard queued message",
                    onDiscard: () => {
                      queued.discard();
                      setDraft("");
                      props.controller.setPendingDraft?.("");
                      threadMentions.clear();
                      pathMentions.clear();
                      setTurnAccessOverride(undefined);
                      for (const { reference } of attachments.staged) {
                        attachments.remove(reference.attachmentId);
                      }
                    },
                  },
                }),
            sendHidden: queued.state.status === "queued",
          },
        }}
        footer={
          <div aria-live="polite" className="code-thread-workspace__status">
            <span className="code-thread-workspace__hint">
              {providerChanging
                ? "Checking the selected provider…"
                : queued.state.status !== "idle"
                  ? "Queued follow-up · Enter to edit · Discard to remove"
                  : busy
                    ? "Response in progress · Enter queues this message"
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
            <span className="code-thread-workspace__hint" aria-label="Thread usage">
              {threadUsageLabel(props.controller.threadUsage)}
            </span>
            {props.controller.threadUsage.limits.map((limit) => (
              <span
                className={`code-thread-workspace__limit code-thread-workspace__limit--${limit.status}`}
                key={limit.window}
              >
                {providerLimitLabel(limit)}
              </span>
            ))}
          </div>
        }
      />
    </section>
  );
}

function codeTurnActions(input: {
  readonly canFork: boolean;
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

function threadUsageLabel(usage: CodeController["threadUsage"]): string {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) {
    return "This thread's provider has reported no usage yet.";
  }
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
  const parts = [limit.window.replaceAll("_", " "), state, share, resets].filter(
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
  return "Waiting for approval or input";
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

function boundProviderModelLabel(
  groups: ReadonlyArray<PickerGroup>,
  thread: { readonly providerInstanceId: unknown; readonly modelId: unknown },
): string {
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(thread.providerInstanceId),
  );
  const model = group?.sections
    .flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(thread.modelId));
  const providerLabel = group?.instance.displayName ?? String(thread.providerInstanceId);
  const modelLabel = model?.model.displayName ?? String(thread.modelId);
  return `${providerLabel} — ${modelLabel}`;
}

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

function turnStatusLabel(status: "waiting" | "interrupted" | "failed" | "incomplete"): string {
  switch (status) {
    case "waiting":
      return "Waiting";
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
