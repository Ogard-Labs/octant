import {
  decodeWorkMutationRequestId,
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
import { ArrowUp, Check, Globe2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  applyComposerCaret,
  type ComposerThreadDraftStore,
} from "../composer/composerThreadDraftStore";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { HostId } from "@octant/contracts/host";
import { ThreadExportControl } from "../thread/ThreadExportControl";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = prompt.trim();
  const completionLocked = thread?.completionConfirmed === true;
  const canSubmit =
    trimmed.length > 0 &&
    !creating &&
    !completionLocked &&
    props.mutationClient !== undefined &&
    projectId !== undefined;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bootstrap = await props.threadClient.bootstrap();
        if (cancelled) return;
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
          if (!cancelled) setTurns(transcript.turns);
        }
        if (props.requestClient !== undefined) {
          const requests = await props.requestClient.list(thread.projectId, props.threadId);
          if (!cancelled) {
            setPendingRequests(requests.requests.filter((request) => request.status === "pending"));
          }
        }
      } catch {
        if (!cancelled) setErrorMessage("Work thread state could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraft.purge,
    props.requestClient,
    props.threadClient,
    props.threadId,
    props.turnClient,
  ]);

  useEffect(() => {
    if (props.turnClient === undefined) return;
    let cancelled = false;
    const timer = globalThis.setInterval(() => {
      void props.turnClient?.transcript(props.threadId).then((transcript) => {
        if (!cancelled) setTurns(transcript.turns);
      });
      if (props.requestClient !== undefined && projectId !== undefined) {
        void props.requestClient.list(projectId, props.threadId).then((requests) => {
          if (!cancelled) {
            setPendingRequests(requests.requests.filter((request) => request.status === "pending"));
          }
        });
      }
    }, 1_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
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

  const submit = useCallback(async () => {
    if (!canSubmit || props.mutationClient === undefined || projectId === undefined) {
      return;
    }
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
    composerDraft.clear,
    projectId,
    props.mutationClient,
    thread?.completionConfirmed,
    trimmed,
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

  const restoredCaret = composerDraft.caretIndex;
  const restoredLength = prompt.length;
  useLayoutEffect(() => {
    applyComposerCaret(textareaRef.current, restoredCaret, restoredLength);
    // Restore only when this thread's composer is shown, not on every keystroke.
  }, [props.threadId]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function rememberDraft(text: string, caretIndex: number | null) {
    if (caretIndex === null) composerDraft.setDraft(text);
    else composerDraft.setDraft(text, caretIndex);
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
            <button
              className="code-thread-workspace__tool window-no-drag"
              onClick={props.onOpenBrowser}
              type="button"
            >
              <Globe2 aria-hidden="true" size={14} strokeWidth={1.7} />
              <span>Browser</span>
            </button>
          )}
          <ThreadExportControl
            mode="work"
            threadId={String(props.threadId)}
            title={props.title}
            {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
            {...(props.windowCapability === undefined
              ? {}
              : { windowCapability: props.windowCapability })}
          />
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
          <div className="draft-thread__input-row">
            <OctantTextarea
              aria-label="Work prompt"
              autoFocus
              className="draft-thread__textarea"
              disabled={creating || completionLocked || props.mutationClient === undefined}
              onChange={(event) =>
                rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onClick={(event) =>
                rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onKeyDown={handleKeyDown}
              onKeyUp={(event) =>
                rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              placeholder="Describe the deliverable or paste a draft…"
              ref={textareaRef}
              rows={4}
              value={prompt}
            />
            <OctantButton
              aria-label="Create artifact"
              className="draft-thread__send"
              disabled={!canSubmit}
              onClick={() => void submit()}
              type="button"
              variant="default"
            >
              <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
            </OctantButton>
          </div>
          {errorMessage === undefined ? null : (
            <p className="draft-thread__error" role="alert">
              {errorMessage}
            </p>
          )}
          <p className="draft-thread__hint">
            {completionLocked
              ? "Reactivate this Work thread before creating another artifact or changing its provider."
              : "Press Enter to save a markdown artifact · Shift+Enter for a new line"}
          </p>
        </div>
      </div>
    </section>
  );
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
