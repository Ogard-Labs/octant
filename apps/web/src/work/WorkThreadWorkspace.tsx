import {
  decodeWorkAttachmentId,
  decodeWorkAttachmentMediaType,
  decodeWorkMutationRequestId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type WorkRequest,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnState,
} from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import type { PickerGroup } from "@octant/domain";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import { Check, Globe2, Paperclip } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  applyComposerCaret,
  type ComposerThreadDraftStore,
} from "../composer/composerThreadDraftStore";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import { useQueuedSend } from "../composer/useQueuedSend";
import type { TurnSettlement } from "../composer/queuedSend";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView } from "@octant/contracts";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import { ImageGenerationAction } from "../image/ImageGenerationAction";
import { GeneratedImageList } from "../image/GeneratedImageList";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
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
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";

export interface WorkThreadWorkspaceProps {
  readonly title: string;
  readonly threadId: WorkThreadId;
  readonly threadClient: WorkThreadClient;
  readonly turnClient?: WorkTurnClient;
  readonly requestClient?: WorkRequestClient;
  readonly mutationClient?: WorkMutationClient;
  readonly onOpenBrowser?: () => void;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly canvasClient?: CanvasClient;
  readonly imageGenerationClient?: ImageGenerationClient;
  readonly imageGenerationProfiles?: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenSettings?: () => void;
  readonly hostId?: HostId;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  readonly onThreadUpdated?: (thread: WorkThread) => void;
  /**
   * Compact live child-run chrome for this thread. Rendered in the thread
   * header so it stays visible with the rest of the thread chrome.
   */
  readonly childRunStatus?: ReactNode;
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

export function WorkThreadWorkspace(props: WorkThreadWorkspaceProps) {
  const composerDraft = useComposerThreadDraft({
    mode: "work",
    threadId: String(props.threadId),
    ...(props.draftStore === undefined ? {} : { store: props.draftStore }),
  });
  const prompt = composerDraft.text;
  const [projectId, setProjectId] = useState<ProjectId | undefined>(undefined);
  const [thread, setThread] = useState<WorkThread | undefined>(undefined);
  const [turns, setTurns] = useState<ReadonlyArray<WorkTurnState>>([]);
  const [pendingRequests, setPendingRequests] = useState<ReadonlyArray<WorkRequest>>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [providerChanging, setProviderChanging] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completionFormOpen, setCompletionFormOpen] = useState(false);
  const [completionEvidence, setCompletionEvidence] = useState("");
  const transcriptGeneration = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendQueuedRef = useRef<() => Promise<boolean>>(async () => false);
  const mentionListId = useId();
  const fileMentionListId = useId();
  const trimmed = prompt.trim();
  const completionLocked = thread?.completionConfirmed === true;
  const queued = useQueuedSend({
    threadKey: String(props.threadId),
    settlement: workTurnSettlement(turns),
    ready: !providerChanging && !creating && !completionLocked,
    send: () => sendQueuedRef.current(),
  });
  const turnRunning = workTurnSettlement(turns) === "running";
  const images = useWorkComposerImages();
  const imageSupport = selectedModelReadsImages(props.providerGroups ?? [], {
    ...(thread === undefined ? {} : { providerInstanceId: thread.providerInstanceId }),
    ...(thread === undefined ? {} : { modelId: thread.modelId }),
  });
  const threadMentions = useThreadMentions({
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
    !completionLocked &&
    projectId !== undefined &&
    (props.turnClient !== undefined || props.mutationClient !== undefined);

  useEffect(() => {
    if (completionLocked) queued.discard();
  }, [completionLocked, queued.discard]);

  useEffect(() => {
    const requestGeneration = ++transcriptGeneration.current;
    let cancelled = false;
    void (async () => {
      try {
        const bootstrap = await props.threadClient.bootstrap();
        if (cancelled || requestGeneration !== transcriptGeneration.current) return;
        const thread = bootstrap.threads.find((candidate) => candidate.id === props.threadId);
        if (thread === undefined) {
          composerDraft.purge(String(props.threadId));
          setErrorMessage("This Work thread is no longer available.");
          return;
        }
        setThread(thread);
        setProjectId(thread.projectId);
        if (props.turnClient !== undefined) {
          const transcript = await props.turnClient.transcript(props.threadId);
          if (!cancelled && requestGeneration === transcriptGeneration.current) {
            setTurns((current) =>
              samePollingData(current, transcript.turns) ? current : transcript.turns,
            );
          }
        }
        if (props.requestClient !== undefined) {
          const requests = await props.requestClient.list(thread.projectId, props.threadId);
          if (!cancelled && requestGeneration === transcriptGeneration.current) {
            const pending = requests.requests.filter((request) => request.status === "pending");
            setPendingRequests((current) =>
              samePollingData(current, pending) ? current : pending,
            );
          }
        }
      } catch {
        if (!cancelled) setErrorMessage("Work thread state could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
      transcriptGeneration.current += 1;
    };
  }, [
    composerDraft.purge,
    props.requestClient,
    props.threadClient,
    props.threadId,
    props.turnClient,
  ]);

  useEffect(() => {
    const turnClient = props.turnClient;
    const requestClient = props.requestClient;
    if (turnClient === undefined && requestClient === undefined) return;
    let cancelled = false;
    // A cycle that outlives the interval must finish before the next one
    // starts. Without this guard, a poll slower than the interval is always
    // superseded by the next tick's generation bump before its response
    // arrives, so a host that consistently takes longer than 1s to answer
    // would never see its transcript or pending requests update at all.
    let inFlight = false;
    const stop = scheduleVisibleInterval(() => {
      if (cancelled || inFlight || !documentIsVisible()) return;
      inFlight = true;
      const requestGeneration = ++transcriptGeneration.current;
      const transcript =
        turnClient === undefined
          ? Promise.resolve()
          : turnClient.transcript(props.threadId).then((next) => {
              if (cancelled || requestGeneration !== transcriptGeneration.current) return;
              setTurns((current) => (samePollingData(current, next.turns) ? current : next.turns));
            });
      const requests =
        requestClient === undefined || projectId === undefined
          ? Promise.resolve()
          : requestClient.list(projectId, props.threadId).then((next) => {
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
      stop();
    };
  }, [projectId, props.requestClient, props.threadId, props.turnClient]);

  const changeProvider = useCallback(
    async (selection: {
      readonly providerInstanceId: WorkThread["providerInstanceId"];
      readonly modelId: WorkThread["modelId"];
    }) => {
      if (
        thread === undefined ||
        thread.completionConfirmed === true ||
        providerChanging ||
        (selection.providerInstanceId === thread.providerInstanceId &&
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
        });
        if (!("kind" in result) || result.kind !== "thread-updated") {
          setErrorMessage("The selected Work provider could not be applied.");
          return;
        }
        setThread(result.thread);
        props.onThreadUpdated?.(result.thread);
        setStatus("Provider handoff ready for the next Work turn.");
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

  const sendWorkTurn = useCallback(async (): Promise<boolean> => {
    if (
      thread !== undefined &&
      thread.bindingRevisionId === undefined &&
      props.turnClient !== undefined
    ) {
      setErrorMessage(
        "This Work thread must be rebound before sending a follow-up. The Project folder is no longer authorized for this thread.",
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
    const promptText = composerDraft.text.trim();
    if (promptText.length === 0) return false;
    const sendingThreadId = String(thread.id);
    setCreating(true);
    setErrorMessage(undefined);
    setStatus(undefined);
    try {
      if (String(props.threadId) !== sendingThreadId) return false;
      const threadMentionIds = await threadMentions.resolveForSend();
      const staged = images.filesForSend();
      const attachmentIds = [];
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
      const started = await props.turnClient.startFirstTurn({
        kind: "start-work-thread-turn",
        requestId: decodeWorkTurnRequestId(globalThis.crypto.randomUUID()),
        threadId: props.threadId,
        turnId: decodeWorkTurnId(globalThis.crypto.randomUUID()),
        prompt: promptText,
        authority: {
          hostId: props.hostId ?? LOCAL_HOST_ID,
          projectId,
          bindingRevisionId: thread.bindingRevisionId,
          workingDirectory: thread.workingDirectory ?? ("." as never),
          confinementPosture: "project-root-confined",
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
        },
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        ...(threadMentionIds.length === 0 ? {} : { threadMentionIds }),
        ...(fileMentions.selectedPaths.length === 0
          ? {}
          : { fileMentionPaths: [...fileMentions.selectedPaths] }),
      });
      if (started.kind !== "accepted") {
        setErrorMessage("The Work turn could not be started.");
        return false;
      }
      images.clearAfterAccepted();
      composerDraft.clear();
      threadMentions.clear();
      fileMentions.clear();
      setTurns((current) => [...current, started.turn]);
      textareaRef.current?.focus();
      return true;
    } catch {
      setErrorMessage("The Work turn could not be started.");
      return false;
    } finally {
      setCreating(false);
    }
  }, [
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
  ]);
  sendQueuedRef.current = sendWorkTurn;

  const submit = useCallback(async () => {
    if (turnRunning) {
      queued.enqueue();
      return;
    }
    if (queued.state.status === "held") {
      const sent = await sendWorkTurn();
      if (sent) queued.discard();
      return;
    }
    if (!canSubmit || projectId === undefined) {
      return;
    }
    if (props.turnClient !== undefined) {
      const sent = await sendWorkTurn();
      if (sent) queued.discard();
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
    canSubmit,
    composerDraft,
    projectId,
    props.mutationClient,
    props.turnClient,
    queued,
    sendWorkTurn,
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
        setErrorMessage("The delivery target could not be marked complete.");
        return;
      }
      setThread(result.thread);
      props.onThreadUpdated?.(result.thread);
      setCompletionFormOpen(false);
      setCompletionEvidence("");
      setStatus("Delivery target marked complete.");
    } catch {
      setErrorMessage("The delivery target could not be marked complete. Try again.");
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
    mention.sync(value, caret);
    fileMentions.sync(value, caret);
  }

  return (
    <section aria-label="Work thread workspace" className="work-thread-workspace">
      <header className="work-thread-workspace__header">
        <div>
          <p className="work-thread-workspace__eyebrow">Work thread</p>
          <h1>{props.title}</h1>
          <p>Confined Project transcript</p>
        </div>
        {props.childRunStatus}
        <div aria-label="Work tools" className="work-thread-workspace__toolbar" role="toolbar">
          {props.onOpenBrowser === undefined ? null : (
            <OctantButton
              className="code-thread-workspace__tool window-no-drag"
              onClick={props.onOpenBrowser}
              type="button"
            >
              <Globe2 aria-hidden="true" size={14} strokeWidth={1.7} />
              <span>Browser</span>
            </OctantButton>
          )}
          {thread?.lifecycle === "active" && thread.completionConfirmed !== true ? (
            <OctantButton
              aria-label="Mark delivery target complete"
              disabled={completing || providerChanging || creating}
              onClick={() => setCompletionFormOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Check aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>{completing ? "Marking complete" : "Mark complete"}</span>
            </OctantButton>
          ) : null}
        </div>
      </header>

      {completionFormOpen && thread?.lifecycle === "active" && !completionLocked ? (
        <section
          aria-label="Confirm delivery target completion"
          className="work-thread-workspace__completion"
        >
          <p>
            Confirm satisfaction of: <strong>{thread.title}</strong>
          </p>
          <OctantTextarea
            aria-label="Delivery satisfaction evidence"
            disabled={completing}
            onChange={(event) => setCompletionEvidence(event.target.value)}
            placeholder="Describe the delivered result and how it satisfies the target…"
            rows={3}
            value={completionEvidence}
          />
          <OctantButton
            aria-label="Confirm delivery target completion"
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

      <div aria-live="polite" className="work-thread-workspace__conversation" role="log">
        <div className="work-thread-workspace__transcript">
          {turns.length === 0 ? (
            <article className="work-thread-workspace__message">
              <strong>Octant Work</strong>
              <p>
                Start from Project Overview quick start to run the first provider-backed turn in
                this confined Project. Approvals and user-input waits appear from the durable
                request projection.
              </p>
            </article>
          ) : (
            turns.flatMap((turn) =>
              turn.transcript.map((entry, index) => (
                <article
                  className="work-thread-workspace__message"
                  key={`${turn.requestId}-${entry.role}-${index}`}
                >
                  <strong>{entry.role === "user" ? "You" : "Assistant"}</strong>
                  <p>{entry.text === "" ? "Working…" : entry.text}</p>
                  {entry.status === undefined ? null : <p role="status">{entry.status}</p>}
                </article>
              )),
            )
          )}
          {pendingRequests.map((request) => (
            <article
              className="work-thread-workspace__message"
              key={String(request.requestId)}
              role="status"
            >
              <strong>
                {request.detail.kind === "approval" ? "Approval required" : "Input required"}
              </strong>
              <p>
                {request.detail.kind === "approval"
                  ? `${request.detail.action}: ${request.detail.description}`
                  : request.detail.prompt}
              </p>
            </article>
          ))}
          {status === undefined ? null : (
            <article className="work-thread-workspace__message" role="status">
              <strong>Saved locally</strong>
              <p>{status}</p>
            </article>
          )}
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
        </div>
      </div>

      <div className="work-thread-workspace__composer">
        {thread === undefined ? null : (
          <div className="work-thread-workspace__context" aria-label="Thread context">
            <span aria-label="Bound provider and model">
              {boundProviderModelLabel(props.providerGroups ?? [], thread)}
            </span>
            <ComposerModelPicker
              ariaLabel="Provider and model"
              disabled={providerChanging || creating || completionLocked}
              groups={props.providerGroups ?? []}
              onSelect={(selection) => void changeProvider(selection)}
              selectedModelId={thread.modelId}
              selectedProviderInstanceId={thread.providerInstanceId}
            />
          </div>
        )}
        <div className="work-thread-workspace__composer-shell">
          <ThreadComposer
            chips={
              <>
                <ThreadMentionChips
                  chips={threadMentions.chips}
                  onRemove={(mentionedThreadId) =>
                    threadMentions.composer?.onRemoveChip(mentionedThreadId)
                  }
                />
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
                autoFocus
                className="composer-input"
                disabled={
                  creating ||
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
                  if (creating || completionLocked) return;
                  if (attachFromTransfer(event.clipboardData)) event.preventDefault();
                }}
                placeholder={
                  turnRunning
                    ? "Queue the next message…"
                    : "Describe the deliverable or paste a draft…"
                }
                ref={textareaRef}
                rows={4}
                value={prompt}
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
            }
            row={{
              leading:
                props.turnClient === undefined ? null : (
                  <>
                    <label>
                      <span className="work-composer-adapter__visually-hidden">Add attachment</span>
                      {/* ui-boundary-exception: native-file-input */}
                      <input
                        aria-label="Choose attachment file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="work-composer-adapter__file-input"
                        disabled={creating || completionLocked || imageSupport === false}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.item(0);
                          if (file !== null && file !== undefined) {
                            if (imageSupport === false) {
                              images.refuse(
                                "The selected model does not accept images. Choose an image-capable model.",
                              );
                            } else {
                              images.attach([file]);
                            }
                          }
                          event.currentTarget.value = "";
                        }}
                        type="file"
                      />
                    </label>
                    <OctantButton
                      aria-label="Add attachment"
                      disabled={creating || completionLocked || imageSupport === false}
                      onClick={(event) => {
                        event.currentTarget.parentElement
                          ?.querySelector<HTMLInputElement>('input[type="file"]')
                          ?.click();
                      }}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Paperclip aria-hidden="true" size={16} strokeWidth={1.8} />
                    </OctantButton>
                    {props.imageGenerationProfiles === undefined ? null : (
                      <ImageGenerationAction
                        {...(props.imageGenerationClient === undefined
                          ? {}
                          : { client: props.imageGenerationClient })}
                        {...(props.onOpenSettings === undefined
                          ? {}
                          : { onOpenSettings: props.onOpenSettings })}
                        disabled={creating || completionLocked}
                        profiles={props.imageGenerationProfiles}
                        scopeId={decodeImageGenerationScopeId(String(props.threadId))}
                        threadKind="work-thread"
                      />
                    )}
                  </>
                ),
              actions: {
                kind: "send",
                send: {
                  ariaLabel: turnRunning
                    ? "Queue message"
                    : queued.state.status === "held"
                      ? "Send message"
                      : props.turnClient === undefined
                        ? "Create artifact"
                        : "Send follow-up",
                  disabled: !canSubmit,
                  onSend: () => void submit(),
                },
                ...(queued.state.status === "idle"
                  ? {}
                  : {
                      discard: {
                        ariaLabel: "Discard queued message",
                        onDiscard: () => {
                          queued.discard();
                          composerDraft.clear();
                          threadMentions.clear();
                          fileMentions.clear();
                          images.clearAfterAccepted();
                        },
                      },
                    }),
                sendHidden: queued.state.status === "queued",
              },
            }}
          />
          {errorMessage === undefined ? null : (
            <p className="draft-thread__error" role="alert">
              {errorMessage}
            </p>
          )}
          {queued.statusMessage === undefined ? null : (
            <p className="draft-thread__hint" role="status">
              {queued.statusMessage}
            </p>
          )}
          <p className="draft-thread__hint">
            {completionLocked
              ? "Reactivate this Work thread before creating another artifact or changing its provider."
              : turnRunning
                ? "Press Enter to queue the next message · Shift+Enter for a new line"
                : props.turnClient === undefined
                  ? "Press Enter to save a markdown artifact · Shift+Enter for a new line"
                  : "Press Enter to send · Shift+Enter for a new line · Type # to mention a thread, @ to mention a file"}
          </p>
        </div>
      </div>
    </section>
  );
}

function workTurnSettlement(turns: ReadonlyArray<WorkTurnState>): TurnSettlement | "idle" {
  const latest = turns.at(-1);
  if (latest === undefined) return "idle";
  switch (latest.status) {
    case "accepted":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function boundProviderModelLabel(
  groups: ReadonlyArray<PickerGroup>,
  thread: Pick<WorkThread, "providerInstanceId" | "modelId">,
): string {
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(thread.providerInstanceId),
  );
  const model = group?.sections
    .flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(thread.modelId));
  return `${group?.instance.displayName ?? String(thread.providerInstanceId)} — ${model?.model.displayName ?? String(thread.modelId)}`;
}
