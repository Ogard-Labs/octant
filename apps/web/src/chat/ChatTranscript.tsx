import type {
  ChatAttempt,
  ChatAttemptOutcome,
  ChatContentBody,
  ChatContentReference,
  ChatThreadView,
  ChatTurnId,
  ChatTurnRouteDecision,
  ChatAttemptId,
} from "@octant/contracts/chat";
import type { ThreadCheckpoint } from "@octant/contracts/thread-checkpoints";
import { activeChatTurns } from "@octant/domain/chat-policy";
import {
  Ban,
  Check,
  Circle,
  CircleAlert,
  CircleX,
  Clock3,
  GitBranch,
  LoaderCircle,
  Pencil,
} from "lucide-react";
import { useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { ThreadCheckpointControls } from "../checkpoints/ThreadCheckpointControls";
import { TranscriptWindow } from "../transcript/TranscriptWindow";
import { ChatRichText } from "./ChatRichText";
import { ChatTurnEditor } from "./ChatTurnEditor";

export interface ChatTranscriptProps {
  /** The decoded, authoritative transcript projection. */
  readonly view: ChatThreadView;
  /** Connection state is separate from a durable attempt outcome. */
  readonly connectionStatus?: "connected" | "disconnected";
  /** Retries are intentionally available only for failed and interrupted attempts. */
  readonly onRetryAttempt?: (turnId: ChatTurnId, attemptId: ChatAttemptId) => void;
  /** Sends the revised message to the server, which decides whether to accept it. */
  readonly onEditTurn?: (turnId: ChatTurnId, prompt: string) => void;
  /** Starts a second thread carrying the conversation through this turn. */
  readonly onBranchTurn?: (turnId: ChatTurnId) => void;
  /** True while a turn is running, so revising and branching stay unavailable. */
  readonly busy?: boolean;
  /**
   * The points this conversation is marked at, and the gestures that change
   * them. Absent on a host that serves no checkpoint surface, which keeps the
   * affordance off the transcript rather than offering a marker nothing would
   * record.
   */
  readonly checkpoints?: ChatTranscriptCheckpoints;
  /** Scrolls this turn into the window. Used by jump-to-message. */
  readonly revealTurnId?: ChatTurnId;
}

export interface ChatTranscriptCheckpoints {
  /** Keyed by the turn each marked checkpoint sits on. */
  readonly byTurnId: ReadonlyMap<string, ThreadCheckpoint>;
  readonly busy: boolean;
  readonly message?: string;
  readonly onMark: (turnId: ChatTurnId, label: string) => void;
  readonly onForget: (checkpoint: ThreadCheckpoint) => void;
  readonly onRestore: (checkpoint: ThreadCheckpoint, title: string) => void;
}

const attemptLabels: Record<ChatAttemptOutcome, string> = {
  queued: "Queued",
  streaming: "Streaming",
  waiting: "Waiting",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Completed",
};

export function ChatTranscript(props: ChatTranscriptProps) {
  const [editingTurnId, setEditingTurnId] = useState<string | undefined>(undefined);
  // Revising a message appends a new turn rather than rewriting history, so the
  // transcript shows the conversation as it now stands and the superseded turns
  // stay in the journal behind it.
  const turns = useMemo(() => activeChatTurns(props.view.turns), [props.view.turns]);
  const revisedTurnCount = props.view.turns.length - turns.length;
  const contentById = useMemo(
    () => new Map(props.view.contents.map((content) => [String(content.contentId), content])),
    [props.view.contents],
  );
  const attachmentById = useMemo(
    () => new Map(props.view.attachments.map((attachment) => [String(attachment.id), attachment])),
    [props.view.attachments],
  );
  const citationsByAttempt = useMemo(
    () => groupCitationsByAttempt(props.view.citations),
    [props.view.citations],
  );
  const routeDecisionByTurn = useMemo(
    () =>
      new Map(
        (props.view.routeDecisions ?? []).map((decision) => [String(decision.turnId), decision]),
      ),
    [props.view.routeDecisions],
  );
  // A Waiting decision is durable even though its turn was never accepted, so
  // it must stay visible without a matching transcript turn.
  // Route receipts for superseded turns are not orphans: their turn still
  // exists in the thread's history, it is simply no longer displayed.
  const turnIds = new Set(props.view.turns.map((turn) => String(turn.id)));
  const orphanedRouteDecisions = (props.view.routeDecisions ?? []).filter(
    (decision) => !turnIds.has(String(decision.turnId)),
  );

  const lead = (
    <>
      {props.connectionStatus === "disconnected" ? (
        <p aria-live="polite" className="chat-transcript__connection" role="status">
          Disconnected — reconnecting to the authoritative transcript.
        </p>
      ) : null}
      {props.view.thread.handoffWarning === undefined ? null : (
        <p
          aria-label="Historical attachment warning"
          aria-live="polite"
          className="chat-transcript__handoff-warning"
          role="status"
        >
          {handoffWarningText(props.view.thread.handoffWarning)}
        </p>
      )}
      {props.view.thread.branchedFrom === undefined ? null : (
        <p className="chat-transcript__provenance" role="status">
          {branchOriginText(props.view.thread.branchedFrom)}
        </p>
      )}
      {props.checkpoints?.message === undefined ? null : (
        <p className="chat-transcript__provenance" role="status">
          {props.checkpoints.message}
        </p>
      )}
      {revisedTurnCount === 0 ? null : (
        <p className="chat-transcript__provenance" role="status">
          {revisedTurnCount === 1
            ? "1 earlier message was revised. This is the conversation as it now stands; the earlier version stays in this thread's history."
            : `${revisedTurnCount} earlier messages were revised. This is the conversation as it now stands; the earlier versions stay in this thread's history.`}
        </p>
      )}
    </>
  );

  if (turns.length === 0) {
    return (
      <section aria-label="Conversation" className="chat-transcript thread-column">
        {lead}
        <div className="chat-transcript__empty" role="status">
          <h2>Start the conversation</h2>
          <p>Ask a question, draft something, or explore an idea.</p>
        </div>
        {orphanedRouteDecisions.map((decision) => (
          <RouteReceipt decision={decision} key={String(decision.turnId)} />
        ))}
      </section>
    );
  }

  return (
    <TranscriptWindow
      ariaLabel="Conversation"
      className="chat-transcript thread-column"
      estimateSize={160}
      gap={36}
      itemKey={(turn) => String(turn.id)}
      items={turns}
      itemTag="li"
      key={String(props.view.thread.id)}
      lead={lead}
      listClassName="chat-transcript__turns"
      listLabel="Chat transcript"
      listTag="ol"
      {...(editingTurnId === undefined ? {} : { pinnedKeys: [editingTurnId] })}
      renderItem={(turn) => {
        const userContent = resolvedContent(contentById, turn.userMessageRef, "user");
        const attachments = turn.attachmentIds.map((id) => attachmentById.get(String(id)));
        const editing = editingTurnId === String(turn.id);
        const checkpoints = props.checkpoints;
        const marked = checkpoints?.byTurnId.get(String(turn.id));
        const routeDecision = routeDecisionByTurn.get(String(turn.id));
        const attachmentList =
          attachments.length > 0 ? (
            <ul aria-label="Attachments" className="chat-transcript__attachments">
              {attachments.map((attachment, index) => (
                <li key={attachment?.id ?? `${turn.id}-${index}`}>
                  {attachment === undefined ? "Attachment is unavailable." : attachment.displayName}
                </li>
              ))}
            </ul>
          ) : null;

        return (
          <div className="chat-transcript__turn">
            <article aria-label="Your message" className="turn-user">
              {editing && userContent !== undefined && props.onEditTurn !== undefined ? (
                <>
                  <ChatTurnEditor
                    busy={props.busy === true}
                    initialPrompt={userContent.body}
                    onCancel={() => setEditingTurnId(undefined)}
                    onSubmit={(turnId, prompt) => {
                      setEditingTurnId(undefined);
                      props.onEditTurn?.(turnId, prompt);
                    }}
                    turnId={turn.id}
                  />
                  {attachmentList}
                </>
              ) : (
                <div className="bubble">
                  <MessageBody content={userContent} missing="Message content is unavailable." />
                  {attachmentList}
                </div>
              )}
              {editing || checkpoints === undefined ? null : (
                <ThreadCheckpointControls
                  busy={props.busy === true || checkpoints.busy}
                  {...(marked === undefined ? {} : { checkpoint: marked })}
                  defaultLabel={`Message ${String(turn.sequence)}`}
                  onForget={() => {
                    if (marked !== undefined) checkpoints.onForget(marked);
                  }}
                  onMark={(label) => checkpoints.onMark(turn.id, label)}
                  onRestore={(title) => {
                    if (marked !== undefined) checkpoints.onRestore(marked, title);
                  }}
                />
              )}
              {editing ? null : (
                <TurnActions
                  busy={props.busy === true}
                  canEdit={userContent !== undefined && props.onEditTurn !== undefined}
                  {...(props.onBranchTurn === undefined
                    ? {}
                    : { onBranch: () => props.onBranchTurn?.(turn.id) })}
                  onEdit={() => setEditingTurnId(String(turn.id))}
                />
              )}
            </article>
            {routeDecision === undefined ? null : <RouteReceipt decision={routeDecision} />}
            {turn.attempts.map((attempt, index) => (
              <AttemptBlock
                attempt={attempt}
                contentById={contentById}
                key={attempt.id}
                onRetryAttempt={props.onRetryAttempt}
                previousAttempt={turn.attempts[index - 1]}
                citations={citationsByAttempt.get(String(attempt.id)) ?? []}
              />
            ))}
          </div>
        );
      }}
      restoreKey={String(props.view.thread.id)}
      {...(props.revealTurnId === undefined ? {} : { revealKey: String(props.revealTurnId) })}
      role="region"
      trail={orphanedRouteDecisions.map((decision) => (
        <RouteReceipt decision={decision} key={String(decision.turnId)} />
      ))}
    />
  );
}

/**
 * Per-message actions. Both are proposals: the renderer never decides that an
 * edit or a branch is allowed, it asks the server, which re-checks the thread's
 * version, lifecycle, and Project scope before anything happens.
 */
function TurnActions(props: {
  readonly busy: boolean;
  readonly canEdit: boolean;
  readonly onBranch?: () => void;
  readonly onEdit: () => void;
}) {
  if (!props.canEdit && props.onBranch === undefined) return null;
  return (
    <div aria-label="Message actions" className="chat-transcript__turn-actions" role="group">
      {props.canEdit ? (
        <OctantButton
          disabled={props.busy}
          onClick={props.onEdit}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Pencil aria-hidden="true" size={12} strokeWidth={1.8} />
          Edit
        </OctantButton>
      ) : null}
      {props.onBranch === undefined ? null : (
        <OctantButton
          disabled={props.busy}
          onClick={props.onBranch}
          size="sm"
          type="button"
          variant="ghost"
        >
          <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
          Branch from here
        </OctantButton>
      )}
    </div>
  );
}

function branchOriginText(origin: NonNullable<ChatThreadView["thread"]["branchedFrom"]>): string {
  const carried = `${origin.carriedTurnCount} ${origin.carriedTurnCount === 1 ? "message" : "messages"}`;
  const attachments =
    origin.omittedAttachmentCount === 0
      ? ""
      : ` ${origin.omittedAttachmentCount} ${origin.omittedAttachmentCount === 1 ? "attachment stayed" : "attachments stayed"} with the original thread.`;
  return `Branched from another conversation, carrying ${carried} of it.${attachments}`;
}

/**
 * Renders the server-authored multi-model route decision verbatim: the
 * selected route (or the requested one for a Waiting decision) and the
 * policy's concise reason. Never invents a route the server did not record.
 */
function RouteReceipt(props: { readonly decision: ChatTurnRouteDecision }) {
  const decision = props.decision.decision;
  const requested = decision.request.requestedCandidate ?? decision.request.pool.candidates[0]!;
  const label =
    decision.kind === "selected"
      ? decision.selectionKind === "fallback"
        ? `${requested.modelId} → ${decision.selectedCandidate.modelId} · pool fallback`
        : `${decision.selectedCandidate.modelId} · pool`
      : `${requested.modelId} · pool waiting`;
  const reason = decision.kind === "selected" ? decision.reason : decision.message;
  return (
    <p aria-label="Turn route receipt" className="chat-transcript__route-receipt" role="status">
      <span>Route: {label}</span>
      <span className="chat-transcript__route-reason">{reason}</span>
    </p>
  );
}

function AttemptBlock(props: {
  readonly attempt: ChatAttempt;
  readonly citations: ChatThreadView["citations"];
  readonly contentById: ReadonlyMap<string, ChatContentBody>;
  readonly onRetryAttempt: ChatTranscriptProps["onRetryAttempt"];
  readonly previousAttempt: ChatAttempt | undefined;
}) {
  const handoff = handoffLabel(props.previousAttempt, props.attempt);
  const responseContents = props.attempt.responseRefs.map((reference) =>
    resolvedContent(props.contentById, reference, "assistant"),
  );
  const responseBody =
    responseContents.length === 0 || responseContents.some((content) => content === undefined)
      ? undefined
      : responseContents.map((content) => content!.body).join("");
  const canRetry = props.attempt.outcome === "failed" || props.attempt.outcome === "interrupted";

  return (
    <>
      {handoff === undefined ? null : (
        <div aria-label={handoff} className="chat-transcript__handoff" role="separator">
          {handoff}
        </div>
      )}
      <article
        aria-label={`Assistant response · ${attemptLabels[props.attempt.outcome]}`}
        className="turn-agent"
      >
        {props.attempt.responseRefs.length === 0 ? null : responseBody === undefined ? (
          <p role="alert">Response content is unavailable.</p>
        ) : (
          <ChatRichText body={responseBody} />
        )}
        <AttemptStatus outcome={props.attempt.outcome} />
        {props.attempt.outcome === "failed" ? (
          <SupportCorrelationControl correlationId={String(props.attempt.id)} />
        ) : null}
        {props.citations.length > 0 ? <CitationList citations={props.citations} /> : null}
        {canRetry && props.onRetryAttempt !== undefined ? (
          <OctantButton
            onClick={() => props.onRetryAttempt?.(props.attempt.turnId, props.attempt.id)}
            type="button"
            variant="secondary"
          >
            Retry {attemptLabels[props.attempt.outcome].toLowerCase()} response
          </OctantButton>
        ) : null}
      </article>
    </>
  );
}

/**
 * The server persists a diagnostics incident with this exact operation id.
 * Keeping the copy action at the failure site avoids asking a local user to
 * discover a hidden journal correlation before they can use Settings support.
 */
function SupportCorrelationControl({ correlationId }: { readonly correlationId: string }) {
  return (
    <div aria-label="Support correlation" className="chat-transcript__support-correlation">
      <p>
        Support correlation ID: <code>{correlationId}</code>
      </p>
      <OctantButton
        onClick={() => {
          void navigator.clipboard?.writeText(correlationId);
        }}
        type="button"
        variant="secondary"
      >
        Copy support ID
      </OctantButton>
    </div>
  );
}

function MessageBody(props: {
  readonly content: ChatContentBody | undefined;
  readonly missing: string;
}) {
  if (props.content === undefined) {
    return <p role="alert">{props.missing}</p>;
  }
  return <p>{props.content.body}</p>;
}

function AttemptStatus(props: { readonly outcome: ChatAttemptOutcome }) {
  const StatusIcon = attemptStatusIcon(props.outcome);
  return (
    <p
      aria-live={props.outcome === "streaming" ? "polite" : undefined}
      className={`runstatus chat-transcript__attempt-status--${props.outcome}`}
    >
      <StatusIcon aria-hidden="true" size={12} strokeWidth={1.8} />
      <span>{attemptLabels[props.outcome]}</span>
      <span className="sr-only"> attempt state</span>
    </p>
  );
}

function CitationList(props: { readonly citations: ChatThreadView["citations"] }) {
  return (
    <ul aria-label="Sources" className="chat-transcript__citations">
      {props.citations.map((citation) => {
        const backend = citation.backend === "searxng" ? "SearXNG" : "Provider-native";
        const label = `${citation.sourceTitle} · ${backend}`;
        const sourceUrl = safeCitationUrl(citation.sourceUrl);
        return (
          <li key={citation.citationId}>
            {sourceUrl === undefined ? (
              <span>{`${citation.sourceTitle} · ${backend} source unavailable`}</span>
            ) : (
              <a href={sourceUrl} rel="noreferrer" target="_blank">
                {label}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function resolvedContent(
  contentById: ReadonlyMap<string, ChatContentBody>,
  reference: ChatContentReference,
  expectedRole: ChatContentBody["role"],
): ChatContentBody | undefined {
  const content = contentById.get(String(reference.contentId));
  return content?.role === expectedRole && content.digest === reference.digest
    ? content
    : undefined;
}

function handoffLabel(previous: ChatAttempt | undefined, current: ChatAttempt): string | undefined {
  if (
    previous === undefined ||
    (previous.providerInstanceId === current.providerInstanceId &&
      previous.modelId === current.modelId)
  ) {
    return undefined;
  }
  return previous.modelId === current.modelId
    ? "Provider handoff · provider changed"
    : `Provider handoff · ${current.modelId}`;
}

function handoffWarningText(
  warning: NonNullable<ChatThreadView["thread"]["handoffWarning"]>,
): string {
  const names = warning.omittedAttachments.map((attachment) => attachment.displayName).join(", ");
  return `${names} ${warning.omittedAttachments.length === 1 ? "remains" : "remain"} available locally and ${warning.omittedAttachments.length === 1 ? "was" : "were"} not sent to ${warning.targetModelId}.`;
}

function attemptStatusIcon(outcome: ChatAttemptOutcome) {
  switch (outcome) {
    case "queued":
      return Circle;
    case "streaming":
      return LoaderCircle;
    case "waiting":
      return Clock3;
    case "interrupted":
      return CircleAlert;
    case "failed":
      return CircleX;
    case "cancelled":
      return Ban;
    case "completed":
      return Check;
  }
}

function safeCitationUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function groupCitationsByAttempt(citations: ChatThreadView["citations"]) {
  const grouped = new Map<string, Array<ChatThreadView["citations"][number]>>();
  for (const citation of citations) {
    const key = String(citation.attemptId);
    grouped.set(key, [...(grouped.get(key) ?? []), citation]);
  }
  return grouped;
}
