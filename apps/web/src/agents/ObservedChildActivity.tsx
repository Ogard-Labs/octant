import type { AgentObservedChild } from "@octant/contracts";
import { ArrowLeft } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { subagentElapsedLabel, subagentStatusWord, SubagentStatusIcon } from "./subagentStatus";

/** Selection keys never enter the managed run identifier or command paths. */
export function observedChildSelectionId(child: AgentObservedChild): string {
  return `observation:${child.observationId}`;
}

export function ObservedChildRow(props: {
  readonly child: AgentObservedChild;
  readonly now: number;
  readonly onOpen?: (selectionId: string) => void;
}) {
  const child = props.child;
  const task = child.task ?? "Task unavailable";
  const age = subagentElapsedLabel(child.firstObservedAt, props.now);
  return (
    <OctantButton
      aria-label={`Inspect observed child: ${task}. ${subagentStatusWord(child.lifecycleStatus)}. Observation only.`}
      className="composer-subagents__open"
      onClick={() => props.onOpen?.(observedChildSelectionId(child))}
      size="xs"
      variant="ghost"
    >
      <SubagentStatusIcon lifecycleStatus={child.lifecycleStatus} />
      <span className="composer-subagents__content">
        <span className="composer-subagents__task">{task}</span>
        <span className="composer-subagents__meta">
          {subagentStatusWord(child.lifecycleStatus)} · Observation only
          {age === "" ? "" : ` · First seen ${age} ago`}
        </span>
        <span className="composer-subagents__meta">{child.modelId ?? "Model unavailable"}</span>
        <span className="composer-subagents__reason">
          {child.latestSummary || "No activity reported."}
        </span>
      </span>
    </OctantButton>
  );
}

export function ObservedChildDetail(props: {
  readonly child: AgentObservedChild;
  readonly onBack: () => void;
}) {
  const child = props.child;
  return (
    <section aria-label="Observed child" className="agent-run-detail">
      <div className="agent-run-detail__nav">
        <OctantButton onClick={props.onBack} size="xs" variant="ghost">
          <ArrowLeft aria-hidden="true" size={12} />
          Subagents
        </OctantButton>
      </div>
      <header className="agent-run-detail__header">
        <h2 className="agent-run-detail__title">{child.task ?? `Child ${child.childAgentId}`}</h2>
        <p className="agent-run-detail__status">
          <SubagentStatusIcon lifecycleStatus={child.lifecycleStatus} />
          {subagentStatusWord(child.lifecycleStatus)}
        </p>
        <p className="agent-run-detail__fact">Observation only. Controls are unavailable.</p>
        <p className="agent-run-detail__fact">Provider: {child.providerInstanceId}</p>
        <p className="agent-run-detail__fact">
          {child.modelId === undefined ? "Model unavailable" : `Model: ${child.modelId}`}
        </p>
        <p className="agent-run-detail__fact">Child: {child.childAgentId}</p>
        {child.parentChildAgentId === undefined ? null : (
          <p className="agent-run-detail__fact">Parent child: {child.parentChildAgentId}</p>
        )}
        <p className="agent-run-detail__fact">
          First observed: {child.firstObservedAt} · Updated: {child.updatedAt}
        </p>
      </header>
      <div className="agent-run-detail__transcript">
        <p>{child.latestSummary || "No activity reported."}</p>
        <p className="agent-run-detail__note">
          {child.historyStatus === "conflicted"
            ? "Conflicting observations; the child's current state is unknown."
            : child.historyStatus === "truncated"
              ? "Observation history is truncated."
              : "Only reported activity is available; observation history is partial."}
        </p>
        {child.history.length === 0 ? (
          <p className="agent-run-detail__note">No earlier activity retained.</p>
        ) : (
          <ol aria-label="Observed activity" className="agent-observation__history">
            {child.history.map((event) => (
              <li key={event.sequence}>
                <span>
                  {event.occurredAt} · {subagentStatusWord(event.status)}
                </span>
                <p>{event.summary}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
