import { decodeAgentRunId, type AgentRunParentThreadId } from "@octant/contracts";
import {
  AgentRunClientFailure,
  type AgentRunClient,
  type AgentRunParentSummaryResponse,
} from "@octant/client-runtime/agent-run-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ComposerInput } from "../composer/ComposerInput";
import { ThreadComposer, type ThreadComposerActions } from "../composer/ThreadComposer";
import { relativeTimeLabel } from "../lib/relativeTime";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { AssistantMessageBody } from "../transcript/AssistantMessageBody";
import { TurnActivityRows } from "../transcript/TurnActivityRows";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import type { AgentResultReviewRequest } from "../gitHistory/SavedAgentReview";
import { AgentRunResults } from "./AgentRunResults";
import { buildAgentHierarchyModel, isActiveAgentHierarchyStatus } from "./buildAgentHierarchyModel";
import { SubagentStatusIcon, subagentRoleWord, subagentStatusWord } from "./subagentStatus";
import { subagentTranscript } from "./subagentTranscript";
import { useAgentRunControlCommands } from "./useAgentRunControlCommands";
import { useAgentRunConversation } from "./useAgentRunConversation";
import "./subagent-thread.css";

const ACTIVE_REFRESH_MS = 2_000;
const IDLE_REFRESH_MS = 30_000;
/** The longest message a run's steer, follow-up or resume command carries. */
const MAX_MESSAGE_CHARACTERS = 4_096;

/**
 * A subagent opened as a thread of its own. It reads like any thread: what it
 * was asked first, then its replies and the tool steps it took, live while it
 * runs, and the composer under them. The header names the thread that started
 * it and leads back there.
 *
 * Typing reaches the subagent through the commands its Agents page already
 * uses, under the same authority: while it runs a message steers it; once it
 * finished, or stopped where it can resume, the message continues it. A
 * subagent the provider runs itself can be read but not steered, and the
 * composer gives way to a line that says so.
 */
