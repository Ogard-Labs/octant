import type { CodeThreadId } from "@octant/contracts/code";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import type { PickerGroup } from "@octant/domain";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import { ArrowUp, Bot, GitCompare, Globe2, ListChecks, Terminal } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import type { CodeOverviewSurfaceKind } from "./CodeOverview";
import type { CodeController } from "./useCodeController";
import { AgentRunHierarchy } from "../agents/AgentRunHierarchy";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { HostId } from "@octant/contracts/host";
import type { ThreadMentionClient } from "@octant/client-runtime";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../chat/ThreadMentionPicker";
import { useThreadMentions } from "../chat/useThreadMentions";

export interface CodeThreadWorkspaceProps {
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly controller: CodeController;
  readonly onOpenBrowser?: () => void;
  readonly onOpenSurface?: (kind: CodeOverviewSurfaceKind) => void;
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
  const [draft, setDraft] = useState(props.controller.pendingDraft);
  const [providerChanging, setProviderChanging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [auxiliarySurface, setAuxiliarySurface] = useState<"agents">();

  useEffect(() => {
    setDraft(props.controller.pendingDraft);
  }, [props.controller.pendingDraft, props.threadId]);

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

  if (props.controller.status === "disconnected") {
    return (
      <ShellState
        action={{ label: "Retry Code", onClick: props.controller.retry }}
        eyebrow="Code workspace"
        message={props.controller.errorMessage ?? "The local Code service is unavailable."}
        role="alert"
        state="disconnected"
        title="Code is disconnected"
      />
    );
  }

  if (view === undefined) {
    const unavailable = props.controller.errorCategory;
    return (
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
    );
  }

  const { checkout, thread } = view;
  const trimmed = draft.trim();
  const busy =
    props.controller.turnStatus === "sending" || props.controller.turnStatus === "running";
  const canSend = trimmed.length > 0 && !busy;
  const providerGroups = props.providerGroups ?? [];
  const messages = props.controller.conversation;
  const showEmptyConversation = messages.length === 0;
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
    const sent = await props.controller.sendFollowUp(trimmed, threadMentionIds);
    if (sent) {
      setDraft("");
      threadMentions.clear();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.handleKeyDown(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitFollowUp();
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
        <div className="code-thread-workspace__identity">
          <h1>{thread.title}</h1>
          <div className="code-thread-workspace__meta">
            <span className="code-thread-workspace__lifecycle">
              {lifecycleLabel(thread.lifecycle)}
            </span>
            <span>{headLabel(checkout.head)}</span>
            <span>{policyLabel(thread.executionPolicy)}</span>
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
                type="button"
                variant="ghost"
              >
                Complete follow-up
              </OctantButton>
            ) : (
              <OctantButton
                onClick={() => void props.controller.markFollowUp(thread.id)}
                type="button"
                variant="ghost"
              >
                Mark for follow-up
              </OctantButton>
            )}
          </div>
        </div>
        {props.onOpenSurface === undefined &&
        props.onOpenBrowser === undefined &&
        props.agentRunClient === undefined ? null : (
          <div className="code-thread-workspace__toolbar" role="toolbar" aria-label="Code surfaces">
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
            {props.onOpenSurface === undefined ? null : (
              <>
                <button
                  className="code-thread-workspace__tool window-no-drag"
                  onClick={() => props.onOpenSurface?.("code-diff")}
                  type="button"
                >
                  <GitCompare aria-hidden="true" size={14} strokeWidth={1.7} />
                  <span>Changes</span>
                </button>
                <button
                  className="code-thread-workspace__tool window-no-drag"
                  onClick={() => props.onOpenSurface?.("code-terminal")}
                  type="button"
                >
                  <Terminal aria-hidden="true" size={14} strokeWidth={1.7} />
                  <span>Terminal</span>
                </button>
                <button
                  className="code-thread-workspace__tool window-no-drag"
                  onClick={() => props.onOpenSurface?.("code-test")}
                  type="button"
                >
                  <ListChecks aria-hidden="true" size={14} strokeWidth={1.7} />
                  <span>Tests</span>
                </button>
              </>
            )}
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
        )}
      </header>

      {props.controller.errorMessage === undefined ? null : (
        <p className="code-thread-workspace__error" role="alert">
          {props.controller.errorMessage}
        </p>
      )}

      {props.controller.turnError === undefined ? null : (
        <p className="code-thread-workspace__error" role="alert">
          {props.controller.turnError}
        </p>
      )}

      {thread.lifecycle === "waiting" || thread.lifecycle === "interrupted" ? (
        <p className="code-thread-workspace__banner" role="alert">
          {thread.lifecycle === "waiting"
            ? "This thread is waiting for authoritative recovery or user input."
            : "This thread was interrupted and requires an explicit retry."}
        </p>
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
        <aside aria-label="Agent activity" className="code-thread-workspace__auxiliary">
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
        <div className="code-thread-workspace__transcript">
          {showEmptyConversation ? (
            <p className="code-thread-workspace__empty" role="status">
              No messages yet. Send a prompt to start this thread.
            </p>
          ) : null}
          {messages.map((message, index) => {
            const previousAssistant = previousAssistantMessage(messages, index);
            const handoff =
              message.role === "assistant" &&
              previousAssistant !== undefined &&
              providerIdentityChanged(previousAssistant, message);
            return (
              <div key={message.id}>
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
                  <p>{message.text.length > 0 ? message.text : busy ? "Thinking…" : ""}</p>
                </article>
              </div>
            );
          })}
        </div>
      </div>

      <div className="code-thread-workspace__composer">
        <div className="code-thread-workspace__composer-shell">
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
          {/*
           * Side Chat has no surface in a Code tab, so the chip offers only
           * removal here: rendering a control whose sidecar this workspace
           * cannot open would mint a thread the user never sees.
           */}
          <ThreadMentionChips
            chips={threadMentions.chips}
            disabled={busy}
            onRemove={(mentionedThreadId) =>
              threadMentions.composer?.onRemoveChip(mentionedThreadId)
            }
          />
          <div className="code-thread-workspace__input-row">
            <label
              className="visually-hidden"
              htmlFor={`code-thread-composer-${String(thread.id)}`}
            >
              Follow-up message
            </label>
            <OctantTextarea
              aria-activedescendant={
                mention.activeCandidate === undefined
                  ? undefined
                  : `${mentionListId}-${String(mention.activeCandidate.threadId)}`
              }
              aria-autocomplete={threadMentions.composer === undefined ? undefined : "list"}
              aria-controls={mention.open ? mentionListId : undefined}
              aria-expanded={threadMentions.composer === undefined ? undefined : mention.open}
              className="code-thread-workspace__input window-no-drag"
              disabled={busy}
              id={`code-thread-composer-${String(thread.id)}`}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                props.controller.setPendingDraft?.(event.currentTarget.value);
                mention.sync(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              onClick={(event) =>
                mention.sync(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onKeyDown={onKeyDown}
              onKeyUp={(event) => {
                if (event.key === "Escape") return;
                mention.sync(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              placeholder="Ask for follow-up changes…"
              ref={textareaRef}
              rows={2}
              value={draft}
            />
            <OctantButton
              aria-label="Send follow-up"
              className="code-thread-workspace__send window-no-drag"
              disabled={!canSend}
              onClick={() => void submitFollowUp()}
              size="icon"
              type="button"
              variant="default"
            >
              <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
            </OctantButton>
          </div>
          <div className="code-thread-workspace__composer-bar" aria-label="Thread context">
            <ComposerModelPicker
              ariaLabel="Provider and model"
              disabled={busy || providerChanging}
              groups={providerGroups}
              onSelect={(selection) => void changeProvider(selection)}
              selectedModelId={thread.modelId}
              selectedProviderInstanceId={thread.providerInstanceId}
            />
            <span className="code-thread-workspace__hint">
              {providerChanging
                ? "Checking the selected provider…"
                : busy
                  ? "Waiting for the provider…"
                  : "Enter to send · Shift+Enter for a new line"}
            </span>
          </div>
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

function policyLabel(policy: string): string {
  switch (policy) {
    case "plan":
      return "Plan · read-only";
    case "full-access":
      return "Full access";
    default:
      return "Approval gated";
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
      className="code-thread-workspace__banner code-thread-workspace__provider-request"
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
      className="code-thread-workspace__banner code-thread-workspace__provider-request"
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
