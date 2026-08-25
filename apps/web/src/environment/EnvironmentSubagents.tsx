import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunConversationResponse } from "@octant/contracts";
import { decodeAgentRunId, decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { Bot, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useChildRunStatus } from "../agents/useChildRunStatus";
import { useAgentRunConversation } from "../agents/useAgentRunConversation";
import { OctantButton } from "../ui/base/OctantButton";

const ACTIVE = new Set(["queued", "starting", "running", "waiting"]);

export function EnvironmentSubagents(props: {
  readonly client: AgentRunClient;
  readonly threadId: string;
  readonly onOpenAgents?: () => void;
}) {
  const controller = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const conversationState = useAgentRunConversation(
    props.client,
    selectedRunId === undefined ? undefined : decodeAgentRunId(selectedRunId),
  );
  if (controller.status !== "ready" || controller.entries.length === 0) return null;
  const active = controller.entries.filter((entry) => ACTIVE.has(entry.lifecycleStatus));
  const history = controller.entries.filter((entry) => !ACTIVE.has(entry.lifecycleStatus));

  return (
    <section aria-label="Subagents" className="environment-subagents">
      <header className="environment-subagents__header">
        <div>
          <h3>Subagents</h3>
          <p>
            {active.length} active · {history.length} done
          </p>
        </div>
        {props.onOpenAgents === undefined ? null : (
          <OctantButton onClick={props.onOpenAgents} size="sm" type="button" variant="ghost">
            Open Agents
          </OctantButton>
        )}
      </header>
      <AgentGroup
        entries={active}
        label="Active"
        {...(conversationState.conversation === undefined
          ? {}
          : { conversation: conversationState.conversation })}
        reconnecting={conversationState.reconnecting}
        loading={conversationState.loading}
        {...(conversationState.errorMessage === undefined
          ? {}
          : { errorMessage: conversationState.errorMessage })}
        {...(selectedRunId === undefined ? {} : { selectedRunId })}
        onSelect={setSelectedRunId}
      />
      <AgentGroup
        entries={history}
        label="Done"
        {...(conversationState.conversation === undefined
          ? {}
          : { conversation: conversationState.conversation })}
        reconnecting={conversationState.reconnecting}
        loading={conversationState.loading}
        {...(conversationState.errorMessage === undefined
          ? {}
          : { errorMessage: conversationState.errorMessage })}
        {...(selectedRunId === undefined ? {} : { selectedRunId })}
        onSelect={setSelectedRunId}
      />
    </section>
  );
}

function AgentGroup(props: {
  readonly entries: ReturnType<typeof useChildRunStatus>["entries"];
  readonly label: string;
  readonly conversation?: AgentRunConversationResponse;
  readonly reconnecting: boolean;
  readonly loading: boolean;
  readonly errorMessage?: string;
  readonly selectedRunId?: string;
  readonly onSelect: (runId: string | undefined) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <section aria-label={props.label} className="environment-subagents__group">
      <h4>
        {props.label} · {props.entries.length}
      </h4>
      <ul>
        {props.entries.map((entry) => {
          const selected = props.selectedRunId === entry.runId;
          const model =
            entry.route?.executionModelId ?? entry.route?.requestedModelId ?? "Model unavailable";
          return (
            <li key={entry.runId}>
              <OctantButton
                aria-expanded={selected}
                className="environment-subagents__row"
                onClick={() => props.onSelect(selected ? undefined : entry.runId)}
                type="button"
                variant="ghost"
              >
                <Bot aria-hidden="true" size={16} strokeWidth={1.7} />
                <span>
                  <strong>{entry.task}</strong>
                  <small>
                    {model} · {entry.lifecycleStatus}
                  </small>
                </span>
                <ChevronRight aria-hidden="true" size={14} strokeWidth={1.7} />
              </OctantButton>
              {selected ? (
                <div className="environment-subagents__conversation">
                  <div>
                    <span>Task</span>
                    <p>{entry.task}</p>
                  </div>
                  <div>
                    <span>Response</span>
                    <ConversationBody
                      conversation={
                        props.conversation?.runId === entry.runId ? props.conversation : undefined
                      }
                      entry={entry}
                      reconnecting={props.reconnecting}
                      loading={props.loading}
                      {...(props.errorMessage === undefined
                        ? {}
                        : { errorMessage: props.errorMessage })}
                    />
                    {entry.result?.truncated === true ? <small>Response truncated</small> : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ConversationBody(props: {
  readonly conversation: AgentRunConversationResponse | undefined;
  readonly entry: ReturnType<typeof useChildRunStatus>["entries"][number];
  readonly reconnecting: boolean;
  readonly loading: boolean;
  readonly errorMessage?: string;
}) {
  const fallback =
    props.entry.result?.text ??
    (ACTIVE.has(props.entry.lifecycleStatus)
      ? "The subagent is still working. Reconnecting to its live response…"
      : "No retained response is available.");
  if (props.conversation === undefined) {
    return (
      <p>
        {props.loading
          ? "Connecting to the subagent’s live response…"
          : (props.errorMessage ?? fallback)}
      </p>
    );
  }
  if (props.conversation.status === "unavailable") {
    return <p>Live response text is unavailable for this execution.</p>;
  }
  if (props.conversation.entries.length === 0) {
    return (
      <p>
        {props.conversation.status === "stale"
          ? (props.conversation.staleReason ??
            "The child session is stale; no more transcript is available.")
          : "The subagent has not produced visible response text yet."}
      </p>
    );
  }
  return (
    <div>
      {props.conversation.entries.map((entry) => (
        <p key={entry.sequence}>{entry.text}</p>
      ))}
      {props.conversation.truncated ? <small>Earlier response text was truncated.</small> : null}
      {props.conversation.status === "stale" ? (
        <small>{props.conversation.staleReason ?? "The live response is stale."}</small>
      ) : null}
      {props.reconnecting ? (
        <small>Live response disconnected; reconnect to continue.</small>
      ) : null}
    </div>
  );
}
