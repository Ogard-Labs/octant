import type { AgentObservedChild } from "@octant/contracts";
import { ObservedChildRow } from "./ObservedChildActivity";
import { useMemo } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import {
  buildAgentHierarchyModel,
  type AgentHierarchyInputEntry,
  type AgentHierarchyRow,
} from "./buildAgentHierarchyModel";
import { SubagentStatusIcon, subagentRoleWord, subagentStatusWord } from "./subagentStatus";
import "./agent-hierarchy.css";

/**
 * The Agents tool's list of one thread's subagents.
 *
 * It had been a filter, a search box, and rows that each unfolded a
 * plain-text transcript and five controls in place — for a list that is a
 * handful of rows. Now it is two sections, Working and Finished, of one-button
 * rows; a row opens that subagent's own page, where its conversation and
 * controls live. Nothing here starts a subagent: the thread's agent does, when
 * it hands off part of its work, because only then does the result come back
 * to it.
 */
export function AgentHierarchyPanel(props: {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly observations?: ReadonlyArray<AgentObservedChild>;
  readonly observationsTruncated?: boolean;
  readonly creationPosture?: "off" | "ask" | "automatic";
  readonly reconnecting?: boolean;
  readonly onOpen?: (runId: string) => void;
}) {
  const model = useMemo(
    () =>
      buildAgentHierarchyModel({
        entries: props.entries,
        ...(props.creationPosture === undefined ? {} : { creationPosture: props.creationPosture }),
      }),
    [props.entries, props.creationPosture],
  );

  return (
    <section
      aria-label="Subagents"
      className={`agent-hierarchy ${props.reconnecting ? "agent-hierarchy--reconnecting" : ""}`}
    >
      <header className="agent-hierarchy__header">
        <h2>Subagents</h2>
      </header>

      {props.reconnecting ? (
        <p className="agent-hierarchy__banner" role="status">
          Reconnecting… showing the last list the host sent.
        </p>
      ) : null}

      {model.emptyReason === undefined || (props.observations?.length ?? 0) > 0 ? null : (
        <p className="agent-hierarchy__empty" role="status">
          {model.emptyReason}
        </p>
      )}

      {(props.observations?.length ?? 0) > 0 ? (
        <section aria-label="Observed children" className="agent-hierarchy__section">
          <h3>Observed children · {props.observations?.length}</h3>
          <ul className="agent-hierarchy__list">
            {props.observations?.map((child) => (
              <li key={child.observationId} className="agent-hierarchy__row">
                <ObservedChildRow
                  child={child}
                  now={Date.now()}
                  {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.observationsTruncated ? (
        <p className="agent-hierarchy__banner">Earlier observed children are not retained.</p>
      ) : null}
      <AgentHierarchySection label="Working" onOpen={props.onOpen} rows={model.working} />
      <AgentHierarchySection label="Finished" onOpen={props.onOpen} rows={model.finished} />
    </section>
  );
}

function AgentHierarchySection(props: {
  readonly label: string;
  readonly rows: ReadonlyArray<AgentHierarchyRow>;
  readonly onOpen: ((runId: string) => void) | undefined;
}) {
  if (props.rows.length === 0) return null;
  return (
    <section aria-label={props.label} className="agent-hierarchy__section">
      <h3>
        {props.label} · {props.rows.length}
      </h3>
      <ul className="agent-hierarchy__list">
        {props.rows.map((row) => (
          <li
            className="agent-hierarchy__row"
            key={row.runId}
            // Nesting is whatever parent the host reported, capped at two
            // levels by the model; the indent is the only place it shows.
            style={{ paddingInlineStart: `${row.depth * 16}px` }}
          >
            <OctantButton
              className="agent-hierarchy__open"
              onClick={() => props.onOpen?.(row.runId)}
              title={row.task}
              type="button"
              variant="ghost"
            >
              <SubagentStatusIcon lifecycleStatus={row.lifecycleStatus} />
              <span className="agent-hierarchy__row-text">
                <span className="agent-hierarchy__task">{row.task}</span>
                <span className="agent-hierarchy__meta">{rowFacts(row)}</span>
              </span>
              {row.needsReview ? <span className="agent-hierarchy__flag">Needs review</span> : null}
            </OctantButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Done · Review · gpt-6-astra · 3m ago": state in words first, then what ran it. */
function rowFacts(row: AgentHierarchyRow): string {
  return [
    subagentStatusWord(row.lifecycleStatus),
    subagentRoleWord(row.role),
    row.model,
    relativeTimeLabel(row.updatedAt),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}
