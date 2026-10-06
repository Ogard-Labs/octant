import type { AgentObservedChild } from "@octant/contracts";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { ChevronDown, X } from "lucide-react";
import { useContext, useEffect, useId, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import {
  isActiveAgentHierarchyStatus,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";
import {
  SubagentStatusIcon,
  subagentElapsedLabel,
  subagentModel,
  subagentNeedsReview,
  subagentStatusWord,
} from "./subagentStatus";
import { AgentResultPreview, latestResultPacket } from "./AgentRunResults";
import { ObservedChildRow } from "./ObservedChildActivity";
import { useChildRunStatus } from "./useChildRunStatus";
import "./agent-hierarchy.css";
import { OctantAlert } from "../ui/base/OctantAlert";
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
  readonly interactionsClient?: Pick<NativeHarnessClient, "session">;
  /** Opens the Agents tool; with a run id, on that subagent's conversation. */
  readonly onOpenSubagent?: (runId?: string) => void;
}) {
  // The thread already says its host connection is lost; the tray dims and
  // disables its controls rather than saying so a second time.
  const connectionLost = useContext(ThreadConnectionLostContext);
  const subagents = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  if (subagents.status !== "ready") return null;
  return (
    <>
      {props.interactionsClient === undefined ||
      !subagents.entries.some((entry) =>
        isActiveAgentHierarchyStatus(entry.lifecycleStatus),
      ) ? null : (
        <ChildRunAttention
          client={props.interactionsClient}
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
        reconnecting={subagents.reconnecting || connectionLost}
      />
    </>
  );
}

function ChildRunAttention(props: {
  readonly client: Pick<NativeHarnessClient, "session">;
  readonly threadId: string;
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly onOpenSubagent?: (runId?: string) => void;
}) {
  const [pending, setPending] = useState<{
    readonly threadId: string;
    readonly runIds: ReadonlyArray<string>;
  }>();
  useEffect(() => {
    let active = true;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const view = await props.client.session(props.threadId);
        if (active)
          setPending({
            threadId: props.threadId,
            runIds: [...(view?.approvals ?? []), ...(view?.questions ?? [])]
              .filter((item) => item.status === "pending" && item.source !== undefined)
              .flatMap((item) => (item.source === undefined ? [] : [String(item.source.runId)])),
          });
      } catch {
        // Keep the last observed request reachable while the host reconnects.
      } finally {
        reading = false;
      }
    };
    void refresh();
    const stop = scheduleVisibleInterval(() => void refresh(), 1_500);
    return () => {
      active = false;
      stop();
    };
  }, [props.client, props.threadId]);
  const runId =
    pending?.threadId === props.threadId
      ? pending.runIds.find((id) =>
          props.entries.some(
            (entry) => entry.runId === id && isActiveAgentHierarchyStatus(entry.lifecycleStatus),
          ),
        )
      : undefined;
  if (runId === undefined) return null;
  return (
    <div className="composer-subagents__notice" role="status">
      A subagent needs your input.{" "}
      {props.onOpenSubagent === undefined ? (
        "Open Agents to respond."
      ) : (
        <OctantButton size="xs" variant="link" onClick={() => props.onOpenSubagent?.(runId)}>
          Review request
        </OctantButton>
      )}
    </div>
  );
}

export interface SubagentsTrayProps {
  readonly observations?: ReadonlyArray<AgentObservedChild>;
  readonly observationsTruncated?: boolean;
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly onOpenSubagent?: (runId?: string) => void;
  /** Cancels one named subagent; it names its target, so it needs no confirmation. */
  readonly onStop: (runId: string) => void;
  /** Cancels every active subagent on the thread. Already confirmed when called. */
  readonly onStopAll: () => void;
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
  const outstanding = props.entries.filter(
    (entry) =>
      isActiveAgentHierarchyStatus(entry.lifecycleStatus) ||
      // A child the head counts as failed or interrupted is listed too, with the
      // reason the host recorded, so no count names a child the person cannot find.
      entry.lifecycleStatus === "failed" ||
      entry.lifecycleStatus === "interrupted" ||
      subagentNeedsReview(entry),
  );
  const observations = props.observations ?? [];
  const observedOutstanding = observations.filter((child) => child.lifecycleStatus !== "completed");
  const candidates = [
    ...outstanding.map((entry) => ({ kind: "managed" as const, entry })),
    ...observedOutstanding.map((child) => ({ kind: "observed" as const, child })),
  ];
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
          <span className="composer-subagents__count">{count}</span>
          <ChevronDown aria-hidden="true" className="composer-subagents__chevron" size={12} />
        </OctantButton>
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
                Only this thread&apos;s managed subagents are affected.
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
                item.kind === "managed" ? (
                  <SubagentTrayRow
                    busy={props.busy === true || stale}
                    entry={item.entry}
                    key={item.entry.runId}
                    now={now}
                    {...(props.onOpenSubagent === undefined
                      ? {}
                      : { onOpenSubagent: props.onOpenSubagent })}
                    onStop={props.onStop}
                  />
                ) : (
                  <li
                    key={`observed:${item.child.observationId}`}
                    className="composer-subagents__row"
                  >
                    <ObservedChildRow
                      child={item.child}
                      now={now}
                      {...(props.onOpenSubagent === undefined
                        ? {}
                        : { onOpen: props.onOpenSubagent })}
                    />
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

function SubagentTrayRow(props: {
  readonly entry: AgentHierarchyInputEntry;
  readonly now: number;
  readonly busy: boolean;
  readonly onOpenSubagent?: (runId?: string) => void;
  readonly onStop: (runId: string) => void;
}) {
  const entry = props.entry;
  const word = subagentStatusWord(entry.lifecycleStatus);
  const elapsed = subagentElapsedLabel(entry.updatedAt, props.now);
  const meta = [
    word,
    subagentNeedsReview(entry) ? "Needs review" : undefined,
    subagentModel(entry),
    elapsed === "" ? undefined : `Updated ${elapsed} ago`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  const result = latestResultPacket(entry.resultPackets ?? []);
  const reason = entry.recoveryReason ?? entry.resultAcknowledgement.followUpReason;
  return (
    <li className="composer-subagents__row">
      <OctantButton
        aria-label={`${entry.task}. ${meta}. ${reason === undefined ? "" : `${reason}. `}Opens it in Agents.`}
        className="composer-subagents__open"
        onClick={() => props.onOpenSubagent?.(entry.runId)}
        size="xs"
        title={entry.task}
        type="button"
        variant="ghost"
      >
        <SubagentStatusIcon lifecycleStatus={entry.lifecycleStatus} />
        <span className="composer-subagents__content">
          <span className="composer-subagents__task">{entry.task}</span>
          <span className="composer-subagents__meta">{meta}</span>
          {result === undefined ? null : <AgentResultPreview packet={result} />}
          {reason === undefined ? null : (
            <span className="composer-subagents__reason">{reason}</span>
          )}
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
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    return scheduleVisibleInterval(() => setNow(Date.now()), 1_000);
  }, [ticking]);
  return now;
}
