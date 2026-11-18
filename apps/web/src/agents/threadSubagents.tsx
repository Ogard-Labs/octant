import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { readableModelId } from "../providers/providerModelLabel";
import { isActiveAgentHierarchyStatus } from "./buildAgentHierarchyModel";
import { SubagentProviderMark, useSubagentProviders } from "./subagentProviders";
import { buildSubagentRows, type SubagentRow } from "./subagentRows";
import { SubagentStatusIcon, subagentStatusWord } from "./subagentStatus";
import { useChildRunStatus, type ChildRunStatusController } from "./useChildRunStatus";
import "./agent-hierarchy.css";
import "./thread-subagents.css";

/**
 * One read of a thread's subagents, shared by everything in its pane: the
 * composer's tray and the rows in the transcript. Each used to be its own
 * one-second poll of the same parent summary.
 */
export const ThreadSubagentsContext = createContext<ChildRunStatusController | undefined>(
  undefined,
);

export function ThreadSubagentsProvider(props: {
  readonly client: AgentRunClient;
  readonly threadId: string;
  readonly children: ReactNode;
}) {
  const subagents = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  return <ThreadSubagentsContext value={subagents}>{props.children}</ThreadSubagentsContext>;
}

/**
 * The span of the thread a turn owns: from its start until the next turn
 * starts. A subagent belongs to the turn that was running when it started,
 * because the host links a subagent to its parent thread, not to a turn.
 */
export interface TurnSubagentWindow {
  readonly from: string;
  /** Absent for the thread's latest turn, which owns everything after it. */
  readonly until?: string;
}

/** When a subagent started: the run's request, or the first sight of a provider's own. */
export function subagentStartedAt(row: SubagentRow): string {
  return row.kind === "octant-started"
    ? (row.entry.createdAt ?? row.updatedAt)
    : row.child.firstObservedAt;
}

export function subagentRowsInWindow(
  rows: ReadonlyArray<SubagentRow>,
  window: TurnSubagentWindow,
): ReadonlyArray<SubagentRow> {
  const from = Date.parse(window.from);
  const until = window.until === undefined ? Number.POSITIVE_INFINITY : Date.parse(window.until);
  if (!Number.isFinite(from)) return [];
  return rows.filter((row) => {
    const started = Date.parse(subagentStartedAt(row));
    return Number.isFinite(started) && started >= from && started < until;
  });
}

const EFFORT_WORDS: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * "Sonnet 5.5 High": the model, then the effort the run was asked for when the
 * host recorded one. A model no catalogue named reads as words rather than an
 * id. A run that reported no model shows none, never its parent's, and the
 * row says nothing in that place rather than "Model unknown".
 */
export function subagentModelLabel(row: SubagentRow): string {
  if (row.model === MODEL_UNKNOWN) return "";
  const effort =
    row.kind === "octant-started" && row.entry.normalizedReasoning !== undefined
      ? (EFFORT_WORDS[row.entry.normalizedReasoning] ?? row.entry.normalizedReasoning)
      : undefined;
  const model = readableModelId(row.model);
  return effort === undefined ? model : `${model} ${effort}`;
}

/** What the shared row model says when the host reported no model. */
const MODEL_UNKNOWN = "Model unknown";

/**
 * The one line under the name: what the subagent is doing or what it found.
 * An observed child reports its own progress; a run Octant started reports
 * its result once it has one, and its state until then.
 */
export function subagentLatestLine(row: SubagentRow): string {
  const text =
    row.kind === "provider-started"
      ? (row.child.finalSummary ?? row.child.latestSummary)
      : row.entry.result?.text;
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line ?? subagentStatusWord(row.lifecycleStatus);
}

/** "5m 21s", "17s", "1h 4m": how long the subagent ran, or has run so far. */
export function subagentRunLabel(row: SubagentRow, now: number): string {
  const started = Date.parse(subagentStartedAt(row));
  const ended = isActiveAgentHierarchyStatus(row.lifecycleStatus) ? now : Date.parse(row.updatedAt);
  const seconds = Math.max(0, Math.floor((ended - started) / 1_000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The task's first line, the row's name, as the agent that started it put it. */
function subagentName(row: SubagentRow): string {
  return (
    row.task
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? row.task
  );
}

/**
 * The subagents a turn started, one quiet row each, under the turn's own
 * activity: who runs it (the provider's logo), what it was asked, its latest
 * line, the model and effort, how long it ran, and its state. They are read
 * from the pane's shared read, so a turn outside a pane that has one draws
 * nothing.
 */
export function TurnSubagentRows(props: { readonly window: TurnSubagentWindow }) {
  const subagents = useContext(ThreadSubagentsContext);
  const providers = useSubagentProviders();
  const rows =
    subagents === undefined || subagents.status !== "ready"
      ? []
      : subagentRowsInWindow(
          buildSubagentRows({
            entries: subagents.entries,
            observations: subagents.observations,
            ...(providers === undefined ? {} : { providers }),
          }),
          props.window,
        );
  const live = rows.some((row) => isActiveAgentHierarchyStatus(row.lifecycleStatus));
  const now = useNow(live);
  if (rows.length === 0) return null;
  return (
    <ul aria-label="Subagents" className="turn-subagents">
      {rows.map((row) => {
        const name = subagentName(row);
        const latest = subagentLatestLine(row);
        const model = subagentModelLabel(row);
        const ran = subagentRunLabel(row, now);
        const status = subagentStatusWord(row.lifecycleStatus);
        return (
          <li
            aria-label={[
              name,
              model === "" ? row.providerName : `${row.providerName} ${model}`,
              status,
              ran,
            ]
              .filter((part) => part !== "")
              .join(", ")}
            className="turn-subagents__row"
            data-status={row.lifecycleStatus}
            key={row.id}
          >
            <span aria-hidden="true" className="turn-subagents__mark">
              <SubagentProviderMark
                driverKind={row.driverKind}
                providerName={row.providerName}
                size={14}
              />
            </span>
            <span aria-hidden="true" className="turn-subagents__name" title={row.task}>
              {name}
            </span>
            <span aria-hidden="true" className="turn-subagents__latest" title={latest}>
              {latest}
            </span>
            <span aria-hidden="true" className="turn-subagents__model">
              {model}
            </span>
            <span aria-hidden="true" className="turn-subagents__time">
              {ran}
            </span>
            <span aria-hidden="true" className="turn-subagents__status">
              <SubagentStatusIcon lifecycleStatus={row.lifecycleStatus} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The current time, ticking once a second while a subagent is still running. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    return scheduleVisibleInterval(() => setNow(Date.now()), 1_000);
  }, [live]);
  return now;
}
