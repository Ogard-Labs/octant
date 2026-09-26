import type { AgentRunConversationEntry, AgentRunConversationResponse } from "@octant/contracts";
import { ArrowLeft } from "lucide-react";
import { useId, useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { Markdown } from "../markdown/Markdown";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import type { AgentHierarchyRow } from "./buildAgentHierarchyModel";
import {
  SubagentStatusIcon,
  subagentPhase,
  subagentRoleWord,
  subagentStatusWord,
} from "./subagentStatus";
import "./agent-hierarchy.css";

type RunCommand = (input: { runId: string; version: number }) => void;

/**
 * One subagent's own page inside the Agents tool: what it was asked, what it
 * said, and what can still be done with it.
 *
 * The conversation reads like a small transcript — the task as the brief it
 * was handed, then each reply — because that is what the person opened it
 * for. Its controls stay pinned under it, one bar, so the reply is never
 * pushed out of view by buttons.
 */
export function AgentRunDetail(props: {
  readonly row: AgentHierarchyRow;
  readonly onBack: () => void;
  readonly conversation?: AgentRunConversationResponse;
  readonly conversationLoading?: boolean;
  readonly conversationReconnecting?: boolean;
  readonly conversationError?: string;
  readonly onAcknowledge?: RunCommand;
  readonly onCancel?: (input: { runId: string }) => void;
  readonly onSteer?: (input: { runId: string; version: number; message: string }) => void;
  readonly onRetry?: RunCommand;
  readonly onResume?: RunCommand;
}) {
  const row = props.row;
  const status = row.lifecycleStatus;
  const command = { runId: row.runId, version: row.version };
  const canSteer = status === "running" || status === "waiting";
  const canRetry = status === "failed" || status === "interrupted";
  const canResume =
    status === "waiting" ||
    (status === "interrupted" && row.recoveryReason !== "restart-without-resumable-execution");
  const active = row.bucket === "active";
  const facts = [subagentRoleWord(row.role), row.model, relativeTimeLabel(row.updatedAt)].filter(
    (part): part is string => part !== undefined,
  );

  return (
    <section aria-label="Subagent" className="agent-run-detail">
      <div className="agent-run-detail__nav">
        <OctantButton
          aria-label="Back to subagents"
          onClick={props.onBack}
          size="xs"
          type="button"
          variant="ghost"
        >
          <ArrowLeft aria-hidden="true" size={12} />
          Subagents
        </OctantButton>
      </div>

      <header className="agent-run-detail__header">
        <h2 className="agent-run-detail__title">{row.task}</h2>
        <p className="agent-run-detail__status">
          <SubagentStatusIcon lifecycleStatus={status} />
          <span className="agent-run-detail__state">{subagentStatusWord(status)}</span>
          <span>· {facts.join(" · ")}</span>
        </p>
        {row.routeLabel !== undefined && row.routeLabel !== row.model ? (
          <p className="agent-run-detail__fact">Route: {row.routeLabel}</p>
        ) : null}
        {row.routeReason === undefined ? null : (
          <p className="agent-run-detail__fact">{row.routeReason}</p>
        )}
        {row.recoveryReason === undefined ? null : (
          <p className="agent-run-detail__fact">{row.recoveryReason}</p>
        )}
        {row.nativeReadOnly ? (
          <p className="agent-run-detail__fact">
            Runs inside the provider itself; Octant can read it but not step into it.
          </p>
        ) : null}
      </header>

      <div aria-label="Subagent conversation" className="agent-run-detail__transcript" role="log">
        <div className="agent-run-detail__brief">
          <span className="agent-run-detail__label">Brief</span>
          <p>{row.task}</p>
        </div>
        <AgentRunReply
          active={active}
          row={row}
          {...(props.conversation === undefined ? {} : { conversation: props.conversation })}
          loading={props.conversationLoading === true}
          reconnecting={props.conversationReconnecting === true}
          {...(props.conversationError === undefined
            ? {}
            : { errorMessage: props.conversationError })}
        />
      </div>

      <div aria-label="Subagent actions" className="agent-run-detail__actions" role="group">
        {row.needsAcknowledgement ? (
          <OctantButton onClick={() => props.onAcknowledge?.(command)} size="sm" type="button">
            Mark reviewed
          </OctantButton>
        ) : null}
        {canSteer ? (
          <SteerControl
            task={row.task}
            onSteer={(message) => props.onSteer?.({ ...command, message })}
          />
        ) : null}
        {canRetry ? (
          <OctantButton
            onClick={() => props.onRetry?.(command)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        ) : null}
        {canResume ? (
          <OctantButton
            onClick={() => props.onResume?.(command)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Resume
          </OctantButton>
        ) : null}
        {active ? (
          <OctantButton
            aria-label="Cancel this subagent"
            onClick={() => props.onCancel?.({ runId: row.runId })}
            size="sm"
            type="button"
            variant="secondary"
          >
            Cancel
          </OctantButton>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What the subagent said. The live conversation is the host's bounded,
 * process-local read, so it can be unavailable (a provider-native run), stale,
 * or simply gone once the process that held it ends; the retained final reply
 * in the summary outlives it. When the live read has nothing, the retained
 * reply stands in as the answer, and when neither exists the page says so
 * rather than showing an empty column.
 */
function AgentRunReply(props: {
  readonly row: AgentHierarchyRow;
  readonly active: boolean;
  readonly conversation?: AgentRunConversationResponse;
  readonly loading: boolean;
  readonly reconnecting: boolean;
  readonly errorMessage?: string;
}) {
  const conversation = props.conversation;
  const entries = conversation?.entries ?? [];
  const notes: string[] = [];
  if (conversation?.status === "stale") {
    notes.push(conversation.staleReason ?? "The live conversation is stale.");
  }
  if (props.reconnecting) notes.push("Live conversation disconnected; reconnecting.");
  if (props.errorMessage !== undefined) notes.push(props.errorMessage);

  if (entries.length > 0) {
    return (
      <>
        {conversation?.truncated === true ? (
          <p className="agent-run-detail__note">Earlier text was truncated.</p>
        ) : null}
        {replyBlocks(entries).map((block) =>
          block.kind === "assistant" ? (
            <Markdown
              body={block.text}
              className="chat-rich-text agent-run-detail__message"
              key={block.key}
            />
          ) : (
            <p className="agent-run-detail__event" key={block.key}>
              {block.text}
            </p>
          ),
        )}
        <ReplyNotes notes={notes} />
      </>
    );
  }

  if (props.loading && conversation === undefined) {
    return (
      <p className="agent-run-detail__note" role="status">
        Connecting to the live conversation…
      </p>
    );
  }

  const result = props.row.result;
  if (result?.text !== undefined) {
    return (
      <>
        <Markdown body={result.text} className="chat-rich-text agent-run-detail__message" />
        {result.truncated ? (
          <p className="agent-run-detail__note">The reply was truncated.</p>
        ) : null}
      </>
    );
  }

  const empty =
    result !== undefined
      ? "The reply is no longer retained."
      : conversation?.status === "unavailable"
        ? "The live conversation is unavailable for this subagent."
        : props.active
          ? subagentPhase(props.row.lifecycleStatus) === "waiting"
            ? "Waiting. No reply yet."
            : "No reply yet."
          : "This subagent left no reply to show.";
  return (
    <>
      <p className="agent-run-detail__note" role="status">
        {empty}
      </p>
      <ReplyNotes notes={notes} />
    </>
  );
}

function ReplyNotes(props: { readonly notes: ReadonlyArray<string> }) {
  return (
    <>
      {props.notes.map((note) => (
        <p className="agent-run-detail__note" key={note}>
          {note}
        </p>
      ))}
    </>
  );
}

function SteerControl(props: {
  readonly task: string;
  readonly onSteer: (message: string) => void;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  if (!open) {
    return (
      <OctantButton
        aria-label={`Steer ${props.task}`}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="secondary"
      >
        Steer
      </OctantButton>
    );
  }
  return (
    <form
      aria-label={`Steer ${props.task}`}
      className="agent-run-detail__steer"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const next = message.trim();
        if (next.length === 0) return;
        props.onSteer(next);
        setMessage("");
        setOpen(false);
      }}
    >
      <label htmlFor={fieldId}>
        Steering instruction
        <OctantInput
          autoFocus
          id={fieldId}
          onChange={(event) => setMessage(event.target.value)}
          required
          value={message}
        />
      </label>
      <div className="agent-run-detail__steer-actions">
        <OctantButton size="sm" type="submit">
          Send steering
        </OctantButton>
        <OctantButton onClick={() => setOpen(false)} size="sm" type="button" variant="ghost">
          Cancel steering
        </OctantButton>
      </div>
    </form>
  );
}

/**
 * The host records a reply as it streams, one entry per text delta, so
 * "Hello, Henrik!" arrived as "Hello", ",", " Henrik", "!" and rendered as
 * four paragraphs. Consecutive assistant entries are one message; a status
 * entry between them ends it.
 */
function replyBlocks(entries: ReadonlyArray<AgentRunConversationEntry>): ReadonlyArray<{
  readonly key: number;
  readonly kind: "assistant" | "status";
  readonly text: string;
}> {
  const blocks: Array<{ key: number; kind: "assistant" | "status"; text: string }> = [];
  for (const entry of entries) {
    const last = blocks.at(-1);
    if (entry.kind === "assistant" && last?.kind === "assistant") {
      last.text += entry.text;
      continue;
    }
    blocks.push({ key: entry.sequence, kind: entry.kind, text: entry.text });
  }
  return blocks;
}
