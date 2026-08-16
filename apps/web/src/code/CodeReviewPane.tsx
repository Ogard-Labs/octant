import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeCheckoutId,
  CodeFileId,
  CodeRelativePath,
  CodeReviewFindingId,
  CodeThreadId,
} from "@octant/contracts/code";
import type {
  CodeOperationId,
  CodePullRequestReviewComment,
  CodePullRequestReviewOpinion,
  CodeReviewFinding,
} from "@octant/contracts/code-operations";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";

const REVIEW_STATE_LABELS: Record<CodePullRequestReviewOpinion["state"], string> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
  dismissed: "Dismissed",
  pending: "Pending",
  unknown: "Unknown state",
};

export interface PullRequestConversationProps {
  readonly reviews: ReadonlyArray<CodePullRequestReviewOpinion>;
  readonly comments: ReadonlyArray<CodePullRequestReviewComment>;
  readonly staleReviews?: boolean;
  readonly staleComments?: boolean;
}

/**
 * The read-only reviews and comments observed from the linked pull request.
 * Reviewing, approving, requesting changes, and commenting stay on GitHub in
 * v1; this surface never mutates the pull request. Sections GitHub could not
 * refresh are labeled stale.
 */
export function PullRequestConversation(props: PullRequestConversationProps) {
  return (
    <div className="code-pr-review__conversation">
      <section aria-label="Pull request reviews" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Reviews</h2>
          {props.staleReviews ? <StaleTag section="reviews" /> : null}
        </header>
        <p className="code-pr-review__readonly-note">
          Read-only · approving, requesting changes, and commenting stay on GitHub.
        </p>
        {props.reviews.length === 0 ? (
          <p role="status">No reviews observed.</p>
        ) : (
          <ul className="code-pr-review__reviews">
            {props.reviews.map((review, index) => (
              <li key={`${review.author}-${index}`}>
                <strong>{review.author.length === 0 ? "Unknown reviewer" : review.author}</strong>
                <span className="code-pr-review__badge">{REVIEW_STATE_LABELS[review.state]}</span>
                {review.body.length === 0 ? null : <p>{review.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Pull request comments" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Comments</h2>
          {props.staleComments ? <StaleTag section="comments" /> : null}
        </header>
        {props.comments.length === 0 ? (
          <p role="status">No comments observed.</p>
        ) : (
          <ul className="code-pr-review__comments">
            {props.comments.map((comment, index) => (
              <li key={`${comment.author}-${index}`}>
                <strong>{comment.author.length === 0 ? "Unknown author" : comment.author}</strong>
                {comment.body.length === 0 ? null : <p>{comment.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StaleTag(props: { readonly section: string }) {
  return (
    <span className="code-pr-review__stale" role="note">
      Stale · {props.section} could not be refreshed from GitHub
    </span>
  );
}

export interface CodeReviewTarget {
  readonly fileDigest: string;
  readonly fileId: CodeFileId;
  readonly line: number;
  readonly path: CodeRelativePath;
}

export interface CodeReviewPaneProps {
  readonly client: Pick<CodeClient, "executeOperation">;
  readonly createFindingId: () => CodeReviewFindingId;
  readonly createOperationId: () => CodeOperationId;
  readonly executionPolicy: "plan" | "approval-gated" | "full-access";
  readonly findings: ReadonlyArray<CodeReviewFinding>;
  readonly requestApproval?: (input: {
    readonly command: Parameters<CodeClient["executeOperation"]>[0];
  }) => Promise<boolean>;
  readonly scope: { readonly checkoutId: CodeCheckoutId; readonly threadId: CodeThreadId };
  readonly target?: CodeReviewTarget;
}

export function CodeReviewPane(props: CodeReviewPaneProps) {
  const [summary, setSummary] = useState("");
  const [failure, setFailure] = useState<string>();
  const [localFindings, setLocalFindings] = useState<ReadonlyArray<CodeReviewFinding>>([]);
  const findingMap = new Map(props.findings.map((finding) => [finding.id, finding]));
  for (const finding of localFindings) {
    const authoritative = findingMap.get(finding.id);
    if (authoritative === undefined || finding.version >= authoritative.version)
      findingMap.set(finding.id, finding);
  }
  const findings = [...findingMap.values()];

  const adoptFinding = (finding: CodeReviewFinding) =>
    setLocalFindings((current) => [
      ...current.filter((candidate) => candidate.id !== finding.id),
      finding,
    ]);

  const mayMutate = async (command: Parameters<CodeClient["executeOperation"]>[0]) =>
    props.executionPolicy === "full-access" ||
    (props.executionPolicy === "approval-gated" &&
      (await props.requestApproval?.({ command })) === true);

  const add = async () => {
    try {
      const operationId = props.createOperationId();
      if (props.target === undefined) return;
      const command = {
        kind: "create-review-finding",
        operationId,
        findingId: props.createFindingId(),
        fileId: props.target.fileId,
        path: props.target.path,
        fileDigest: props.target.fileDigest as never,
        location: { kind: "line", line: props.target.line },
        severity: "warning",
        summary,
        ...props.scope,
      } as const;
      if (!(await mayMutate(command))) return;
      const result = await props.client.executeOperation(command);
      if (result.kind === "review-finding-state") {
        adoptFinding(result.finding);
        setSummary("");
      }
      if (result.kind === "operation-failed") setFailure(result.failure.message);
    } catch {
      setFailure("Local review command failed. Reconnect and retry.");
    }
  };

  const changeState = async (finding: CodeReviewFinding, state: "resolved" | "dismissed") => {
    try {
      const operationId = props.createOperationId();
      const command = {
        kind: "update-review-finding",
        operationId,
        findingId: finding.id,
        expectedVersion: finding.version,
        state,
        ...props.scope,
      } as const;
      if (!(await mayMutate(command))) return;
      const result = await props.client.executeOperation(command);
      if (result.kind === "review-finding-state") adoptFinding(result.finding);
      if (result.kind === "operation-failed") setFailure(result.failure.message);
    } catch {
      setFailure("Local review command failed. Reconnect and retry.");
    }
  };

  return (
    <section aria-label="Local review" className="code-delivery-pane code-review-pane">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Review</span>
          <h1>Local findings</h1>
        </div>
        <p>Local only · GitHub review mutation unavailable</p>
      </header>
      {findings.length === 0 ? (
        <p role="status">No local findings.</p>
      ) : (
        <ul className="code-review-pane__findings">
          {findings.map((finding) => (
            <li key={finding.id}>
              <strong>{finding.summary}</strong>
              <span>
                {finding.path} · {finding.severity} · {finding.state}
              </span>
              {props.executionPolicy === "plan" || finding.state !== "open" ? null : (
                <div>
                  <OctantButton
                    onClick={() => void changeState(finding, "resolved")}
                    type="button"
                    variant="secondary"
                  >
                    Resolve
                  </OctantButton>
                  <OctantButton
                    onClick={() => void changeState(finding, "dismissed")}
                    type="button"
                    variant="ghost"
                  >
                    Dismiss
                  </OctantButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.executionPolicy === "plan" ? null : props.target === undefined ? (
        <p className="code-delivery-pane__notice">
          Select an exact file and line to add a finding.
        </p>
      ) : (
        <div className="code-review-pane__form">
          <p>
            {props.target.path}:{props.target.line}
          </p>
          <label className="code-delivery-pane__field">
            Finding summary
            <OctantTextarea value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <OctantButton
            disabled={summary.trim().length === 0}
            onClick={() => void add()}
            type="button"
            variant="secondary"
          >
            Add local finding
          </OctantButton>
        </div>
      )}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
    </section>
  );
}