export function SubagentThread(props: {
  readonly client: AgentRunClient;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly runId: string;
  /** The tab's own title, shown until the run is read. */
  readonly title: string;
  /** The parent thread's title, for the header's link back. */
  readonly parentTitle?: string | undefined;
  readonly onOpenParent?: (() => void) | undefined;
  /** Opens a result's captured comparison in Review (Code). */
  readonly onReviewChanges?: ((request: AgentResultReviewRequest) => void) | undefined;
}) {
  const [read, setRead] = useState<AgentRunParentSummaryResponse>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const issuedRead = useRef(0);
  const shownRead = useRef(0);

  const readSummary = useCallback(async () => {
    const mine = ++issuedRead.current;
    try {
      const summary = await props.client.parentSummary(props.parentThreadId);
      if (mine < shownRead.current) return;
      shownRead.current = mine;
      setRead(summary);
      setStatus("ready");
    } catch (error) {
      if (mine < shownRead.current) return;
      setErrorMessage(
        error instanceof AgentRunClientFailure
          ? error.message
          : "This subagent is unavailable. Reconnect and try again.",
      );
      setStatus((current) => (current === "ready" ? current : "error"));
    }
  }, [props.client, props.parentThreadId]);

  useEffect(() => {
    void readSummary();
    return () => {
      shownRead.current = ++issuedRead.current;
    };
  }, [readSummary]);

  const entries = useMemo(
    () => (read?.parentThreadId === props.parentThreadId ? read.entries : []),
    [read, props.parentThreadId],
  );
  const row = useMemo(() => {
    const model = buildAgentHierarchyModel({ entries });
    return [...model.working, ...model.finished].find(
      (candidate) => candidate.runId === props.runId,
    );
  }, [entries, props.runId]);
  const active = row !== undefined && isActiveAgentHierarchyStatus(row.lifecycleStatus);

  useEffect(
    () =>
      scheduleVisibleInterval(
        () => void readSummary(),
        active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS,
      ),
    [active, readSummary],
  );

  const conversationRunId = useMemo(
    () => (row === undefined ? undefined : decodeAgentRunId(row.runId)),
    [row?.runId],
  );
  // A resumed, continued or retried run works again under the same id; each
  // time it does, its conversation is read again so the new attempt shows.
  const [attempt, setAttempt] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setAttempt((current) => current + 1);
    wasActive.current = active;
  }, [active]);
  const conversation = useAgentRunConversation(props.client, conversationRunId, String(attempt));
  const items = useMemo(
    () => subagentTranscript(conversation.conversation?.entries ?? []),
    [conversation.conversation],
  );
  const controls = useAgentRunControlCommands(props.client, readSummary);

  const lineage = (
    <p className="subagent-thread__lineage">
      <span>Subagent of</span>
      {props.onOpenParent === undefined ? (
        <span className="subagent-thread__parent">{props.parentTitle ?? "its thread"}</span>
      ) : (
        <OctantButton
          className="subagent-thread__parent-link"
          onClick={props.onOpenParent}
          size="xs"
          type="button"
          variant="ghost"
        >
          {props.parentTitle ?? "Open its thread"}
        </OctantButton>
      )}
    </p>
  );

  if (status === "loading") {
    return <OctantEmpty state="loading" title="Loading subagent" />;
  }
  if (row === undefined) {
    return (
      <section aria-label="Subagent" className="subagent-thread">
        <header className="subagent-thread__header thread-column">{lineage}</header>
        <OctantEmpty
          eyebrow="Subagent"
          message={
            status === "error"
              ? (errorMessage ?? "This subagent could not be read.")
              : "This subagent is no longer listed for its thread, or this window cannot read it."
          }
          state="warning"
          title={`${props.title} is unavailable`}
        />
      </section>
    );
  }

  const lifecycle = row.lifecycleStatus;
  const managed = row.executionKind === "octant-managed";
  const canSteer = managed && (lifecycle === "running" || lifecycle === "waiting");
  const canResume =
    managed &&
    (lifecycle === "completed" ||
      (lifecycle === "interrupted" &&
        row.recoveryReason !== "restart-without-resumable-execution"));
  const canRetry = managed && (lifecycle === "failed" || lifecycle === "interrupted") && !canResume;
  const command = { runId: row.runId, version: row.version };
  const message = draft.trim();
  const facts = [subagentRoleWord(row.role), row.model, relativeTimeLabel(row.updatedAt)].filter(
    (part): part is string => part !== undefined,
  );

  const send = async () => {
    if (sending || message.length === 0 || message.length > MAX_MESSAGE_CHARACTERS) return;
    setSending(true);
    setErrorMessage(undefined);
    setNotice(canSteer ? "Sending your note. The subagent reads it at its next step." : undefined);
    const refusal = canSteer
      ? await controls.steer({ ...command, message })
      : await controls.resume({ ...command, message });
    setSending(false);
    if (refusal !== undefined) {
      setErrorMessage(refusal);
      setNotice(undefined);
      return;
    }
    setDraft("");
    setNotice(canSteer ? "Steering note delivered." : undefined);
  };

  const disabledReason =
    canSteer || canResume ? undefined : "This subagent cannot take a message now.";
  // A command carries at most this much; the draft stays so it can be shortened.
  const tooLong =
    message.length > MAX_MESSAGE_CHARACTERS
      ? `This message is ${String(message.length - MAX_MESSAGE_CHARACTERS)} characters over the ${String(MAX_MESSAGE_CHARACTERS)} a subagent takes. Shorten it to send.`
      : undefined;
  const actions: ThreadComposerActions = canSteer
    ? {
        kind: "send-or-stop",
        cellClassName: "subagent-thread__actions",
        sending: true,
        send: {
          ariaLabel: "Send steering note",
          disabled: sending || message.length === 0 || tooLong !== undefined,
          disabledReason: tooLong,
          onSend: () => void send(),
        },
        stop: {
          ariaLabel: "Stop this subagent",
          onStop: () => {
            void controls.cancel({ runId: row.runId }).then((refusal) => {
              if (refusal !== undefined) setErrorMessage(refusal);
            });
          },
        },
      }
    : {
        kind: "send",
        send: {
          ariaLabel: canResume ? "Continue this subagent" : "Send",
          disabled:
            sending ||
            message.length === 0 ||
            disabledReason !== undefined ||
            tooLong !== undefined,
          disabledReason: disabledReason ?? tooLong,
          onSend: () => void send(),
        },
      };

  return (
    <section aria-label="Subagent" className="subagent-thread">
      <header className="subagent-thread__header thread-column">
        {lineage}
        <h1 className="subagent-thread__title">{row.task}</h1>
        <p className="subagent-thread__status">
          <SubagentStatusIcon lifecycleStatus={lifecycle} />
          <span className="subagent-thread__state">{subagentStatusWord(lifecycle)}</span>
          {facts.length === 0 ? null : <span>· {facts.join(" · ")}</span>}
        </p>
      </header>
      <div
        aria-busy={conversation.loading}
        aria-label="Subagent conversation"
        className="subagent-thread__transcript transcript-scroll"
        role="log"
      >
        <ol className="subagent-thread__turns thread-column">
          <li>
            <article aria-label="The brief it was given" className="turn-user">
              <div className="bubble">
                <p>{row.task}</p>
              </div>
            </article>
          </li>
          {items.map((item, index) => (
            <li key={item.key}>
              {item.kind === "message" ? (
                <article aria-label={item.label} className="turn-user">
                  <div className="bubble">
                    <p>{item.text}</p>
                  </div>
                </article>
              ) : item.kind === "reply" ? (
                <article aria-label="Subagent reply" className="turn-agent">
                  <AssistantMessageBody
                    body={item.text}
                    streaming={active && index === items.length - 1}
                  />
                </article>
              ) : item.kind === "activity" ? (
                <TurnActivityRows
                  activity={{ rows: item.rows, reasoning: "" }}
                  running={active && index === items.length - 1}
                  settled={!active}
                />
              ) : (
                <p className="subagent-thread__note">{item.text}</p>
              )}
            </li>
          ))}
          {conversation.conversation?.truncated === true ? (
            <li>
              <p className="subagent-thread__note">
                Earlier steps were not kept; this shows the most recent part of its work.
              </p>
            </li>
          ) : null}
          {row.resultPackets === undefined || row.resultPackets.length === 0 ? null : (
            <li>
              <AgentRunResults
                packets={row.resultPackets}
                truncated={row.resultsTruncated === true}
                {...(props.onReviewChanges === undefined
                  ? {}
                  : { onReviewChanges: props.onReviewChanges })}
              />
            </li>
          )}
        </ol>
      </div>
      <footer className="subagent-thread__footer thread-column">
        {conversation.reconnecting ? (
          <OctantAlert layout="row" tone="neutral">
            Reconnecting. Showing what it reported so far.
          </OctantAlert>
        ) : null}
        {conversation.errorMessage === undefined ? null : (
          <OctantAlert tone="warning">{conversation.errorMessage}</OctantAlert>
        )}
        {errorMessage === undefined ? null : (
          <OctantAlert role="alert" tone="danger">
            {errorMessage}
          </OctantAlert>
        )}
        {tooLong === undefined ? null : (
          <p className="subagent-thread__note" role="status">
            {tooLong}
          </p>
        )}
        {notice === undefined ? null : (
          <p className="subagent-thread__note" role="status">
            {notice}
          </p>
        )}
        {row.nativeReadOnly || !managed ? (
          <p className="subagent-thread__read-only" role="note">
            Runs inside the provider. Octant can read it but not steer it.
          </p>
        ) : (
          <>
            {canRetry ? (
              <div className="subagent-thread__retry">
                <span>It stopped and cannot pick up where it left off.</span>
                <OctantButton
                  onClick={() => {
                    void controls.retry(command).then((refusal) => {
                      if (refusal !== undefined) setErrorMessage(refusal);
                    });
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Retry
                </OctantButton>
              </div>
            ) : null}
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <ThreadComposer
                ariaLabel="Message this subagent"
                input={
                  <ComposerInput
                    aria-label={canSteer ? "Steering note" : "Message to continue it"}
                    className="composer-input"
                    disabled={sending || disabledReason !== undefined}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={
                      canSteer
                        ? "Steer it while it works"
                        : canResume
                          ? "Ask it to continue"
                          : "It cannot take a message now"
                    }
                    value={draft}
                  />
                }
                row={{ actions }}
              />
            </form>
          </>
        )}
      </footer>
    </section>
  );
}
