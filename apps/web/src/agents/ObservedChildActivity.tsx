import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentObservedChild } from "@octant/contracts";
import { ArrowLeft } from "lucide-react";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { observedChildUsageLine } from "./agentRunGraphFacts";
import { subagentElapsedLabel, subagentStatusWord, SubagentStatusIcon } from "./subagentStatus";

/** Selection keys never enter the managed run identifier or command paths. */
export function observedChildSelectionId(child: AgentObservedChild): string {
  return `observation:${child.observationId}`;
}

const STOP_REFUSALS = {
  "not-found": "The subagent already finished.",
  "not-live": "The turn that started this subagent is no longer running.",
  unsupported: "This provider cannot stop one subagent on its own.",
  unauthorized: "This window cannot stop subagents of this thread.",
} as const;

/**
 * Stop for one subagent a provider started, offered only where the host said
 * the running turn can stop it alone. A request is not a stop: the child
 * keeps its reported status until the provider says it finished.
 */
function ObservedChildStop(props: {
  readonly child: AgentObservedChild;
  readonly client?: Pick<AgentRunClient, "stopObserved"> | undefined;
}) {
  const [state, setState] = useState<
    | { readonly kind: "idle" | "requesting" | "requested" }
    | { readonly kind: "refused"; readonly message: string }
  >({ kind: "idle" });
  const stopObserved = props.client?.stopObserved;
  if (props.child.control !== "stop" || stopObserved === undefined) return null;
  const stop = async () => {
    setState({ kind: "requesting" });
    try {
      const result = await stopObserved({
        parentThreadId: props.child.parentThreadId,
        observationId: props.child.observationId,
      });
      setState(
        result.status === "stop-requested"
          ? { kind: "requested" }
          : { kind: "refused", message: STOP_REFUSALS[result.reason] },
      );
    } catch {
      setState({ kind: "refused", message: "The subagent could not be stopped. Try again." });
    }
  };
  return (
    <>
      <OctantButton
        aria-label={`Stop subagent: ${props.child.task ?? props.child.childAgentId}`}
        disabled={state.kind === "requesting" || state.kind === "requested"}
        onClick={() => void stop()}
        size="xs"
        variant="ghost"
      >
        {state.kind === "requested" ? "Stopping" : "Stop"}
      </OctantButton>
      {state.kind === "refused" ? (
        <span className="composer-subagents__reason" role="status">
          {state.message}
        </span>
      ) : null}
    </>
  );
}

/**
 * A subagent a provider runtime started on its own. Octant lists it with the
 * thread's other subagents and says who started it; it offers none of the
 * controls a run Octant started has.
 */
export function ObservedChildRow(props: {
  readonly child: AgentObservedChild;
  readonly now: number;
  /** The provider's display name, or its instance id when unknown. */
  readonly providerName: string;
  /** Present when the surface knows the instance, so its mark is drawn. */
  readonly driverKind?: string;
  readonly onOpen?: (selectionId: string) => void;
  readonly client?: Pick<AgentRunClient, "stopObserved">;
}) {
  const child = props.child;
  const task = child.task ?? "Task unavailable";
  const age = subagentElapsedLabel(child.firstObservedAt, props.now);
  const meta = [
    subagentStatusWord(child.lifecycleStatus),
    `Started by ${props.providerName}`,
    child.modelId ?? "Model unknown",
    observedChildUsageLine(child.usage),
    age === "" ? undefined : `First seen ${age} ago`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  return (
    <>
      <OctantButton
        aria-label={`${task}. ${meta}. Opens it in Agents.`}
        className="composer-subagents__open"
        onClick={() => props.onOpen?.(observedChildSelectionId(child))}
        size="xs"
        title={task}
        variant="ghost"
      >
        <SubagentStatusIcon lifecycleStatus={child.lifecycleStatus} />
        {props.driverKind === undefined ? null : (
          <ProviderGlyph displayName={props.providerName} driverKind={props.driverKind} size={12} />
        )}
        <span className="composer-subagents__content">
          <span className="composer-subagents__task">{task}</span>
          <span className="composer-subagents__meta">{meta}</span>
          <span className="composer-subagents__reason">
            {child.finalSummary ?? (child.latestSummary || "No activity reported.")}
          </span>
        </span>
      </OctantButton>
      <ObservedChildStop child={child} client={props.client} />
    </>
  );
}

export function ObservedChildDetail(props: {
  readonly child: AgentObservedChild;
  readonly onBack: () => void;
  readonly client?: Pick<AgentRunClient, "stopObserved">;
}) {
  const child = props.child;
  const usage = observedChildUsageLine(child.usage);
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
        {child.control === "stop" ? (
          <ObservedChildStop child={child} client={props.client} />
        ) : (
          <p className="agent-run-detail__fact">
            Started by its provider. Octant observes it and has no controls for it.
          </p>
        )}
        <p className="agent-run-detail__fact">Provider: {child.providerInstanceId}</p>
        <p className="agent-run-detail__fact">
          {child.modelId === undefined ? "Model unknown" : `Model: ${child.modelId}`}
        </p>
        <p className="agent-run-detail__fact">
          {usage === undefined ? "Usage not reported" : `Usage: ${usage}`}
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
        {child.finalSummary === undefined ? null : (
          // The subagent's own words as its provider relayed them; shown here
          // only, folded, as plain text.
          <OctantCollapsible
            className="agent-observation__final"
            summary="Final summary from the subagent"
          >
            <p className="whitespace-pre-wrap">{child.finalSummary}</p>
          </OctantCollapsible>
        )}
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
