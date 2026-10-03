import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import {
  isActiveAgentHierarchyStatus,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";
import { SubagentStatusIcon, subagentElapsedLabel, subagentStatusWord } from "./subagentStatus";
import { useChildRunStatus } from "./useChildRunStatus";
import "./agent-hierarchy.css";
import { OctantAlert } from "../ui/base/OctantAlert";

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
  readonly busy?: boolean;
  readonly reconnecting?: boolean;
  readonly errorMessage?: string;
  /** Injectable for tests; defaults to `window.localStorage` when available. */
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

const OPEN_KEY = "octant.composer-subagents.open";

/**
 * The composer's card of the thread's working subagents.
 *
 * Only what is running: finished subagents, reviewed or not, are Environment's
 * and the Agents tool's to list, because a thread that delegates a lot grew a
 * tall card of old results over the transcript. The head folds the card to a
 * one-line tab and remembers that per viewer; the rows scroll past three.
 * Each row opens that subagent in Agents and offers Stop on hover or focus.
 * Stopping one named subagent acts at once; stopping several asks first,
 * naming how many are affected, because it is irreversible for every run it
 * reaches.
 */
export function SubagentsTray(props: SubagentsTrayProps) {
  const [confirming, setConfirming] = useState(false);
  const storage = props.storage ?? browserStorage();
  const [open, setOpen] = useState(() => readOpen(storage));
  // The host's order, so a row does not jump as its status changes.
  const working = props.entries.filter((entry) =>
    isActiveAgentHierarchyStatus(entry.lifecycleStatus),
  );
  const now = useNow(working.length > 0 && open);
  if (working.length === 0 && props.errorMessage === undefined) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setConfirming(false);
    writeOpen(storage, next);
  };
  const count = working.length === 1 ? "1 working" : `${String(working.length)} working`;

  return (
    <div
      aria-label="Subagents"
      className="composer-subagents"
      data-open={open ? "true" : "false"}
      role="group"
    >
      <div className="composer-subagents__head">
        <OctantButton
          aria-expanded={open}
          aria-label={`Subagents, ${count}. ${open ? "Hide" : "Show"} them`}
          className="composer-subagents__toggle"
          onClick={toggle}
          size="xs"
          type="button"
          variant="link"
        >
          <span className="composer-subagents__label">Subagents</span>
          <span className="composer-subagents__count">{count}</span>
          <ChevronDown aria-hidden="true" className="composer-subagents__chevron" size={12} />
        </OctantButton>
        {open && working.length > 1 && !confirming ? (
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

      {open && confirming && working.length > 1 ? (
        <div
          aria-label="Confirm stopping subagents"
          className="composer-subagents__confirm"
          role="group"
        >
          <p>
            Stop all {working.length} working subagents on this thread? Their work is cancelled and
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

      {open ? (
        <ul className="composer-subagents__list">
          {working.map((entry) => (
            <SubagentTrayRow
              busy={props.busy === true}
              entry={entry}
              key={entry.runId}
              now={now}
              {...(props.onOpenSubagent === undefined
                ? {}
                : { onOpenSubagent: props.onOpenSubagent })}
              onStop={props.onStop}
            />
          ))}
        </ul>
      ) : null}

      {props.reconnecting === true ? (
        <p className="composer-subagents__notice" role="status">
          Reconnecting. Showing the last status the host reported.
        </p>
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
  const meta = `${word} · ${subagentElapsedLabel(entry.updatedAt, props.now)}`;
  return (
    <li className="composer-subagents__row">
      <OctantButton
        aria-label={`${entry.task}. ${word}. Opens it in Agents.`}
        className="composer-subagents__open"
        onClick={() => props.onOpenSubagent?.(entry.runId)}
        size="xs"
        title={entry.task}
        type="button"
        variant="ghost"
      >
        <SubagentStatusIcon lifecycleStatus={entry.lifecycleStatus} />
        <span className="composer-subagents__task">{entry.task}</span>
        <span className="composer-subagents__meta">{meta}</span>
      </OctantButton>
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
    </li>
  );
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Open unless this viewer folded it; storage that throws reads as open. */
function readOpen(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(OPEN_KEY) !== "false";
  } catch {
    return true;
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
