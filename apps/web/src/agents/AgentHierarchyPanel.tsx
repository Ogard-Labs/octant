import { useId, useMemo, useState } from "react";
import type { AgentRunConversationResponse } from "@octant/contracts";
import {
  buildAgentHierarchyModel,
  type AgentHierarchyFilter,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";
import "./agent-hierarchy.css";

export function AgentHierarchyPanel(props: {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly creationPosture?: "off" | "ask" | "automatic";
  readonly onAcknowledge?: (input: { runId: string; version: number }) => void;
  readonly onCancel?: (input: { runId: string }) => void;
  readonly onSteer?: (input: { runId: string; version: number; message: string }) => void;
  readonly onRetry?: (input: { runId: string; version: number }) => void;
  readonly onResume?: (input: { runId: string; version: number }) => void;
  readonly reconnecting?: boolean;
  readonly conversation?: AgentRunConversationResponse;
  readonly conversationReconnecting?: boolean;
  readonly conversationLoading?: boolean;
  readonly conversationError?: string;
  readonly onInspectConversation?: (runId: string) => void;
}) {
  const [filter, setFilter] = useState<AgentHierarchyFilter>("active");
  const [query, setQuery] = useState("");
  const model = useMemo(
    () =>
      buildAgentHierarchyModel({
        entries: props.entries,
        filter,
        query,
        ...(props.creationPosture === undefined ? {} : { creationPosture: props.creationPosture }),
      }),
    [props.entries, props.creationPosture, filter, query],
  );

  return (
    <section
      aria-label="Agents hierarchy"
      className={`agent-hierarchy ${props.reconnecting ? "agent-hierarchy--reconnecting" : ""}`}
    >
      <header className="agent-hierarchy__header">
        <div>
          <p className="agent-hierarchy__eyebrow">Agents</p>
          <h2>Active / History</h2>
          <p>
            Server-authored child runs only. Posture: <strong>{model.creationPosture}</strong>
          </p>
        </div>
        <div className="agent-hierarchy__counts" aria-live="polite">
          <span>{model.activeCount} active</span>
          <span>{model.historyCount} history</span>
        </div>
      </header>

      <div className="agent-hierarchy__controls">
        <label>
          Filter
          <select
            aria-label="Agent hierarchy filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as AgentHierarchyFilter)}
          >
            <option value="active">Active</option>
            <option value="history">History</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Search
          <input
            aria-label="Search child agents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by task, role, status"
          />
        </label>
      </div>

      {props.reconnecting ? (
        <p className="agent-hierarchy__banner" role="status">
          Reconnecting… showing last server-authored hierarchy.
        </p>
      ) : null}

      {model.emptyReason !== undefined ? (
        <p className="agent-hierarchy__empty" role="status">
          {model.emptyReason}
        </p>
      ) : (
        <ul className="agent-hierarchy__list">
          {model.rows.map((row) => (
            <li
              key={row.runId}
              className="agent-hierarchy__row"
              style={{ paddingLeft: `${12 + row.depth * 16}px` }}
            >
              <div className="agent-hierarchy__row-main">
                <strong>{row.task}</strong>
                <span>
                  {row.role} · {row.lifecycleStatus}
                  {row.nativeReadOnly ? " · native read-only" : ""}
                </span>
              </div>
              <div className="agent-hierarchy__row-meta">
                <button
                  type="button"
                  aria-label={`View conversation for ${row.task}`}
                  onClick={() => props.onInspectConversation?.(row.runId)}
                >
                  {props.conversation?.runId === row.runId ? "Hide transcript" : "View transcript"}
                </button>
                {props.conversation?.runId === row.runId ? (
                  <AgentConversation
                    conversation={props.conversation}
                    reconnecting={props.conversationReconnecting === true}
                    loading={props.conversationLoading === true}
                    {...(props.conversationError === undefined
                      ? {}
                      : { errorMessage: props.conversationError })}
                  />
                ) : null}
                <span>usage: {row.usageQuality}</span>
                {row.routeLabel ? <span>route: {row.routeLabel}</span> : null}
                {row.routeReason ? <span>{row.routeReason}</span> : null}
                {row.recoveryReason ? <span>recovery: {row.recoveryReason}</span> : null}
                {row.needsAcknowledgement ? (
                  <button
                    type="button"
                    onClick={() =>
                      props.onAcknowledge?.({ runId: row.runId, version: row.version })
                    }
                  >
                    Acknowledge result
                  </button>
                ) : null}
                {row.lifecycleStatus === "running" || row.lifecycleStatus === "waiting" ? (
                  <SteerControl
                    task={row.task}
                    onSteer={(message) =>
                      props.onSteer?.({ runId: row.runId, version: row.version, message })
                    }
                  />
                ) : null}
                {row.lifecycleStatus === "failed" || row.lifecycleStatus === "interrupted" ? (
                  <button
                    type="button"
                    aria-label={`Retry ${row.task}`}
                    onClick={() => props.onRetry?.({ runId: row.runId, version: row.version })}
                  >
                    Retry
                  </button>
                ) : null}
                {row.lifecycleStatus === "waiting" ||
                (row.lifecycleStatus === "interrupted" &&
                  row.recoveryReason !== "restart-without-resumable-execution") ? (
                  <button
                    type="button"
                    aria-label={`Resume ${row.task}`}
                    onClick={() => props.onResume?.({ runId: row.runId, version: row.version })}
                  >
                    Resume
                  </button>
                ) : null}
                {row.bucket === "active" ? (
                  <button
                    type="button"
                    aria-label={`Cancel ${row.task}`}
                    onClick={() => props.onCancel?.({ runId: row.runId })}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentConversation(props: {
  readonly conversation: AgentRunConversationResponse;
  readonly reconnecting: boolean;
  readonly loading: boolean;
  readonly errorMessage?: string;
}) {
  if (props.loading) return <span role="status">Connecting to live transcript…</span>;
  if (props.conversation.status === "unavailable") {
    return <span role="status">Live transcript is unavailable for this execution.</span>;
  }
  if (props.conversation.entries.length === 0) {
    return (
      <span role="status">
        {props.conversation.status === "stale"
          ? (props.conversation.staleReason ?? "The child session is stale.")
          : "No visible response text yet."}
      </span>
    );
  }
  return (
    <span aria-label="Child conversation">
      {props.conversation.entries.map((entry) => entry.text).join("\n")}
      {props.conversation.truncated ? " (earlier text truncated)" : ""}
      {props.reconnecting ? " Live transcript disconnected; reconnect to continue." : ""}
      {props.errorMessage === undefined ? "" : ` ${props.errorMessage}`}
    </span>
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
      <button type="button" aria-label={`Steer ${props.task}`} onClick={() => setOpen(true)}>
        Steer
      </button>
    );
  }
  return (
    <form
      aria-label={`Steer ${props.task}`}
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
        <input
          id={fieldId}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          required
        />
      </label>
      <button type="submit">Send steering</button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel steering
      </button>
    </form>
  );
}
