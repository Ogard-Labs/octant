import type {
  ThreadBoardPullRequestChecksSummary,
  ThreadBoardPullRequestState,
} from "@octant/contracts";
import { GitPullRequest } from "lucide-react";

const STATE_LABELS: Readonly<Record<ThreadBoardPullRequestState, string>> = {
  unknown: "Pull request",
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export interface PullRequestChipProps {
  readonly number: number;
  readonly state: ThreadBoardPullRequestState;
  readonly checks?: ThreadBoardPullRequestChecksSummary;
  /** Spell the state after the number; a tight rail shows the number alone. */
  readonly showState?: boolean;
  readonly className?: string;
}

/**
 * One pull-request mark for every surface that names one — the pane title,
 * the home list, the board — so a request reads the same wherever it shows:
 * the glyph, its number, its state as the chip's tone, and an open request's
 * failing or pending checks as a dot before the words.
 */
function checksNote(
  state: ThreadBoardPullRequestState,
  checks: ThreadBoardPullRequestChecksSummary | undefined,
): string | undefined {
  if (state !== "open") return undefined;
  if (checks === "failing") return "checks failing";
  if (checks === "pending") return "checks pending";
  return undefined;
}

export function PullRequestChip(props: PullRequestChipProps) {
  const label = STATE_LABELS[props.state];
  const note = props.showState === true ? checksNote(props.state, props.checks) : undefined;
  return (
    <span
      className={`pull-request-chip${props.className === undefined ? "" : ` ${props.className}`}`}
      data-checks={props.state === "open" ? props.checks : undefined}
      data-tone={props.state}
      title={`Pull request #${props.number} · ${label}`}
    >
      <GitPullRequest aria-hidden="true" size={12} strokeWidth={1.8} />#{props.number}
      {props.showState === true ? ` ${label}` : null}
      {note === undefined ? null : <span className="pull-request-chip__checks">{note}</span>}
    </span>
  );
}
