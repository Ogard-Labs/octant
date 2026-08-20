import {
  MAX_CODE_THREAD_TITLE_LENGTH,
  type CodeApprovalId,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts/code";
import type { CodeCheckpoint } from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import {
  clampTurnAccessPosture,
  decidesCodeEffectsByApproval,
  type PickerGroup,
} from "@octant/domain";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import { ArrowUp, Bot, UserRoundCog, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import type { CodeOverviewSurfaceKind } from "./CodeOverview";
import type { CodeConversationMessage, CodeController } from "./useCodeController";
import { ChatRichText } from "../chat/ChatRichText";
import { InlineThreadPlan } from "../plan/InlineThreadPlan";
import { AgentRunHierarchy } from "../agents/AgentRunHierarchy";
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
import { ThreadExportControl } from "../thread/ThreadExportControl";

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

export interface CodeThreadWorkspaceProps {
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
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
  const [draft, setDraft] = useState(props.controller.pendingDraft);
  const [providerChanging, setProviderChanging] = useState(false);
  const [accessChanging, setAccessChanging] = useState(false);
  const [accessMessage, setAccessMessage] = useState<string>();
  const [turnAccessOverride, setTurnAccessOverride] = useState<ProviderExecutionPolicy>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [auxiliarySurface, setAuxiliarySurface] = useState<"agents">();
  const [confirmingRestore, setConfirmingRestore] = useState<string>();
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
    onDraftChange: (next) => {
      setDraft(next);
      props.controller.setPendingDraft?.(next);
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
    onDraftChange: (next) => {
      setDraft(next);
      props.controller.setPendingDraft?.(next);
    },
    textarea: () => textareaRef.current,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const pathMentionListId = `code-path-mentions-${String(props.threadId)}`;
  const pathMentionOpen = pathMentions.open && !mention.open;

  // Pasting or dropping a picture uploads it now and keeps only its id. The
  // turn names ids, so the host sends the provider bytes it accepted itself.
  const attachments = useCodeAttachments({
    client: props.attachmentClient ?? UNAVAILABLE_ATTACHMENT_CLIENT,
    threadId: props.attachmentClient === undefined ? undefined : props.threadId,
  });

  function syncMentions(value: string, caret: number | null) {
    mention.sync(value, caret);
    pathMentions.sync(value, caret);
  }

  const childRunStatus =
    props.agentRunClient === undefined ? undefined : (
      <ThreadChildRunStatusSlot client={props.agentRunClient} threadId={String(props.threadId)} />
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
  const queued = props.controller.queuedFollowUps;
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
  const followUp = props.controller.followUps.get(String(thread.id))?.followUp;
  const followUpOpen = followUp?.state === "open";

  async function submitFollowUp() {
    if (!canSend) return;
    // A `#thread` chip names a thread; it never carries one. The turn sends
    // chip ids and the host reads each one as the turn runs, re-checking that
    // the sender may still open it, so the follow-up the journal keeps is
    // exactly what the user typed and no later turn replays a thread they
    // pointed at once. This check is the composer's own report: a chip the
    // host refuses is shown as unavailable rather than silently dropped.
    const threadMentionIds = await threadMentions.resolveForSend();
    if (busy) {
      const queuedAttachments = attachments.peekForSend();
      if (
        props.controller.queueFollowUp(
          trimmed,
          threadMentionIds,
          queuedAttachments,
          nextTurnAccess,
        ) === undefined
      ) {
        return;
      }
      attachments.takeForSend();
      setDraft("");
      props.controller.setPendingDraft?.("");
      threadMentions.clear();
      setTurnAccessOverride(undefined);
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
      nextTurnAccess,
    );
    if (sent) {
      attachments.takeForSend();
      setDraft("");
      threadMentions.clear();
    } else {
      setTurnAccessOverride((current) => current ?? override);
    }
  }

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
      <header className="code-thread-workspace__header">
        <div className="code-thread-workspace__header-row thread-column">
          <div className="code-thread-workspace__identity">
            <h1>{thread.title}</h1>
            <div className="code-thread-workspace__meta">
              <span className="badge code-thread-workspace__lifecycle">
                {lifecycleLabel(thread.lifecycle)}
              </span>
              <span>{headLabel(checkout.head)}</span>
            </div>
            <div
              aria-label="Follow-up"
              className="code-thread-workspace__follow-up"
              data-follow-up={followUpOpen ? "true" : "false"}
            >
              {followUpOpen ? (
                <span
                  aria-label="Follow-up required"
                  className="code-thread-workspace__follow-up-marker"
                  role="status"
                  title={followUp?.reason}
                >
                  <span aria-hidden="true">◆</span> Follow-up: {followUp?.reason}
                </span>
              ) : null}
              {followUpOpen ? (
                <OctantButton
                  onClick={() => void props.controller.completeFollowUp(thread.id)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Complete follow-up
                </OctantButton>
              ) : (
                <OctantButton
                  onClick={() => void props.controller.markFollowUp(thread.id)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Mark for follow-up
                </OctantButton>
              )}
            </div>
          </div>
          {childRunStatus}
          <div className="code-thread-workspace__toolbar" role="toolbar" aria-label="Code surfaces">
            <ThreadExportControl
              mode="code"
              threadId={String(props.threadId)}
              title={thread.title}
              {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
              {...(props.windowCapability === undefined
                ? {}
                : { windowCapability: props.windowCapability })}
            />
            {props.agentRunClient === undefined ? null : (
              <button
                aria-pressed={auxiliarySurface === "agents"}
                className="code-thread-workspace__tool window-no-drag"
                onClick={() =>
                  setAuxiliarySurface((current) => (current === "agents" ? undefined : "agents"))
                }
                type="button"
              >
                <Bot aria-hidden="true" size={14} strokeWidth={1.7} />
                <span>Agents</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {props.controller.errorMessage === undefined ? null : (
        <div
          className="callout callout-warn thread-column code-thread-workspace__callout"
          role="alert"
        >
          <p>{props.controller.errorMessage}</p>
        </div>
      )}

      {props.controller.turnError === undefined ? null : (
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

      {auxiliarySurface === "agents" && props.agentRunClient !== undefined ? (
        <aside
          aria-label="Agent activity"
          className="code-thread-workspace__auxiliary thread-column"
        >
          <AgentRunHierarchy
            // This thread is the parent authority the host verifies before it
            // admits a child, so creation belongs here rather than on a surface
            // that would have to invent one.
            allowCreation
            client={props.agentRunClient}
            parentThreadId={decodeAgentRunParentThreadId(String(thread.id))}
            {...(props.agentRunSettingsClient === undefined
              ? {}
              : { settingsClient: props.agentRunSettingsClient })}
          />
        </aside>
      ) : null}
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
          {messages.map((message, index) => {
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
              // Long threads stay cheap without a windowing library: the engine
              // skips laying out rows that are scrolled out of view, and the
              // reserved size keeps the scrollbar honest.
              <div className="code-thread-workspace__row" key={message.id}>
                {handoff ? (
                  <div
                    aria-label="Provider handoff"
                    className="code-thread-workspace__handoff"
                    role="separator"
                  >
                    Provider handoff ·{" "}
                    {boundProviderModelLabel(providerGroups, {
                      providerInstanceId: message.providerInstanceId,
                      modelId: message.modelId,
                    })}
                  </div>
                ) : null}
                <article
                  className={`code-thread-workspace__message code-thread-workspace__message--${message.role === "user" ? "user" : "agent"}`}
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
                  {message.role === "assistant" &&
                  message.operationId !== undefined &&
                  message.status === "completed" &&
                  props.onOpenCodeThread !== undefined ? (
                    <footer className="code-thread-workspace__fork">
                      <OctantButton
                        disabled={forking}
                        onClick={() => void forkFrom(message)}
                        size="sm"
                        variant="ghost"
                      >
                        {forking ? "Forking…" : "Fork from here"}
                      </OctantButton>
                    </footer>
                  ) : null}
                  {message.role === "assistant" &&
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
                        onForget={() => {
                          if (markedCheckpoint !== undefined)
                            void checkpoints.forget(markedCheckpoint);
                        }}
                        onMark={(label) => {
                          const operationId = message.operationId;
                          if (operationId === undefined || view === undefined) return;
                          void checkpoints.mark(
                            { mode: "code", threadId: view.thread.id, operationId },
                            label,
                          );
                        }}
                        onRestore={(title) => {
                          const activeView = view;
                          if (markedCheckpoint === undefined || activeView === undefined) return;
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
                  {message.role === "user" && message.checkpoint !== undefined && mayRestore ? (
                    <footer className="code-thread-workspace__restore">
                      {confirmingRestore === message.id ? (
                        <>
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
                        </>
                      ) : (
                        <OctantButton
                          disabled={restoring}
                          onClick={() => {
                            setRestoreMessage(undefined);
                            setConfirmingRestore(message.id);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          Restore files to this point
                        </OctantButton>
                      )}
                    </footer>
                  ) : null}
                </article>
              </div>
            );
          })}
        </div>
      </div>

      <InlineThreadPlan />

      <div className="composer code-thread-workspace__composer thread-column">
        {/*
         * Side Chat has no surface in a Code tab, so the chip offers only
         * removal here: rendering a control whose sidecar this workspace
         * cannot open would mint a thread the user never sees.
         */}
        <ThreadMentionChips
          chips={threadMentions.chips}
          onRemove={(mentionedThreadId) => threadMentions.composer?.onRemoveChip(mentionedThreadId)}
        />
        {queued.length === 0 ? null : (
          <ul aria-label="Queued follow-ups" className="code-thread-workspace__queue">
            {queued.map((turn, index) => (
              <li className="code-thread-workspace__queue-chip" key={turn.id}>
                <span className="code-thread-workspace__queue-position">{index + 1}</span>
                <span className="code-thread-workspace__queue-prompt">{turn.prompt}</span>
                <OctantButton
                  aria-label={`Cancel queued follow-up ${String(index + 1)}`}
                  onClick={() => props.controller.cancelQueuedFollowUp(turn.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" size={14} strokeWidth={2} />
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
        {attachments.staged.length === 0 && attachments.message === undefined ? null : (
          <div className="code-thread-workspace__attachments" aria-label="Attached images">
            {attachments.staged.map(({ previewUrl, reference }) => (
              <span className="chip code-thread-workspace__attachment" key={reference.attachmentId}>
                <img
                  alt={reference.displayName}
                  className="code-thread-workspace__attachment-thumb"
                  src={previewUrl}
                />
                <span className="code-thread-workspace__attachment-name">
                  {reference.displayName}
                </span>
                <button
                  aria-label={`Remove ${reference.displayName}`}
                  className="chip-x window-no-drag"
                  onClick={() => attachments.remove(reference.attachmentId)}
                  type="button"
                >
                  ×
                </button>
              </span>
            ))}
            {attachments.message === undefined ? null : (
              <span className="code-thread-workspace__hint" role="status">
                {attachments.message}
              </span>
            )}
          </div>
        )}
        <label
          className="code-thread-workspace__message-field"
          htmlFor={`code-thread-composer-${String(thread.id)}`}
        >
          <span className="visually-hidden">Follow-up message</span>
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
              props.controller.setPendingDraft?.(event.currentTarget.value);
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onClick={(event) =>
              syncMentions(event.currentTarget.value, event.currentTarget.selectionStart)
            }
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
        </label>
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
        <div className="composer-row" aria-label="Thread context">
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
          <span className="composer-gap" />
          <OctantButton
            aria-label={busy ? "Queue follow-up" : "Send follow-up"}
            disabled={!canSend}
            onClick={() => void submitFollowUp()}
            size="icon"
            type="button"
            variant="default"
          >
            <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
          </OctantButton>
        </div>
        <div className="code-thread-workspace__status">
          <span className="code-thread-workspace__hint">
            {providerChanging
              ? "Checking the selected provider…"
              : busy
                ? "Waiting for the provider · Enter queues the next message"
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
      </div>
    </section>
  );
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

function headLabel(head: { readonly kind: string; readonly name?: string; readonly oid?: string }) {
  if (head.kind === "branch" && head.name !== undefined) return head.name;
  if (head.oid !== undefined) return head.oid.slice(0, 7);
  return "Checkout";
}

function lifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "active":
      return "Active";
    case "waiting":
      return "Waiting";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "done":
      return "Done";
    case "archived":
      return "Archived";
    default:
      return lifecycle;
  }
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
      <input
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
