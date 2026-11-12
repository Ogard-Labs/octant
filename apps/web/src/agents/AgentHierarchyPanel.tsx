import type { AgentObservedChild } from "@octant/contracts";
import { ObservedChildRow } from "./ObservedChildActivity";
import { useMemo } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { AgentRunDependencyGraph, type SubagentProviderIdentity } from "./AgentRunDependencyGraph";
import {
  buildAgentHierarchyModel,
  isActiveAgentHierarchyStatus,
  type AgentHierarchyInputEntry,
  type AgentHierarchyRow,
  type AgentRunGraphRow,
} from "./buildAgentHierarchyModel";
import { SubagentStatusIcon, subagentRoleWord, subagentStatusWord } from "./subagentStatus";
import { useDockBarControls } from "../shell/dockBarControls";
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
 *
 * Graph is the same rows arranged by what waits for what. It is offered when
 * the caller keeps the choice (`onViewChange`), and a card opens the page a
 * row does.
 */
export type AgentHierarchyView = "list" | "graph";

const VIEWS = [
  { value: "list", label: "List" },
  { value: "graph", label: "Graph" },
] as const;

/**
 * A worker thread a coordinator started, as the window's own thread list names
 * it, with the runs the host let this window see.
 */
export interface SubagentWorker {
  readonly threadId: string;
  readonly title: string;
  readonly provider?: SubagentProviderIdentity;
  readonly state: "working" | "attention" | "done" | "idle";
  readonly runs: ReadonlyArray<AgentRunGraphRow>;
  /** The worker has more runs than the host listed. */
  readonly runsTruncated: boolean;
}

/** A worker as the window's thread list names it, before the host's run facts are joined. */
export type SubagentWorkerThread = Omit<SubagentWorker, "runs" | "runsTruncated">;

const WORKER_STATE_WORDS: Readonly<Record<SubagentWorker["state"], string>> = {
  working: "Working",
  attention: "Needs attention",
  done: "Done",
  idle: "Idle",
};

