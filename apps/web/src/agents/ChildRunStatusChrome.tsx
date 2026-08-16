import { AlertTriangle, CircleCheck, Loader, PauseCircle } from "lucide-react";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { AgentHierarchyPanel } from "./AgentHierarchyPanel";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";
import type { ChildRunStatusState, ChildRunStatusSummary } from "./buildChildRunStatusSummary";
import "./agent-hierarchy.css";

export interface ChildRunStatusChromeProps {
  readonly summary: ChildRunStatusSummary;
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  /** Cancels this parent thread's live children. Already confirmed when called. */
  readonly onStopChildren: () => void | Promise<unknown>;
  readonly onCancelRun?: (input: { readonly runId: string }) => void;
  readonly onAcknowledge?: (input: { readonly runId: string; readonly version: number }) => void;
  readonly creationPosture?: "off" | "ask" | "automatic";
  readonly busy?: boolean;
  readonly reconnecting?: boolean;
  readonly errorMessage?: string;
}

/**
 * Compact current-thread child-run chrome.
 *
 * Chat, Work, and Code all mount this: it is observability plus
 * stop-this-thread's-children, not a team or orchestration surface. Status is
 * carried by an icon *and* the same words beside it, never colour alone, and
 * the detail view is the existing hierarchy panel rather than a second
 * child-run UI.
 *
 * Stopping is destructive and irreversible for the runs it reaches, so it is a
 * two-step confirmation that names the exact number of runs affected. Mounting
 * this chrome grants no Code worktree, shell, or Git authority — it only reads
 * server-authored AgentRun summaries and calls the existing cancel path.
 */
export function ChildRunStatusChrome(props: ChildRunStatusChromeProps) {
  const listId = useId();
  const confirmId = useId();
  const [listOpen, setListOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const summary = props.summary;
  const stoppable = summary.stoppableRunIds.length;
  const Icon = statusIcon(summary.state);

  return (
    <section aria-label="Child run status" className="child-run-status">
      <div className="child-run-status__bar">
        <p className="child-run-status__state">
          <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>{summary.label}</span>
        </p>
        <p className="child-run-status__detail">{summary.detail}</p>
        <div className="child-run-status__actions">
          <OctantButton
            aria-controls={listId}
            aria-expanded={listOpen}
            disabled={props.entries.length === 0}
            onClick={() => setListOpen((current) => !current)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {listOpen ? "Hide child runs" : "Show child runs"}
          </OctantButton>
          {stoppable === 0 ? null : (
            <OctantButton
              aria-controls={confirmId}
              aria-expanded={confirming}
              disabled={props.busy === true}
              onClick={() => setConfirming(true)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Stop this thread&apos;s children
            </OctantButton>
          )}
        </div>
      </div>

      {props.reconnecting === true ? (
        <p className="child-run-status__notice" role="status">
          Reconnecting. Showing the last child-run status the host reported.
        </p>
      ) : null}
      {props.errorMessage === undefined ? null : (
        <p className="child-run-status__notice" role="alert">
          {props.errorMessage}
        </p>
      )}

      {confirming && stoppable > 0 ? (
        <div
          className="child-run-status__confirm"
          id={confirmId}
          role="group"
          aria-label="Confirm stopping child runs"
        >
          <p>
            {stoppable === 1
              ? "Stop the 1 live child run on this thread? Its work is cancelled and cannot be resumed."
              : `Stop all ${stoppable} live child runs on this thread? Their work is cancelled and cannot be resumed.`}
          </p>
          <p className="child-run-status__confirm-scope">
            Only this thread&apos;s children are affected. No other thread is stopped.
          </p>
          <div>
            <OctantButton
              disabled={props.busy === true}
              onClick={() => {
                setConfirming(false);
                void props.onStopChildren();
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              {stoppable === 1 ? "Stop 1 child run" : `Stop ${stoppable} child runs`}
            </OctantButton>
            <OctantButton
              onClick={() => setConfirming(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Keep running
            </OctantButton>
          </div>
        </div>
      ) : null}

      {listOpen ? (
        <div id={listId}>
          <AgentHierarchyPanel
            entries={props.entries}
            {...(props.creationPosture === undefined
              ? {}
              : { creationPosture: props.creationPosture })}
            {...(props.onAcknowledge === undefined ? {} : { onAcknowledge: props.onAcknowledge })}
            {...(props.onCancelRun === undefined ? {} : { onCancel: props.onCancelRun })}
            {...(props.reconnecting === undefined ? {} : { reconnecting: props.reconnecting })}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The icon is redundant with the words beside it on purpose: assistive
 * technology and colour-blind users both get the state from the text, and the
 * icon only speeds up recognition for everyone else.
 */
function statusIcon(state: ChildRunStatusState) {
  if (state === "working") return Loader;
  if (state === "waiting") return PauseCircle;
  if (state === "blocked") return AlertTriangle;
  return CircleCheck;
}
