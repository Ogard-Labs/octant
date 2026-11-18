import type { AgentObservedChild } from "@octant/contracts";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { ChevronDown, X } from "../ui/icons";
import { useContext, useEffect, useId, useMemo, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import {
  isActiveAgentHierarchyStatus,
  subagentNeedsReview,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";
import { SubagentStatusIcon, subagentStatusWord } from "./subagentStatus";
import { AgentResultPreview, latestResultPacket } from "./AgentRunResults";
import { ObservedChildRow, type ObservedChildClient } from "./ObservedChildActivity";
import type { SubagentProviderIdentity } from "./AgentRunDependencyGraph";
import { SubagentProviderMark, useSubagentProviders } from "./subagentProviders";
import {
  buildSubagentRows,
  groupSubagentRows,
  isActiveSubagentRow,
  subagentRunTime,
  subagentStartedAt,
  type SubagentListItem,
  type SubagentRow,
} from "./subagentRows";
import { useChildRunStatus, type ChildRunStatusController } from "./useChildRunStatus";
import { ThreadSubagentsContext } from "./threadSubagents";
import "./agent-hierarchy.css";
import { OctantAlert } from "../ui/base/OctantAlert";
import { ChildRunRequests, type ChildRunInteractionsClient } from "./ChildRunRequests";
import { ThreadConnectionLostContext } from "../transcript/ThreadConnectionNotice";

/**
 * One thread's subagents, read for the composer of the pane that shows it.
 *
 * A separate component so the hook runs only where a composer actually
 * renders the tray: a thread that is still loading, or has no composer, reads
 * nothing.
 */
export function ThreadSubagentsTray(props: {
  readonly client: AgentRunClient;
  readonly threadId: string;
  readonly interactionsClient?: ChildRunInteractionsClient;
  /** Opens the Agents tool; with a run id, on that subagent's conversation. */
  readonly onOpenSubagent?: (runId?: string) => void;
}) {
  // The pane's shared read, when the pane holds one: the transcript's rows
  // read the same one.
  const shared = useContext(ThreadSubagentsContext);
  return shared === undefined ? (
    <OwnThreadSubagentsTray {...props} />
  ) : (
    <ThreadSubagentsTrayBody {...props} subagents={shared} />
  );
}

/** A tray outside a pane that reads its thread's subagents reads them itself. */
function OwnThreadSubagentsTray(props: Parameters<typeof ThreadSubagentsTray>[0]) {
  const subagents = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  return <ThreadSubagentsTrayBody {...props} subagents={subagents} />;
}

function ThreadSubagentsTrayBody(
  props: Parameters<typeof ThreadSubagentsTray>[0] & {
    readonly subagents: ChildRunStatusController;
  },
) {
  // The thread already says its host connection is lost; the tray dims and
  // disables its controls rather than saying so a second time.
  const connectionLost = useContext(ThreadConnectionLostContext);
  const subagents = props.subagents;
  if (subagents.status !== "ready") return null;
  return (
    <>
      {props.interactionsClient === undefined ||
      !subagents.entries.some((entry) =>
        isActiveAgentHierarchyStatus(entry.lifecycleStatus),
      ) ? null : (
        <ChildRunRequests
          client={props.interactionsClient}
          disconnected={connectionLost || subagents.reconnecting}
          threadId={props.threadId}
          entries={subagents.entries}
          {...(props.onOpenSubagent === undefined ? {} : { onOpenSubagent: props.onOpenSubagent })}
        />
      )}
      <SubagentsTray
        busy={subagents.busy}
        entries={subagents.entries}
        observations={subagents.observations}
        observationsTruncated={subagents.observationsTruncated}
        {...(subagents.errorMessage === undefined ? {} : { errorMessage: subagents.errorMessage })}
        {...(props.onOpenSubagent === undefined ? {} : { onOpenSubagent: props.onOpenSubagent })}
        onStop={(runId) => void subagents.cancelRun(runId)}
        onStopAll={() => void subagents.stopAll()}
        stopClient={props.client}
        reconnecting={subagents.reconnecting || connectionLost}
      />
    </>
  );
}

export interface SubagentsTrayProps {
  readonly observations?: ReadonlyArray<AgentObservedChild>;
  readonly observationsTruncated?: boolean;
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  /** Provider instances by id, so a row can name and draw what ran it. */
  readonly providers?: ReadonlyMap<string, SubagentProviderIdentity>;
  readonly onOpenSubagent?: (runId?: string) => void;
  /** Cancels one named subagent; it names its target, so it needs no confirmation. */
  readonly onStop: (runId: string) => void;
  /** Cancels every active subagent on the thread. Already confirmed when called. */
  readonly onStopAll: () => void;
  /** Stops one provider-native subagent where the host offers it. */
  readonly stopClient?: ObservedChildClient;
  readonly busy?: boolean;
  /**
   * What is shown is the last status the host reported. The tray dims and stops
   * offering Stop; it does not say why, because the thread's connection notice
   * already does and a second voice made one condition read as two.
   */
  readonly reconnecting?: boolean;
  readonly errorMessage?: string;
  /** Injectable for tests; defaults to `window.localStorage` when available. */
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

const OPEN_KEY = "octant.composer-subagents.open";
const NO_OBSERVATIONS: ReadonlyArray<AgentObservedChild> = [];

/**
 * Keep attention and result counts visible even when folded. Preview only
 * three active or unreviewed children; the full history stays in Agents so
 * completed work remains reachable without growing over the transcript.
 */
export function SubagentsTray(props: SubagentsTrayProps) {
  const listId = useId();
  const [confirming, setConfirming] = useState(false);
  const storage = props.storage ?? browserStorage();
  const [open, setOpen] = useState(() => readOpen(storage));
  // The host's order, so a row does not jump as its status changes.
  const working = props.entries.filter(
    (entry) =>
      entry.executionKind === "octant-managed" &&
      isActiveAgentHierarchyStatus(entry.lifecycleStatus),
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
  const candidates = trayCandidates(rows);
  const preview = candidates.slice(0, 3);
  const stale = props.reconnecting === true;
  const total = props.entries.length + observations.length;
  const now = useNow(preview.length > 0 && open);
  if (total === 0 && props.errorMessage === undefined) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setConfirming(false);
    writeOpen(storage, next);
  };
  const count = trayStatus(props.entries, observations, props.observationsTruncated === true);
  const waitingOn = open ? undefined : waitingRows(props.entries, observations, rows);

  return (
    <div
      aria-label="Subagents"
      className="composer-subagents"
      data-open={open ? "true" : "false"}
      data-stale={stale ? "true" : "false"}
      role="group"
    >
      <div className="composer-subagents__head">
        <OctantButton
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`Subagents, ${count}. ${open ? "Hide" : "Show"} them`}
          className="composer-subagents__toggle"
          onClick={toggle}
          size="xs"
          type="button"
          variant="ghost"
        >
          <span className="composer-subagents__label">Subagents</span>
          {waitingOn === undefined ? (
            <span className="composer-subagents__count">{count}</span>
          ) : null}
          <ChevronDown aria-hidden="true" className="composer-subagents__chevron" size={12} />
        </OctantButton>
        {waitingOn === undefined ? null : (
          <WaitingLine rows={waitingOn} onOpenSubagent={props.onOpenSubagent} />
        )}
        {props.onOpenSubagent === undefined ? null : (
          <OctantButton
            aria-label={`View all ${total} subagents in Agents`}
            className="composer-subagents__all"
            onClick={() => props.onOpenSubagent?.()}
            size="xs"
            type="button"
            variant="ghost"
          >
            View all
          </OctantButton>
        )}
      </div>

      {open ? (
        <div id={listId} className="composer-subagents__body">
          {working.length > 1 && !confirming ? (
            <OctantButton
              disabled={props.busy === true || stale}
              onClick={() => setConfirming(true)}
              size="xs"
              type="button"
              variant="ghost"
            >
              Stop all
            </OctantButton>
          ) : null}
          {confirming && working.length > 1 ? (
            <div
              aria-label="Confirm stopping subagents"
              className="composer-subagents__confirm"
              role="group"
            >
              <p>
                Stop all {working.length} managed subagents on this thread? Their work is cancelled
                and cannot be resumed.
              </p>
              <p className="composer-subagents__confirm-scope">
                Only this thread&apos;s helpers are affected.
              </p>
              <div className="composer-subagents__confirm-actions">
                <OctantButton
                  disabled={props.busy === true}
                  onClick={() => {
                    setConfirming(false);
                    props.onStopAll();
                  }}
                  size="xs"
                  type="button"
                  variant="destructive"
                >
                  Stop {working.length} subagents
                </OctantButton>
                <OctantButton
                  onClick={() => setConfirming(false)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Keep running
                </OctantButton>
              </div>
            </div>
          ) : null}

          {preview.length > 0 ? (
            <ul className="composer-subagents__list">
              {preview.map((item) =>
                item.kind === "group" ? (
                  <CompareGroupTrayRow
                    item={item}
                    key={`group:${item.label}`}
                    {...(props.onOpenSubagent === undefined
                      ? {}
                      : { onOpenSubagent: props.onOpenSubagent })}
                  />
                ) : item.row.kind === "octant-started" ? (
                  <SubagentTrayRow
                    busy={props.busy === true || stale}
                    row={item.row}
                    key={item.row.id}
                    now={now}
                    {...(props.onOpenSubagent === undefined
                      ? {}
                      : { onOpenSubagent: props.onOpenSubagent })}
                    onStop={props.onStop}
                  />
                ) : (
                  <li key={item.row.id} className="composer-subagents__row">
                    <ObservedChildRow
                      child={item.row.child}
                      {...(props.stopClient === undefined ? {} : { client: props.stopClient })}
                      runTime={subagentRunTime(item.row, now)}
                      providerName={item.row.providerName}
                      model={item.row.model}
                      {...(item.row.driverKind === undefined
                        ? {}
                        : { driverKind: item.row.driverKind })}
                      {...(props.onOpenSubagent === undefined
                        ? {}
                        : { onOpen: props.onOpenSubagent })}
                    />
                    {/* A provider-started subagent offers no managed controls;
                        a stop the runtime itself supports belongs here. */}
                  </li>
                ),
              )}
            </ul>
          ) : null}
          {candidates.length > preview.length ? (
            <p className="composer-subagents__notice">
              Showing {preview.length} of {candidates.length} active or unresolved subagents. Open
              Agents for the full list.
            </p>
          ) : null}
          {candidates.length === 0 ? (
            <p className="composer-subagents__notice">Finished subagents are listed in Agents.</p>
          ) : null}
        </div>
      ) : null}

      {props.observationsTruncated ? (
        <p className="composer-subagents__notice">Earlier observed children are not retained.</p>
      ) : null}
      {props.errorMessage === undefined ? null : (
        <OctantAlert className="composer-subagents__notice" tone="warning">
          {props.errorMessage}
        </OctantAlert>
      )}
    </div>
  );
}

/**
 * The folded head's line while nothing needs the person and children work:
 * what the parent waits on, the two longest-running by name and the rest
 * counted. Each name opens its child, as the rows do.
 */
function WaitingLine(props: {
  readonly rows: ReadonlyArray<SubagentRow>;
  readonly onOpenSubagent?: ((runId?: string) => void) | undefined;
}) {
  const shown = props.rows.slice(0, 2);
  const others = props.rows.length - shown.length;
  const name = (row: SubagentRow) => {
    const label = subagentTaskName(row);
    return props.onOpenSubagent === undefined ? (
      <span className="composer-subagents__name" key={row.id} title={row.task}>
        {label}
      </span>
    ) : (
      <OctantButton
        className="composer-subagents__name composer-subagents__name--link"
        key={row.id}
        onClick={() => props.onOpenSubagent?.(row.id)}
        title={row.task}
        type="button"
        variant="link"
      >
        {label}
      </OctantButton>
    );
  };
  const joiner = (index: number) =>
    index === 0 ? null : (
      <span className="composer-subagents__waiting-text" key={`join:${index}`}>
        {others === 0 && index === shown.length - 1 ? " and " : ", "}
      </span>
    );
  return (
    <span className="composer-subagents__waiting">
      <span className="composer-subagents__waiting-text">Waiting on&nbsp;</span>
      {shown.flatMap((row, index) => [joiner(index), name(row)])}
      {others === 0 ? null : (
        <span className="composer-subagents__waiting-text">
          {` and ${others} other${others === 1 ? "" : "s"}`}
        </span>
      )}
    </span>
  );
}

function subagentTaskName(row: SubagentRow): string {
  return (
    row.task
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? row.task
  );
}

/**
 * The working children to name in the folded head, longest-running first, or
 * nothing when the head must keep its counts: any child that failed, waits,
 * has a result to review, stopped or has no known status is attention, and
 * attention comes first.
 */
function waitingRows(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
  observations: ReadonlyArray<AgentObservedChild>,
  rows: ReadonlyArray<SubagentRow>,
): ReadonlyArray<SubagentRow> | undefined {
  const working = new Set(["queued", "starting", "running"]);
  const quiet = (status: string) => working.has(status) || status === "completed";
  if (
    [...entries, ...observations].some((child) => !quiet(child.lifecycleStatus)) ||
    entries.some((entry) => entry.lifecycleStatus === "completed" && subagentNeedsReview(entry))
  ) {
    return undefined;
  }
  const active = rows.filter((row) => working.has(row.lifecycleStatus));
  if (active.length === 0) return undefined;
  const started = (row: SubagentRow) => {
    const time = Date.parse(subagentStartedAt(row));
    return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
  };
  return [...active].sort((a, b) => started(a) - started(b));
}

function SubagentTrayRow(props: {
  readonly row: Extract<SubagentRow, { kind: "octant-started" }>;
  readonly now: number;
  readonly busy: boolean;
  readonly onOpenSubagent?: (runId?: string) => void;
  readonly onStop: (runId: string) => void;
}) {
  const { row } = props;
  const entry = row.entry;
  const word = subagentStatusWord(entry.lifecycleStatus);
  const ran = subagentRunTime(row, props.now);
  const meta = [
    word,
    subagentNeedsReview(entry) ? "Needs review" : undefined,
    row.providerName,
    row.model,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  // The run time is drawn once, in the trailing slot; the slot is hidden from
  // assistive technology, so the label carries it instead.
  const spoken = ran === "" ? meta : `${meta} · Ran ${ran}`;
  const result = latestResultPacket(entry.resultPackets ?? []);
  const reason = entry.recoveryReason ?? entry.resultAcknowledgement.followUpReason;
  return (
    <li className="composer-subagents__row">
      <OctantButton
        aria-label={`${entry.task}. ${spoken}. ${reason === undefined ? "" : `${reason}. `}Opens it in Agents.`}
        className="composer-subagents__open"
        onClick={() => props.onOpenSubagent?.(entry.runId)}
        size="xs"
        title={entry.task}
        type="button"
        variant="ghost"
      >
        <SubagentStatusIcon lifecycleStatus={entry.lifecycleStatus} />
        <SubagentProviderMark
          driverKind={row.driverKind}
          providerName={row.providerName}
          size={12}
        />
        <span className="composer-subagents__content">
          <span className="composer-subagents__task">{entry.task}</span>
          <span className="composer-subagents__meta">{meta}</span>
          {result === undefined ? null : <AgentResultPreview packet={result} />}
          {reason === undefined ? null : (
            <span className="composer-subagents__reason">{reason}</span>
          )}
        </span>
        <span aria-hidden="true" className="composer-subagents__time">
          {ran}
        </span>
      </OctantButton>
      {entry.executionKind === "octant-managed" &&
      isActiveAgentHierarchyStatus(entry.lifecycleStatus) ? (
        <OctantIconButton
          className="composer-subagents__action"
          disabled={props.busy}
          label={`Stop subagent: ${entry.task}`}
          onClick={() => props.onStop(entry.runId)}
          size="icon-xs"
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </OctantIconButton>
      ) : null}
    </li>
  );
}

/**
 * A compare group is one line here: its label and how many members are in
 * each state. Comparing them side by side is the Agents tool's job.
 */
function CompareGroupTrayRow(props: {
  readonly item: Extract<SubagentListItem, { kind: "group" }>;
  readonly onOpenSubagent?: (runId?: string) => void;
}) {
  const { item } = props;
  const meta = [`${item.members.length} subagents`, ...stateCounts(item.members)].join(" · ");
  return (
    <li className="composer-subagents__row">
      <OctantButton
        aria-label={`Compare ${item.label}. ${meta}. Opens them side by side in Agents.`}
        className="composer-subagents__open"
        onClick={() => props.onOpenSubagent?.()}
        size="xs"
        title={item.label}
        type="button"
        variant="ghost"
      >
        <span className="composer-subagents__content">
          <span className="composer-subagents__task">Compare · {item.label}</span>
          <span className="composer-subagents__meta">{meta}</span>
        </span>
      </OctantButton>
    </li>
  );
}

/** "1 working", "2 done": each state that has members, in the order of the head's line. */
function stateCounts(rows: ReadonlyArray<SubagentRow>): ReadonlyArray<string> {
  const words = new Map<string, number>();
  for (const row of rows) {
    const word = subagentStatusWord(row.lifecycleStatus).toLowerCase();
    words.set(word, (words.get(word) ?? 0) + 1);
  }
  return [...words].map(([word, count]) => `${count} ${word}`);
}

/**
 * What the open tray previews: every subagent still working or asking for the
 * person, whoever started it, with the ones asking for something first. A
 * compare group is listed once, where its first member would be.
 */
function trayCandidates(rows: ReadonlyArray<SubagentRow>): ReadonlyArray<SubagentListItem> {
  const outstanding = (row: SubagentRow) =>
    isActiveSubagentRow(row) || row.needsAttention || row.lifecycleStatus === "unknown";
  const attention = (item: SubagentListItem) =>
    item.kind === "row" ? item.row.needsAttention : item.members.some((row) => row.needsAttention);
  const items = groupSubagentRows(rows).filter((item) =>
    item.kind === "row" ? outstanding(item.row) : item.members.some(outstanding),
  );
  return [...items.filter(attention), ...items.filter((item) => !attention(item))];
}

/**
 * The head's one line: every state the thread's children are in, what needs
 * the person first. Each count names a state, so nothing reads as an unexplained
 * total, and a result the parent already holds is just "done".
 */
function trayStatus(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
  observations: ReadonlyArray<AgentObservedChild>,
  truncated: boolean,
): string {
  const children = [...entries, ...observations];
  const count = (status: string) =>
    children.filter((child) => child.lifecycleStatus === status).length;
  const review = entries.filter(
    (entry) => entry.lifecycleStatus === "completed" && subagentNeedsReview(entry),
  ).length;
  const known = new Set([
    "failed",
    "waiting",
    "interrupted",
    "cancelled",
    "queued",
    "starting",
    "running",
    "completed",
  ]);
  const unknown = children.filter((child) => !known.has(child.lifecycleStatus)).length;
  const working = count("queued") + count("starting") + count("running");
  const stopped = count("interrupted") + count("cancelled");
  const parts = [
    count("failed") > 0 ? `${count("failed")} failed` : undefined,
    count("waiting") > 0 ? `${count("waiting")} waiting` : undefined,
    review > 0 ? `${review} to review` : undefined,
    stopped > 0 ? `${stopped} stopped` : undefined,
    unknown > 0 ? `${unknown} status unavailable` : undefined,
    working > 0 ? `${working} working` : undefined,
    count("completed") - review > 0 ? `${count("completed") - review} done` : undefined,
  ].filter((part) => part !== undefined);
  return `${parts.join(" · ")}${truncated ? " · earlier ones not retained" : ""}`;
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Keep the first view compact; preserve a viewer's explicit choice. */
function readOpen(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function writeOpen(storage: Pick<Storage, "setItem"> | undefined, open: boolean): void {
  try {
    storage?.setItem(OPEN_KEY, open ? "true" : "false");
  } catch {
    // A viewer convenience: a private window simply forgets the fold.
  }
}

/**
 * Refresh the update age while preview rows are visible, including finished
 * results awaiting review, without polling the clock for a folded tray.
 */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    return scheduleVisibleInterval(() => setNow(Date.now()), 1_000);
  }, [ticking]);
  return now;
}