export function AgentHierarchyPanel(props: {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly observations?: ReadonlyArray<AgentObservedChild>;
  readonly observationsTruncated?: boolean;
  readonly creationPosture?: "off" | "ask" | "automatic";
  readonly reconnecting?: boolean;
  readonly onOpen?: (runId: string) => void;
  readonly view?: AgentHierarchyView;
  readonly onViewChange?: (view: AgentHierarchyView) => void;
  /** Provider instances by id, so a graph card can draw the mark of what ran it. */
  readonly providers?: ReadonlyMap<string, SubagentProviderIdentity>;
  /** On a coordinator: the workers it started. Absent on every other thread. */
  readonly workers?: ReadonlyArray<SubagentWorker>;
  readonly onOpenWorker?: (threadId: string) => void;
  /** Said under the Workers heading when the host would not answer for their runs. */
  readonly workersNotice?: string;
}) {
  const model = useMemo(
    () =>
      buildAgentHierarchyModel({
        entries: props.entries,
        ...(props.creationPosture === undefined ? {} : { creationPosture: props.creationPosture }),
      }),
    [props.entries, props.creationPosture],
  );

  const onViewChange = props.onViewChange;
  const graphRows = useMemo(() => [...model.working, ...model.finished], [model]);
  // An observed child has no dependency facts, so a thread with only those
  // has nothing to arrange and keeps the list.
  const showGraph = props.view === "graph" && graphRows.length > 0;
  const workers = props.workers ?? [];
  // A coordinator hands most of its work to workers, so their runs are a
  // reason to offer the graph even when it delegated nothing itself.
  const anythingToArrange = graphRows.length > 0 || workers.some((w) => w.runs.length > 0);

  // The view switch is navigation, so where a bar or the single row hosts it
  // it stands there in words; the tool's name is the bar's, so the heading goes.
  const switchable = onViewChange !== undefined && anythingToArrange;
  const hosted = useDockBarControls(
    switchable
      ? [
          {
            kind: "choice",
            id: "view",
            label: "View",
            options: VIEWS.map((view) => ({ id: view.value, label: view.label })),
            value: props.view ?? "list",
            onChange: (value) => {
              const selected = VIEWS.find((view) => view.value === value);
              if (selected !== undefined) onViewChange(selected.value);
            },
          },
        ]
      : [],
  );
  return (
    <section
      aria-label="Subagents"
      className={`agent-hierarchy ${props.reconnecting ? "agent-hierarchy--reconnecting" : ""}`}
    >
      {hosted !== undefined ? null : (
        <header className="agent-hierarchy__header">
          <h2>Subagents</h2>
          {onViewChange === undefined || !anythingToArrange ? null : (
            <OctantToggleGroup<AgentHierarchyView>
              aria-label="View"
              className="segmented"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected !== undefined) onViewChange(selected);
              }}
              value={[props.view ?? "list"]}
            >
              {VIEWS.map((view) => (
                <OctantToggleGroupItem className="segment" key={view.value} value={view.value}>
                  {view.label}
                </OctantToggleGroupItem>
              ))}
            </OctantToggleGroup>
          )}
        </header>
      )}

      {props.reconnecting ? (
        <p className="agent-hierarchy__banner" role="status">
          Reconnecting… showing the last list the host sent.
        </p>
      ) : null}

      {/* A coordinator with workers is not empty: saying "No subagents yet"
          above rows that count their subagents would contradict them. */}
      {model.emptyReason === undefined ||
      (props.observations?.length ?? 0) > 0 ||
      workers.length > 0 ? null : (
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
      {showGraph ? (
        <AgentRunDependencyGraph
          rows={graphRows}
          {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
          {...(props.providers === undefined ? {} : { providers: props.providers })}
        />
      ) : (
        <>
          <AgentHierarchySection label="Working" onOpen={props.onOpen} rows={model.working} />
          <AgentHierarchySection label="Finished" onOpen={props.onOpen} rows={model.finished} />
        </>
      )}
      {workers.length === 0 ? null : (
        <section aria-label="Workers" className="agent-hierarchy__section">
          <h3>Workers · {workers.length}</h3>
          {props.workersNotice === undefined ? null : (
            <p className="agent-hierarchy__banner" role="status">
              {props.workersNotice}
            </p>
          )}
          <ul className="agent-hierarchy__list">
            {workers.map((worker) => (
              <li className="agent-hierarchy__row agent-hierarchy__worker" key={worker.threadId}>
                <WorkerRow
                  graph={props.view === "graph"}
                  onOpenWorker={props.onOpenWorker}
                  providers={props.providers}
                  worker={worker}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/**
 * One worker: a row that opens its thread, and in Graph its subagents drawn
 * under it. The host lets a coordinator's window see that those runs exist and
 * where they stand, not what they said, so every card here opens the worker,
 * where its subagents' pages and controls are.
 */
function WorkerRow(props: {
  readonly worker: SubagentWorker;
  readonly graph: boolean;
  readonly providers: ReadonlyMap<string, SubagentProviderIdentity> | undefined;
  readonly onOpenWorker: ((threadId: string) => void) | undefined;
}) {
  const { worker } = props;
  const open = () => props.onOpenWorker?.(worker.threadId);
  return (
    <>
      <OctantButton
        className="agent-hierarchy__open"
        onClick={open}
        title={worker.title}
        type="button"
        variant="ghost"
      >
        {worker.provider === undefined ? null : (
          <ProviderGlyph
            className="agent-hierarchy__worker-mark"
            displayName={worker.provider.displayName}
            driverKind={worker.provider.driverKind}
            size={14}
          />
        )}
        <span className="agent-hierarchy__row-text">
          <span className="agent-hierarchy__task">{worker.title}</span>
          <span className="agent-hierarchy__meta">{workerFacts(worker)}</span>
        </span>
      </OctantButton>
      {props.graph && worker.runs.length > 0 ? (
        <AgentRunDependencyGraph
          label={`Subagents of ${worker.title}`}
          onOpen={open}
          rows={worker.runs}
          {...(props.providers === undefined ? {} : { providers: props.providers })}
        />
      ) : null}
      {worker.runsTruncated ? (
        <p className="agent-hierarchy__banner">Its earlier subagents are not listed.</p>
      ) : null}
    </>
  );
}

/** "Working · 3 subagents · 1 working": the thread's state, then what it handed off. */
function workerFacts(worker: SubagentWorker): string {
  const working = worker.runs.filter((run) =>
    isActiveAgentHierarchyStatus(run.lifecycleStatus),
  ).length;
  return [
    WORKER_STATE_WORDS[worker.state],
    worker.runs.length === 0
      ? undefined
      : `${worker.runs.length} ${worker.runs.length === 1 ? "subagent" : "subagents"}`,
    working === 0 ? undefined : `${working} working`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
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
