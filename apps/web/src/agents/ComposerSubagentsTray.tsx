import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import {
  isActiveAgentHierarchyStatus,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";
import {
  SubagentStatusIcon,
  subagentElapsedLabel,
  subagentNeedsReview,
  subagentPhase,
  subagentStatusWord,
} from "./subagentStatus";
import { useChildRunStatus } from "./useChildRunStatus";
import "./agent-hierarchy.css";

/** Rows the tray shows before the rest fold into one "more" row. */
const VISIBLE_ROWS = 3;

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
  /** Opens the Agents tool; with a run id, on that subagent's conversation. */
  readonly onOpenSubagent?: (runId?: string) => void;
}) {
  const subagents = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  if (subagents.status !== "ready") return null;
  return (
    <SubagentsTray
      busy={subagents.busy}
      entries={subagents.entries}
      {...(subagents.errorMessage === undefined ? {} : { errorMessage: subagents.errorMessage })}
      onMarkReviewed={(input) => void subagents.acknowledge(input)}
      {...(props.onOpenSubagent === undefined ? {} : { onOpenSubagent: props.onOpenSubagent })}
      onStop={(runId) => void subagents.cancelRun(runId)}
      onStopAll={() => void subagents.stopAll()}
      reconnecting={subagents.reconnecting}
    />
  );
}

export interface SubagentsTrayProps {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly onOpenSubagent?: (runId?: string) => void;
  /** Cancels one named subagent; it names its target, so it needs no confirmation. */
  readonly onStop: (runId: string) => void;
  /** Cancels every working subagent on the thread. Already confirmed when called. */
  readonly onStopAll: () => void;
  readonly onMarkReviewed: (input: { readonly runId: string; readonly version: number }) => void;
  readonly busy?: boolean;
  readonly reconnecting?: boolean;
  readonly errorMessage?: string;
}

/**
 * The composer's workbench tray: the thread's working subagents and the
 * finished ones whose results the person has not reviewed yet.
 *
 * Reviewed and settled subagents leave the tray — they live in the Agents
 * tool — so an ordinary thread shows nothing here at all. Each row is one
 * button that opens that subagent in Agents, with a single trailing action.
 * Stopping one named subagent acts at once; stopping several asks first,
 * naming how many are affected, because it is irreversible for every run it
 * reaches.
 */
export function SubagentsTray(props: SubagentsTrayProps) {
  const [confirming, setConfirming] = useState(false);
  const pending = props.entries.filter(
    (entry) => isActiveAgentHierarchyStatus(entry.lifecycleStatus) || subagentNeedsReview(entry),
  );
  // Working rows lead, in the host's order, so a row does not jump as its
  // status changes; results awaiting review follow them.
  const ordered = [
    ...pending.filter((entry) => isActiveAgentHierarchyStatus(entry.lifecycleStatus)),
    ...pending.filter((entry) => !isActiveAgentHierarchyStatus(entry.lifecycleStatus)),
  ];
  const working = ordered.filter((entry) => isActiveAgentHierarchyStatus(entry.lifecycleStatus));
  const now = useNow(working.length > 0);
  if (ordered.length === 0 && props.errorMessage === undefined) return null;

  const shown = ordered.slice(0, VISIBLE_ROWS);
  const hidden = ordered.length - shown.length;
  const stoppable = working.length;

  return (
    <div aria-label="Subagents" className="composer-subagents" role="group">
      <div className="composer-subagents__head">
        <span className="composer-subagents__label">Subagents</span>
        {stoppable > 1 && !confirming ? (
          <OctantButton
            disabled={props.busy === true}
            onClick={() => setConfirming(true)}
            size="xs"
            type="button"
            variant="ghost"
          >
            Stop all
          </OctantButton>
        ) : null}
      </div>

      {confirming && stoppable > 1 ? (
        <div
          aria-label="Confirm stopping subagents"
          className="composer-subagents__confirm"
          role="group"
        >
          <p>
            Stop all {stoppable} working subagents on this thread? Their work is cancelled and
            cannot be resumed.
          </p>
          <p className="composer-subagents__confirm-scope">
            Only this thread&apos;s subagents are affected. No other thread is stopped.
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
              Stop {stoppable} subagents
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

      <ul className="composer-subagents__list">
        {shown.map((entry) => (
          <SubagentTrayRow
            busy={props.busy === true}
            entry={entry}
            key={entry.runId}
            now={now}
            onMarkReviewed={props.onMarkReviewed}
            {...(props.onOpenSubagent === undefined
              ? {}
              : { onOpenSubagent: props.onOpenSubagent })}
            onStop={props.onStop}
          />
        ))}
        {hidden > 0 ? (
          <li className="composer-subagents__row">
            <OctantButton
              aria-label={`Show ${hidden} more ${hidden === 1 ? "subagent" : "subagents"} in Agents`}
              className="composer-subagents__more"
              onClick={() => props.onOpenSubagent?.()}
              size="xs"
              type="button"
              variant="ghost"
            >
              +{hidden} more
            </OctantButton>
          </li>
        ) : null}
      </ul>

      {props.reconnecting === true ? (
        <p className="composer-subagents__notice" role="status">
          Reconnecting. Showing the last status the host reported.
        </p>
      ) : null}
      {props.errorMessage === undefined ? null : (
        <p className="composer-subagents__notice" role="alert">
          {props.errorMessage}
        </p>
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
  readonly onMarkReviewed: (input: { readonly runId: string; readonly version: number }) => void;
}) {
  const entry = props.entry;
  const phase = subagentPhase(entry.lifecycleStatus);
  const active = isActiveAgentHierarchyStatus(entry.lifecycleStatus);
  const word = subagentStatusWord(entry.lifecycleStatus);
  const meta = active
    ? `${word} · ${subagentElapsedLabel(entry.updatedAt, props.now)}`
    : phase === "done"
      ? `${word} — review`
      : word;
  const sentence = active
    ? `${word}.`
    : phase === "done"
      ? "Done, waiting for your review."
      : `${word}, waiting for your review.`;
  return (
    <li className="composer-subagents__row">
      <OctantButton
        aria-label={`${entry.task}. ${sentence} Opens it in Agents.`}
        className="composer-subagents__open"
        onClick={() => props.onOpenSubagent?.(entry.runId)}
        size="sm"
        title={entry.task}
        type="button"
        variant="ghost"
      >
        <SubagentStatusIcon lifecycleStatus={entry.lifecycleStatus} />
        <span className="composer-subagents__task">{entry.task}</span>
        <span className="composer-subagents__meta">{meta}</span>
      </OctantButton>
      {active ? (
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
      ) : (
        <OctantButton
          aria-label={`Mark reviewed: ${entry.task}`}
          className="composer-subagents__action"
          onClick={() => props.onMarkReviewed({ runId: entry.runId, version: entry.version })}
          size="xs"
          type="button"
          variant="ghost"
        >
          Mark reviewed
        </OctantButton>
      )}
    </li>
  );
}

/**
 * The current time, re-read each second while something in the tray is
 * working. The host's summary only changes on a status change, so without
 * this the "12s" beside a working subagent would sit still until it finished.
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
