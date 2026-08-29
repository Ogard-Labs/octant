import type {
  ThreadBoardPullRequestIdentity,
  ThreadBoardPullRequestSummaries as ThreadBoardPullRequestSummaryList,
} from "@octant/contracts";
import { GitPullRequest } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ThreadBoardPullRequestSummariesProps {
  readonly summaries: ThreadBoardPullRequestSummaryList;
  readonly onSelect?: (identity: ThreadBoardPullRequestIdentity) => void;
}

function stateLabel(state: ThreadBoardPullRequestSummaryList["items"][number]["state"]): string {
  switch (state) {
    case "unknown":
      return "Status unknown";
    case "draft":
      return "Draft";
    case "open":
      return "Open";
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
  }
}

function checksLabel(
  checks: ThreadBoardPullRequestSummaryList["items"][number]["checks"],
): string | undefined {
  if (checks === "unknown") return undefined;
  if (checks === "passing") return "Checks passing";
  if (checks === "failing") return "Checks failing";
  return `Checks ${checks}`;
}

function reviewLabel(
  review: ThreadBoardPullRequestSummaryList["items"][number]["review"],
): string | undefined {
  if (review === "unknown" || review === "none") return undefined;
  if (review === "approved") return "Approved";
  if (review === "changes-requested") return "Changes requested";
  return `Review ${review}`;
}

function mergeabilityLabel(
  mergeability: ThreadBoardPullRequestSummaryList["items"][number]["mergeability"],
): string | undefined {
  if (mergeability === "conflicting") return "Merge conflicts";
  if (mergeability === "unknown") return "Mergeability unknown";
  return undefined;
}

function relationshipLabel(
  relationship: ThreadBoardPullRequestSummaryList["items"][number]["relationship"],
): string | undefined {
  if (relationship === undefined) return undefined;
  return relationship === "promoted" ? "Promoted Code thread" : "Linked Code thread";
}

export function ThreadBoardPullRequestSummaries(props: ThreadBoardPullRequestSummariesProps) {
  if (props.summaries.items.length === 0 && props.summaries.hiddenCount === 0) return null;
  return (
    <ul aria-label="Linked pull requests" className="board-card-pr-list">
      {props.summaries.items.map((summary) => {
        const repo = `${summary.identity.repositoryOwner}/${summary.identity.repositoryName}`;
        const details = [
          stateLabel(summary.state),
          checksLabel(summary.checks),
          reviewLabel(summary.review),
          mergeabilityLabel(summary.mergeability),
          summary.freshness === "stale"
            ? "Stale snapshot"
            : summary.freshness === "unavailable"
              ? "GitHub unavailable"
              : undefined,
          summary.readyToMerge ? "Ready to merge" : undefined,
          relationshipLabel(summary.relationship),
        ].filter((value): value is string => value !== undefined);
        const label = `${repo} #${summary.identity.number} · ${summary.title}${
          details.length === 0 ? "" : ` · ${details.join(" · ")}`
        }`;
        return (
          <li key={`${String(summary.identity.projectId)}:${repo}#${summary.identity.number}`}>
            <OctantButton
              aria-label={label}
              className="board-card-pr"
              onClick={() => props.onSelect?.(summary.identity)}
              type="button"
            >
              <GitPullRequest aria-hidden="true" className="icon" size={12} strokeWidth={1.8} />
              <span className="board-card-pr-title">{summary.title}</span>
              <span className="board-card-pr-meta">
                {repo} #{summary.identity.number}
                {details.length === 0 ? null : ` · ${details.join(" · ")}`}
              </span>
            </OctantButton>
          </li>
        );
      })}
      {props.summaries.hiddenCount === 0 ? null : (
        <li
          aria-label={`${props.summaries.hiddenCount} more pull requests`}
          className="board-card-pr-more"
        >
          +{props.summaries.hiddenCount} more
        </li>
      )}
    </ul>
  );
}
