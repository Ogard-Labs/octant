import { useMemo, useState } from "react";
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
  readonly reconnecting?: boolean;
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
