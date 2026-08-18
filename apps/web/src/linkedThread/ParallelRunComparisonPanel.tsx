import type { ParallelRunComparison, ParallelRunComparisonEntry } from "@octant/domain";
import { GitMerge } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ParallelRunComparisonPanelProps {
  readonly comparison: ParallelRunComparison;
  readonly busy: boolean;
  readonly message?: string;
  readonly onBringHome: (threadId: string) => void;
  readonly onRefresh: () => void;
}

const STATE_TEXT: Record<ParallelRunComparisonEntry["state"], string> = {
  "no-outcome": "Not reviewed yet",
  empty: "Nothing to bring home",
  conflicts: "Conflicts with the base branch",
  ready: "Ready to bring home",
};

/**
 * The attempts on one task, side by side, and the one gesture that takes one.
 *
 * The panel states facts and stops: how much each attempt changed and where
 * they overlap. It does not rank them, because which attempt is better is a
 * judgement about the work rather than about its size. Bringing one home is
 * always an explicit choice, and the host decides whether it may happen.
 */
export function ParallelRunComparisonPanel(props: ParallelRunComparisonPanelProps) {
  const [confirming, setConfirming] = useState<string>();

  return (
    <section aria-label="Parallel run outcomes" className="parallel-runs">
      <header className="parallel-runs__header">
        <span>Outcomes</span>
        <OctantButton
          disabled={props.busy}
          onClick={props.onRefresh}
          size="sm"
          type="button"
          variant="ghost"
        >
          Re-read
        </OctantButton>
      </header>

      {props.comparison.contestedPaths.length === 0 ? null : (
        <p className="parallel-runs__contested">
          {props.comparison.contestedPaths.length === 1
            ? "1 file was changed by more than one attempt"
            : `${String(props.comparison.contestedPaths.length)} files were changed by more than one attempt`}
          : {props.comparison.contestedPaths.slice(0, 6).join(", ")}
          {props.comparison.contestedPaths.length > 6 ? "…" : ""}
        </p>
      )}

      <ul className="parallel-runs__list">
        {props.comparison.entries.map((entry) => (
          <li className="parallel-runs__entry" data-state={entry.state} key={entry.threadId}>
            <div className="parallel-runs__entry-header">
              <span className="parallel-runs__entry-label">{entry.label}</span>
              <span className="parallel-runs__entry-state">{STATE_TEXT[entry.state]}</span>
            </div>
            <p className="parallel-runs__entry-facts">
              {entry.commits === 1 ? "1 commit" : `${String(entry.commits)} commits`} ·{" "}
              {entry.changedPaths === 1 ? "1 file" : `${String(entry.changedPaths)} files`}
              {entry.overlappingPaths.length === 0
                ? ""
                : ` · ${String(entry.overlappingPaths.length)} also changed elsewhere`}
            </p>
            {entry.state !== "ready" ? null : confirming === entry.threadId ? (
              <div className="parallel-runs__confirm">
                <span>Merge this attempt into the Project&rsquo;s checkout?</span>
                <OctantButton
                  disabled={props.busy}
                  onClick={() => {
                    props.onBringHome(entry.threadId);
                    setConfirming(undefined);
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Merge it
                </OctantButton>
                <OctantButton
                  disabled={props.busy}
                  onClick={() => setConfirming(undefined)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </OctantButton>
              </div>
            ) : (
              <OctantButton
                disabled={props.busy}
                onClick={() => setConfirming(entry.threadId)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <GitMerge aria-hidden="true" size={12} strokeWidth={1.8} />
                Bring it home
              </OctantButton>
            )}
          </li>
        ))}
      </ul>

      {props.message === undefined ? null : (
        <p className="parallel-runs__message" role="status">
          {props.message}
        </p>
      )}
    </section>
  );
}
