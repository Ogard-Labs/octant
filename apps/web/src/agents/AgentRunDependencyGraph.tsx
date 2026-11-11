import { useEffect, useId, useMemo, useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import type { AgentHierarchyRow } from "./buildAgentHierarchyModel";
import { layoutAgentRunLayers, type AgentRunLayerEdge } from "./layoutAgentRunLayers";
import {
  SubagentStatusIcon,
  subagentPhase,
  subagentRoleWord,
  subagentStatusWord,
} from "./subagentStatus";

/** What a surface knows about the provider instance that ran a subagent. */
export interface SubagentProviderIdentity {
  readonly driverKind: string;
  readonly displayName: string;
}

/**
 * One thread's subagents as a graph: each run sits below the runs it waits
 * for, with an arrow from each of them.
 *
 * The list answers "what is running and what finished"; it cannot show that a
 * check is held until two other runs complete, which is the plan the thread's
 * agent actually made. The cards carry the same facts as the list's rows and
 * open the same page, so the graph is a second arrangement of one list, not a
 * second place to control a run.
 */
export function AgentRunDependencyGraph(props: {
  readonly rows: ReadonlyArray<AgentHierarchyRow>;
  readonly providers?: ReadonlyMap<string, SubagentProviderIdentity>;
  readonly onOpen?: (runId: string) => void;
}) {
  const markerId = useId();
  // Requested order, which never moves: the list's own order follows each
  // status change, and a card that jumped sideways on every change would make
  // the arrows unreadable.
  const ordered = useMemo(
    () =>
      [...props.rows].sort((a, b) => {
        const left = a.createdAt ?? "";
        const right = b.createdAt ?? "";
        if (left === right) return a.runId.localeCompare(b.runId);
        return left < right ? -1 : 1;
      }),
    [props.rows],
  );
  // The dock is resizable, so the cards are sized to the room it has now.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number>();
  useEffect(() => {
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setAvailableWidth(Math.floor(width));
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  const layout = useMemo(
    () =>
      layoutAgentRunLayers(
        ordered.map((row) => ({
          id: row.runId,
          after: row.runsAfter.map((run) => run.runId),
          ...(row.parentRunId === undefined ? {} : { startedBy: row.parentRunId }),
        })),
        availableWidth === undefined ? {} : { availableWidth },
      ),
    [ordered, availableWidth],
  );
  const rowById = useMemo(() => new Map(ordered.map((row) => [row.runId, row])), [ordered]);

  return (
    <div className="agent-run-graph__scroll" ref={setScroller}>
      <div
        aria-label="Subagent graph"
        className="agent-run-graph"
        role="group"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          aria-hidden="true"
          className="agent-run-graph__edges"
          height={layout.height}
          width={layout.width}
        >
          <defs>
            <marker
              id={markerId}
              markerHeight="6"
              markerWidth="6"
              orient="auto"
              refX="5"
              refY="3"
              viewBox="0 0 6 6"
            >
              <path d="M 0 0 L 6 3 L 0 6 z" fill="currentColor" />
            </marker>
          </defs>
          {layout.edges.map((edge) => (
            <path
              d={edgePath(edge)}
              data-kind={edge.kind}
              fill="none"
              key={`${edge.fromId}->${edge.toId}`}
              stroke="currentColor"
              strokeWidth="1.25"
              // A wait has a direction, earlier to later, so it gets a head.
              // "Started by" is drawn dashed and headless so the two read apart
              // without relying on a colour.
              {...(edge.kind === "after"
                ? { markerEnd: `url(#${markerId})` }
                : { strokeDasharray: "3 3" })}
            />
          ))}
        </svg>
        {layout.boxes.map((box) => {
          const row = rowById.get(box.id);
          if (row === undefined) return null;
          return (
            <div
              className="agent-run-graph__card"
              data-phase={subagentPhase(row.lifecycleStatus)}
              key={box.id}
              style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            >
              <GraphCard
                row={row}
                {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
                {...(props.providers === undefined ? {} : { providers: props.providers })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GraphCard(props: {
  readonly row: AgentHierarchyRow;
  readonly providers?: ReadonlyMap<string, SubagentProviderIdentity>;
  readonly onOpen?: (runId: string) => void;
}) {
  const { row } = props;
  const provider =
    row.providerInstanceId === undefined ? undefined : props.providers?.get(row.providerInstanceId);
  const how = [row.effort, subagentRoleWord(row.role)].filter(
    (part): part is string => part !== undefined,
  );
  return (
    <OctantButton
      className="agent-run-graph__open"
      data-agent-run-card={row.runId}
      onClick={() => props.onOpen?.(row.runId)}
      title={row.task}
      type="button"
      variant="ghost"
    >
      <span className="agent-run-graph__task">{row.task}</span>
      {row.model === undefined ? null : (
        <span className="agent-run-graph__model">
          {provider === undefined ? null : (
            <ProviderGlyph
              displayName={provider.displayName}
              driverKind={provider.driverKind}
              size={12}
            />
          )}
          <span className="agent-run-graph__model-name">{row.model}</span>
        </span>
      )}
      <span className="agent-run-graph__meta">{how.join(" · ")}</span>
      <span className="agent-run-graph__state">
        <SubagentStatusIcon lifecycleStatus={row.lifecycleStatus} />
        <span className="agent-run-graph__state-text">{stateLine(row)}</span>
      </span>
      {/* The arrows are drawn, not said; a reader who cannot see them gets the
          same links in words. */}
      {row.runsAfter.length === 0 ? null : (
        <span className="visually-hidden">
          Runs after {row.runsAfter.map((run) => run.task).join(", ")}.
        </span>
      )}
    </OctantButton>
  );
}

/** "Waiting on 2", "Needs review", or the state and how long ago it changed. */
function stateLine(row: AgentHierarchyRow): string {
  if (row.waitingOn !== undefined && row.waitingOn > 0) return `Waiting on ${row.waitingOn}`;
  if (row.needsReview) return "Needs review";
  return `${subagentStatusWord(row.lifecycleStatus)} · ${relativeTimeLabel(row.updatedAt)}`;
}

function edgePath(edge: AgentRunLayerEdge): string {
  const bend = (edge.y2 - edge.y1) / 2;
  return `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.y1 + bend}, ${edge.x2} ${edge.y2 - bend}, ${edge.x2} ${edge.y2}`;
}
