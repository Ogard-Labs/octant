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
  /** Arms or withdraws the opt-in to resume a usage-limited run at reset. */
  readonly onUsageResume?: (input: {
    runId: string;
    version: number;
    action: "schedule" | "cancel";
  }) => void;
}) {
  const row = props.row;
  const status = row.lifecycleStatus;
  const command = { runId: row.runId, version: row.version };
  const canSteer = status === "running" || status === "waiting";
  const canRetry = status === "failed" || status === "interrupted";
  const canResume =
    status === "waiting" ||
    (status === "interrupted" && row.recoveryReason !== "restart-without-resumable-execution");
  const usageResumeScheduled = row.usageResume?.status === "scheduled";
  const canArmUsageResume =
    status === "waiting" && row.usageLimit?.resetsAt !== undefined && !usageResumeScheduled;
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
        {status === "waiting" && row.usageLimit !== undefined ? (
          <p className="agent-run-detail__fact">{usageLimitFact(row)}</p>
        ) : null}
        {row.usageResume === undefined || row.usageResume.status === "scheduled" ? null : (
          <p className="agent-run-detail__fact">{usageResumeFact(row.usageResume)}</p>
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
        {usageResumeScheduled ? (
          <OctantButton
            aria-label="Stop the scheduled resume"
            onClick={() => props.onUsageResume?.({ ...command, action: "cancel" })}
            size="sm"
            type="button"
            variant="secondary"
          >
            Stop scheduled resume
          </OctantButton>
        ) : canArmUsageResume ? (
          <OctantButton
            aria-label="Resume this subagent when the provider limit resets"
            onClick={() => props.onUsageResume?.({ ...command, action: "schedule" })}
            size="sm"
            type="button"
            variant="secondary"
          >
            Resume at reset
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
 * What the subagent said. Managed conversation history is bounded and saved;
 * after restart it is stale until execution reconnects. Provider-native runs
 * may expose no conversation, and purged history cannot be restored. When the
 * conversation has nothing, the retained final reply stands in as the answer;
 * when neither exists the page explains what is missing.
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

/**
 * Words the limit the provider disclosed: a reset it named, or the honest
 * kind when it disclosed none. The run waits either way — the fact is what
 * the person acts on.
 */
function usageLimitFact(row: AgentHierarchyRow): string {
  const resetsAt = row.usageLimit?.resetsAt;
  const kind = row.usageLimit?.kind;
  const resetPhrase = resetsAt === undefined ? undefined : `resets ${relativeTimeLabel(resetsAt)}`;
  if (kind === "billing") {
    return resetPhrase === undefined
      ? "Provider reports the account's plan is exhausted; it can run again after the plan recovers."
      : `Provider reports the account's plan is exhausted; it ${resetPhrase}.`;
  }
  if (kind === "exhausted") {
    return resetPhrase === undefined
      ? "Provider usage limit is exhausted; the run can try again once quota recovers."
      : `Provider usage limit is exhausted; it ${resetPhrase}.`;
  }
  return resetPhrase === undefined
    ? "Provider hit a temporary usage limit; the run can try again once it clears."
    : `Provider hit a temporary usage limit; it ${resetPhrase}.`;
}

function usageResumeFact(usageResume: NonNullable<AgentHierarchyRow["usageResume"]>): string {
  if (usageResume.status === "dispatched") {
    return "Resumed when the limit reset.";
  }
  if (usageResume.status === "invalidated") {
    return `Scheduled resume did not run: ${usageResume.detail ?? "the run's stop changed."}`;
  }
  return `Scheduled resume failed: ${usageResume.detail ?? "the host could not restart the run."}`;
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
