import "../styles/environment-details.css";
import { useId, useState } from "react";
import type { ThreadTouchedIssue, ThreadTouchedIssues } from "@octant/contracts";
import { CircleCheck, CircleDot } from "../ui/icons";
import { OctantButton } from "../ui/base/OctantButton";
import {
  touchedIssueIsFinished,
  touchedIssueKey,
  touchedIssueName,
  touchedIssuePlace,
  touchedIssueReference,
  touchedIssueUrl,
} from "./touchedIssues";

/** Rows shown before the list folds, as the thread's pull requests fold. */
const FOLDED_ISSUES = 10;

export interface EnvironmentThreadIssuesProps {
  /** The issues the thread's tool calls wrote to, as the host joined them. */
  readonly issues?: ThreadTouchedIssues | undefined;
  /** Opens an issue's page outside Octant. Absent leaves the rows as plain facts. */
  readonly onOpen?: ((url: string) => void) | undefined;
}

/**
 * Every issue this thread's tool calls created, commented on, edited, closed
 * or reopened, on GitHub or Linear, open ones first. It sits under the
 * thread's pull requests in the same row recipe; an issue whose page Octant
 * cannot address (a Linear issue whose result gave no address) is a plain row.
 */
export function EnvironmentThreadIssues(props: EnvironmentThreadIssuesProps) {
  const captionId = useId();
  const [showingAll, setShowingAll] = useState(false);
  const issues = props.issues;
  if (issues === undefined || issues.items.length === 0) return null;
  const folds = issues.items.length > FOLDED_ISSUES;
  const shown = folds && !showingAll ? issues.items.slice(0, FOLDED_ISSUES) : issues.items;
  return (
    <div aria-labelledby={captionId} className="environment-thread-prs" role="group">
      <p className="environment-card__caption" id={captionId}>
        Issues
      </p>
      <ul className="environment-thread-prs__list">
        {shown.map((issue) => (
          <IssueRow issue={issue} key={touchedIssueKey(issue)} onOpen={props.onOpen} />
        ))}
      </ul>
      {folds ? (
        <OctantButton
          aria-expanded={showingAll}
          className="environment-link environment-thread-prs__fold window-no-drag"
          onClick={() => setShowingAll((current) => !current)}
          type="button"
          variant="bare"
        >
          {showingAll ? "Show less" : `Show more (${String(issues.items.length - FOLDED_ISSUES)})`}
        </OctantButton>
      ) : null}
      {(folds && !showingAll) || issues.hiddenCount === 0 ? null : (
        <p className="environment-thread-prs__more">
          {`${String(issues.hiddenCount)} more not shown`}
        </p>
      )}
    </div>
  );
}

function IssueRow(props: {
  readonly issue: ThreadTouchedIssue;
  readonly onOpen: EnvironmentThreadIssuesProps["onOpen"];
}) {
  const issue = props.issue;
  const finished = touchedIssueIsFinished(issue);
  const Icon = finished ? CircleCheck : CircleDot;
  const url = touchedIssueUrl(issue);
  const onOpen = props.onOpen;
  const content = (
    <>
      <span
        aria-hidden="true"
        className="environment-tile environment-thread-pr__state"
        data-pr-state={finished ? "merged" : "open"}
      >
        <Icon size={16} />
      </span>
      <span className="environment-thread-pr__text">
        <span className="environment-thread-pr__title">
          {issue.title ?? touchedIssueReference(issue)}
        </span>
        <span className="environment-thread-pr__meta">
          <span className="environment-thread-pr__repository">{touchedIssuePlace(issue)}</span>{" "}
          <span className="environment-thread-pr__words">
            {[touchedIssueReference(issue), issue.state].filter(Boolean).join(" · ")}
          </span>
        </span>
      </span>
    </>
  );
  return (
    <li className="environment-thread-pr">
      {onOpen === undefined || url === undefined ? (
        <div
          aria-label={touchedIssueName(issue)}
          className="environment-thread-pr__open"
          role="group"
        >
          {content}
        </div>
      ) : (
        <OctantButton
          aria-label={touchedIssueName(issue)}
          className="environment-link environment-thread-pr__open window-no-drag"
          onClick={() => onOpen(url)}
          title={issue.title ?? touchedIssueReference(issue)}
          type="button"
          variant="bare"
        >
          {content}
        </OctantButton>
      )}
    </li>
  );
}
