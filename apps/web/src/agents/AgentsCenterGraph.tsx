import type { AgentRunCenterSummary } from "@octant/contracts";
import { buildAgentRunForest } from "@octant/domain";
import {
  agentRunLifecycleLabel,
  agentRunModeLabel,
  agentRunRouteLabel,
  type AgentsCenterThreadTarget,
} from "./agentsCenterModel";
import { layoutAgentRunForest, type AgentRunGraphBox } from "./layoutAgentRunForest";
import { agentRunGraphUsageLine, formatAgentRunRecency } from "./agentRunGraphFacts";
import { OctantButton } from "../ui/base/OctantButton";

export function AgentsCenterGraph(props: {
  readonly items: ReadonlyArray<AgentRunCenterSummary>;
  readonly selectedId?: string;
  readonly refreshing?: boolean;
  readonly onSelect: (runId: string) => void;
  readonly onOpenThread?: (target: AgentsCenterThreadTarget & { readonly title: string }) => void;
  readonly providerLabels: ReadonlyMap<string, string>;
}) {
  const layout = layoutAgentRunForest(buildAgentRunForest(props.items));
  return (
    <div
      aria-busy={props.refreshing === true}
      aria-label="Agent run graph"
      className="agents-center-graph"
      role="region"
      style={{ width: layout.width, height: layout.height }}
    >
      <svg
        aria-hidden="true"
        className="agents-center-graph__edges"
        height={layout.height}
        width={layout.width}
      >
        {layout.edges.map((edge) => (
          <path
            d={`M ${String(edge.x1)} ${String(edge.y1)} C ${String(edge.x1)} ${String(edge.y1 + 24)}, ${String(edge.x2)} ${String(edge.y2 - 24)}, ${String(edge.x2)} ${String(edge.y2)}`}
            fill="none"
            key={`${edge.fromId}->${edge.toId}`}
            stroke="currentColor"
            strokeWidth="1.25"
          />
        ))}
      </svg>
      {layout.boxes.map((box) => (
        <GraphCard
          box={box}
          key={box.id}
          {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
          onSelect={props.onSelect}
          providerLabels={props.providerLabels}
          {...(props.selectedId === undefined ? {} : { selectedId: props.selectedId })}
        />
      ))}
    </div>
  );
}

function GraphCard(props: {
  readonly box: AgentRunGraphBox;
  readonly selectedId?: string;
  readonly onSelect: (runId: string) => void;
  readonly onOpenThread?: (target: AgentsCenterThreadTarget & { readonly title: string }) => void;
  readonly providerLabels: ReadonlyMap<string, string>;
}) {
  const { box } = props;
  const style = { left: box.x, top: box.y, width: box.width, height: box.height };
  if (box.kind === "thread") {
    const open = () => {
      props.onOpenThread?.({
        mode: box.thread.mode,
        threadId: box.thread.parentThreadId,
        title: box.thread.title,
      });
    };
    return (
      <div className="agents-center-graph__card" data-kind="thread" style={style}>
        <OctantButton
          aria-label={`${box.thread.title} thread`}
          className="agents-center-graph__hit"
          disabled={props.onOpenThread === undefined}
          onClick={open}
          type="button"
          variant="ghost"
        >
          <span className="agents-center-graph__eyebrow">Parent thread</span>
          <span className="agents-center-graph__title">{box.thread.title}</span>
          <span className="agents-center-graph__meta">{agentRunModeLabel(box.thread.mode)}</span>
        </OctantButton>
      </div>
    );
  }

  const selected = props.selectedId === String(box.summary.runId);
  const provider =
    props.providerLabels.get(String(box.summary.route.requestedProviderInstanceId)) ??
    box.summary.route.requestedModelId;
  const usageLine = agentRunGraphUsageLine(box.summary);
  const recency = formatAgentRunRecency(box.summary.updatedAt, Date.now());
  return (
    <div
      className="agents-center-graph__card"
      data-kind="run"
      {...(selected ? { "data-selected": "true" as const } : {})}
      style={style}
    >
      <OctantButton
        aria-label={box.summary.task}
        aria-pressed={selected}
        className="agents-center-graph__hit"
        data-agent-run-card={String(box.summary.runId)}
        onClick={() => props.onSelect(String(box.summary.runId))}
        type="button"
        variant="ghost"
      >
        <span className="agents-center-graph__eyebrow">
          <span>{provider}</span>
          <span data-lifecycle={box.summary.lifecycleStatus}>
            {agentRunLifecycleLabel(box.summary.lifecycleStatus)}
          </span>
        </span>
        <span className="agents-center-graph__title">{box.summary.task}</span>
        <span className="agents-center-graph__meta">
          {box.summary.role}
          {box.summary.normalizedReasoning === undefined
            ? ""
            : ` · ${box.summary.normalizedReasoning}`}
          {" · "}
          {agentRunRouteLabel(box.summary)}
        </span>
        {usageLine === undefined ? null : (
          <span className="agents-center-graph__usage">{usageLine}</span>
        )}
        <span className="agents-center-graph__meta">{recency}</span>
      </OctantButton>
    </div>
  );
}
