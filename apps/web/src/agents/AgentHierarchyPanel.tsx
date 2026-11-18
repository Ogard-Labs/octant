import type { AgentObservedChild } from "@octant/contracts";
import { ObservedChildRow } from "./ObservedChildActivity";
import { useMemo } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { SubagentProviderMark, useSubagentProviders } from "./subagentProviders";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { Bot } from "../ui/icons";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { AgentRunDependencyGraph, type SubagentProviderIdentity } from "./AgentRunDependencyGraph";
import {
  buildAgentHierarchyModel,
  isActiveAgentHierarchyStatus,
  type AgentHierarchyInputEntry,
  type AgentHierarchyRow,
  type AgentRunGraphRow,
} from "./buildAgentHierarchyModel";
import {
  SubagentStatusIcon,
  subagentElapsedLabel,
  subagentRoleWord,
  subagentStatusWord,
} from "./subagentStatus";
import { AgentResultPreview, latestResultPacket } from "./AgentRunResults";
import {
  buildSubagentRows,
  groupSubagentRows,
  isActiveSubagentRow,
  nestSubagentRows,
  subagentRunTime,
  type SubagentCompareGroup,
  type SubagentListItem,
  type SubagentRow,
} from "./subagentRows";
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
  /** The model the worker runs on, by name. */
  readonly model?: string;
  /** Why the host did not start the role's main model, or the coordinator's why. */
  readonly choiceNote?: string;
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

  const observations = props.observations ?? NO_OBSERVATIONS;
  const providers = useSubagentProviders(props.providers);
  const rows = useMemo(
    () =>
      buildSubagentRows({
        entries: props.entries,
        observations,
        ...(providers === undefined ? {} : { providers }),
      }),
    [props.entries, observations, providers],
  );
  const sections = useMemo(() => subagentSections(rows), [rows]);
  const managedRows = useMemo(
    () => new Map([...model.working, ...model.finished].map((row) => [row.runId, row])),
    [model],
  );

  const onViewChange = props.onViewChange;
  // A provider-started subagent has no dependency facts: it is a leaf card
  // under whichever subagent started it, with no arrows of its own.
  const graphRows = useMemo(
    () => [
      ...model.working,
      ...model.finished,
      ...rows.flatMap(
        (row): ReadonlyArray<AgentRunGraphRow> =>
          row.kind === "provider-started" ? [providerStartedGraphRow(row)] : [],
      ),
    ],
    [model, rows],
  );
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
      {hosted !== undefined ? (
        <h2 className="visually-hidden">Subagents</h2>
      ) : (
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
      {model.empty === undefined || rows.length > 0 || workers.length > 0 ? null : (
        // The shared state every pane with nothing to show uses: the mark, the
        // line and one muted line, centred in a pane.
        <OctantEmpty
          detail={model.empty.detail}
          icon={<Bot size={16} />}
          layout="line"
          title={model.empty.title}
        />
      )}

      {props.observationsTruncated ? (
        <p className="agent-hierarchy__banner">Earlier observed children are not retained.</p>
      ) : null}
      {showGraph ? (
        <AgentRunDependencyGraph
          rows={graphRows}
          {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
          {...(providers === undefined ? {} : { providers })}
        />
      ) : (
        <>
          <AgentHierarchySection
            items={sections.working}
            label="Working"
            managedRows={managedRows}
            onOpen={props.onOpen}
          />
          <AgentHierarchySection
            items={sections.finished}
            label="Finished"
            managedRows={managedRows}
            onOpen={props.onOpen}
          />
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
                  providers={providers}
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
          <SubagentProviderMark
            className="agent-hierarchy__worker-mark"
            driverKind={worker.provider.driverKind}
            providerName={worker.provider.displayName}
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
    worker.model,
    worker.choiceNote,
    worker.runs.length === 0
      ? undefined
      : `${worker.runs.length} ${worker.runs.length === 1 ? "subagent" : "subagents"}`,
    working === 0 ? undefined : `${working} working`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

const NO_OBSERVATIONS: ReadonlyArray<AgentObservedChild> = [];

/**
 * Working leads in the host's order, so a row does not jump as its status
 * changes; Finished follows newest first. In each, a subagent sits under the
 * one that started it, and a compare group is listed once.
 */
function subagentSections(rows: ReadonlyArray<SubagentRow>): {
  readonly working: ReadonlyArray<SubagentListItem>;
  readonly finished: ReadonlyArray<SubagentListItem>;
} {
  const groups = new Set(
    groupSubagentRows(rows).flatMap((item) => (item.kind === "group" ? [item.label] : [])),
  );
  // A compare group stays whole in one section: Working while any member works.
  const groupWorking = new Set(
    rows.flatMap((row) =>
      row.kind === "octant-started" &&
      row.compareGroup !== undefined &&
      groups.has(row.compareGroup) &&
      isActiveSubagentRow(row)
        ? [row.compareGroup]
        : [],
    ),
  );
  const working = (row: SubagentRow) =>
    row.kind === "octant-started" && row.compareGroup !== undefined && groups.has(row.compareGroup)
      ? groupWorking.has(row.compareGroup)
      : isActiveSubagentRow(row);
  const finished = rows
    .filter((row) => !working(row))
    .sort((a, b) => {
      if (a.updatedAt === b.updatedAt) return a.id.localeCompare(b.id);
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  return {
    working: groupSubagentRows(nestSubagentRows(rows.filter(working))),
    finished: groupSubagentRows(nestSubagentRows(finished)),
  };
}

/** A provider-started subagent as a graph card: what started it, and no links. */
function providerStartedGraphRow(
  row: Extract<SubagentRow, { kind: "provider-started" }>,
): AgentRunGraphRow {
  return {
    runId: row.id,
    ...(row.parentId === undefined ? {} : { parentRunId: row.parentId }),
    role: "",
    task: row.task,
    lifecycleStatus: row.lifecycleStatus,
    needsReview: false,
    model: row.model,
    ...(row.providerInstanceId === undefined ? {} : { providerInstanceId: row.providerInstanceId }),
    startedByProvider: row.providerName,
    runsAfter: [],
    createdAt: row.child.firstObservedAt,
    updatedAt: row.updatedAt,
  };
}

function AgentHierarchySection(props: {
  readonly label: string;
  readonly items: ReadonlyArray<SubagentListItem>;
  readonly managedRows: ReadonlyMap<string, AgentHierarchyRow>;
  readonly onOpen: ((runId: string) => void) | undefined;
}) {
  if (props.items.length === 0) return null;
  const count = props.items.reduce(
    (total, item) => total + (item.kind === "group" ? item.members.length : 1),
    0,
  );
  return (
    <section aria-label={props.label} className="agent-hierarchy__section">
      <h3>
        {props.label} · {count}
      </h3>
      <ul className="agent-hierarchy__list">
        {props.items.map((item) => {
          if (item.kind === "group") {
            return (
              <li
                className="agent-hierarchy__row"
                key={`group:${item.label}`}
                style={{ paddingInlineStart: `${(item.members[0]?.depth ?? 0) * 16}px` }}
              >
                <CompareGroup group={item} onOpen={props.onOpen} />
              </li>
            );
          }
          const row = item.row;
          return (
            <li
              className="agent-hierarchy__row"
              key={row.id}
              // Nesting is whatever parent the host or runtime reported; the
              // indent is the only place it shows.
              style={{ paddingInlineStart: `${row.depth * 16}px` }}
            >
              {row.kind === "provider-started" ? (
                <ObservedChildRow
                  child={row.child}
                  runTime={subagentRunTime(row, Date.now())}
                  providerName={row.providerName}
                  model={row.model}
                  {...(row.driverKind === undefined ? {} : { driverKind: row.driverKind })}
                  {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
                />
              ) : (
                <ManagedRow
                  onOpen={props.onOpen}
                  row={row}
                  {...(props.managedRows.get(row.id) === undefined
                    ? {}
                    : { facts: props.managedRows.get(row.id) })}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ManagedRow(props: {
  readonly row: Extract<SubagentRow, { kind: "octant-started" }>;
  readonly facts?: AgentHierarchyRow | undefined;
  readonly onOpen: ((runId: string) => void) | undefined;
}) {
  const { row } = props;
  return (
    <OctantButton
      className="agent-hierarchy__open"
      onClick={() => props.onOpen?.(row.id)}
      title={row.task}
      type="button"
      variant="ghost"
    >
      <SubagentStatusIcon lifecycleStatus={row.lifecycleStatus} />
      <SubagentProviderMark
        className="agent-hierarchy__worker-mark"
        driverKind={row.driverKind}
        providerName={row.providerName}
        size={14}
      />
      <span className="agent-hierarchy__row-text">
        <span className="agent-hierarchy__task">{row.task}</span>
        <span className="agent-hierarchy__meta">{rowFacts(row)}</span>
      </span>
      {props.facts?.needsReview === true ? (
        <span className="agent-hierarchy__flag">Needs review</span>
      ) : null}
    </OctantButton>
  );
}

/**
 * Siblings the thread's agent labelled alike, side by side so a person can
 * compare them. The host states facts and ranks nothing, so neither does this:
 * no order but the host's, no winner, no score.
 */
function CompareGroup(props: {
  readonly group: SubagentCompareGroup;
  readonly onOpen: ((runId: string) => void) | undefined;
}) {
  const { group } = props;
  const now = Date.now();
  return (
    <section aria-label={`Compare ${group.label}`} className="agent-hierarchy__compare">
      <h4 className="agent-hierarchy__compare-label">
        Compare · {group.label} · {group.members.length}
      </h4>
      <ul className="agent-hierarchy__compare-members">
        {group.members.map((member) => {
          const result = latestResultPacket(member.entry.resultPackets ?? []);
          return (
            <li className="agent-hierarchy__compare-member" key={member.id}>
              <OctantButton
                className="agent-hierarchy__compare-open"
                onClick={() => props.onOpen?.(member.id)}
                title={member.task}
                type="button"
                variant="ghost"
              >
                <span className="agent-hierarchy__compare-provider">
                  <SubagentProviderMark
                    driverKind={member.driverKind}
                    providerName={member.providerName}
                    size={12}
                  />
                  <span>{member.providerName}</span>
                </span>
                <span className="agent-hierarchy__meta">{member.model}</span>
                <span className="agent-hierarchy__compare-state">
                  <SubagentStatusIcon lifecycleStatus={member.lifecycleStatus} />
                  <span>{subagentStatusWord(member.lifecycleStatus)}</span>
                </span>
                <span className="agent-hierarchy__meta">{durationFact(member, now)}</span>
                <span className="agent-hierarchy__task">{member.task}</span>
                {result === undefined ? null : <AgentResultPreview packet={result} />}
              </OctantButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * "Ran 4m" once settled, from request to last change; "Updated 12s ago"
 * while working. Only what the host recorded, nothing estimated.
 */
function durationFact(row: SubagentRow, now: number): string {
  const createdAt = row.kind === "octant-started" ? row.entry.createdAt : undefined;
  if (!isActiveSubagentRow(row) && createdAt !== undefined) {
    const ran = subagentElapsedLabel(createdAt, Date.parse(row.updatedAt));
    if (ran !== "") return `Ran ${ran}`;
  }
  const since = subagentElapsedLabel(row.updatedAt, now);
  return since === "" ? "Time unavailable" : `Updated ${since} ago`;
}

/** "Done · Review · Codex · gpt-6-astra · 3m ago": state in words first, then what ran it. */
function rowFacts(row: Extract<SubagentRow, { kind: "octant-started" }>): string {
  return [
    subagentStatusWord(row.lifecycleStatus),
    subagentRoleWord(row.entry.role),
    row.providerName,
    row.model,
    relativeTimeLabel(row.updatedAt),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}
