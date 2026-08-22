import type {
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestDetailSection,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestLinkedThread,
} from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { PullRequestConversation } from "./CodeReviewPane";

const PR_STATE_LABELS: Record<CodeProjectPullRequestDetailObserved["pullRequestState"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const CHECK_STATE_LABELS: Record<
  CodeProjectPullRequestDetailObserved["checks"][number]["state"],
  string
> = {
  success: "Passing",
  failure: "Failing",
  pending: "Pending",
  neutral: "Neutral",
  unknown: "Unknown",
};

export interface ProjectPullRequestReviewPaneProps {
  readonly detail: CodeProjectPullRequestDetailObserved;
  readonly freshness: CodeProjectPullRequestFreshness;
  readonly linkedThreads: ReadonlyArray<CodeProjectPullRequestLinkedThread>;
  readonly onOpenLinkedThread?: (thread: CodeProjectPullRequestLinkedThread) => void;
  readonly onRefresh?: () => void;
}

export function ProjectPullRequestReviewPane(props: ProjectPullRequestReviewPaneProps) {
  const { detail } = props;
  const stale = (section: CodeProjectPullRequestDetailSection) =>
    detail.staleSections.includes(section);
  const waiting = detail.ambiguous || detail.freshness === "stale";
  const githubUrl = safeGithubUrl(detail.url);

  return (
    <section aria-label="Pull request review" className="code-delivery-pane code-pr-review">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Pull request #{detail.number}</span>
          <h1>{detail.title.length === 0 ? `Pull request #${detail.number}` : detail.title}</h1>
          <p className="code-pr-review__meta">
            <span className="code-pr-review__badge">
              {PR_STATE_LABELS[detail.pullRequestState]}
            </span>
            <span>
              {detail.headBranch} → {detail.baseRepository}:{detail.baseBranch}
            </span>
            {detail.author.length === 0 ? null : <span>by {detail.author}</span>}
          </p>
          <p className="code-project-pull-requests__status" role="status">
            {freshnessCopy(props.freshness)}
          </p>
        </div>
        <div className="code-pr-review__actions">
          {githubUrl === undefined ? null : (
            <a
              className="code-pr-review__github-link"
              href={githubUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open on GitHub
            </a>
          )}
          {props.onRefresh === undefined ? null : (
            <OctantButton
              onClick={() => props.onRefresh?.()}
              size="sm"
              type="button"
              variant="ghost"
            >
              Refresh detail
            </OctantButton>
          )}
        </div>
      </header>

      <p className="code-pr-review__guardrail">
        Read-only review · merging, commenting, approving, requesting changes, and closing stay on
        GitHub.
      </p>

      {waiting ? (
        <div className="code-pr-review__waiting" role="alert">
          <strong>Waiting on a fresh GitHub observation.</strong>
          <p>
            {detail.freshness === "stale"
              ? "This is the last known GitHub metadata and may be out of date."
              : "Some sections could not be fully observed."}
          </p>
        </div>
      ) : null}

      {props.linkedThreads.length === 0 ? null : (
        <section aria-label="Linked threads" className="code-pr-review__section">
          <header className="code-pr-review__section-header">
            <h2>Linked threads</h2>
          </header>
          <ul className="code-pr-review__commits">
            {props.linkedThreads.map((thread) => (
              <li key={String(thread.threadId)}>
                <span>{thread.title}</span>
                {props.onOpenLinkedThread === undefined ? null : (
                  <OctantButton
                    onClick={() => props.onOpenLinkedThread?.(thread)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Open linked thread
                  </OctantButton>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Pull request description" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Description</h2>
          {stale("description") ? <StaleTag section="description" /> : null}
        </header>
        {detail.description.length === 0 ? (
          <p role="status">No description provided.</p>
        ) : (
          <p>{detail.description}</p>
        )}
      </section>

      <section aria-label="Pull request commits" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Commits ({detail.commits.length})</h2>
          {stale("commits") ? <StaleTag section="commits" /> : null}
        </header>
        {detail.commits.length === 0 ? (
          <p role="status">No commits observed.</p>
        ) : (
          <ul className="code-pr-review__commits">
            {detail.commits.map((commit) => (
              <li key={commit.oid}>
                <code>{commit.oid.slice(0, 12)}</code>
                <span>{commit.messageHeadline}</span>
                {commit.author.length === 0 ? null : (
                  <span className="code-pr-review__muted">{commit.author}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request changed files" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Changed files ({detail.files.length})</h2>
          {stale("files") ? <StaleTag section="files" /> : null}
        </header>
        {detail.files.length === 0 ? (
          <p role="status">No changed files observed.</p>
        ) : (
          <ul className="code-pr-review__files">
            {detail.files.map((file) => (
              <li key={file.path}>
                <span>{file.path}</span>
                <span className="code-pr-review__muted">
                  +{file.additions} −{file.deletions}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request checks" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Checks ({detail.checks.length})</h2>
          {stale("checks") ? <StaleTag section="checks" /> : null}
        </header>
        {detail.checks.length === 0 ? (
          <p role="status">No checks observed.</p>
        ) : (
          <ul className="code-pr-review__checks">
            {detail.checks.map((check, index) => (
              <li key={`${check.name}-${index}`}>
                <span>{check.name}</span>
                <span className="code-pr-review__badge">{CHECK_STATE_LABELS[check.state]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request diff" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Diff</h2>
          {stale("diff") ? <StaleTag section="diff" /> : null}
        </header>
        {detail.diffTruncated ? (
          <p className="code-pr-review__notice" role="note">
            This diff is truncated and is not complete.
          </p>
        ) : null}
        {detail.diff.length === 0 ? (
          <p role="status">No diff observed.</p>
        ) : (
          <pre className="code-pr-review__diff">{detail.diff}</pre>
        )}
      </section>

      <PullRequestConversation
        comments={detail.comments}
        reviews={detail.reviews}
        staleComments={stale("comments")}
        staleReviews={stale("reviews")}
      />
    </section>
  );
}

function StaleTag(props: { readonly section: string }) {
  return (
    <span className="code-pr-review__stale" role="note">
      Stale · {props.section} could not be refreshed from GitHub
    </span>
  );
}

function freshnessCopy(freshness: CodeProjectPullRequestFreshness): string {
  if (freshness.status === "empty") {
    return "No GitHub detail yet. Select a pull request to load it.";
  }
  if (freshness.status === "fresh") {
    return freshness.lastSuccessfulRefreshAt === undefined
      ? "Detail is fresh."
      : `Last successful refresh ${formatUpdatedAt(freshness.lastSuccessfulRefreshAt)}.`;
  }
  const reason =
    freshness.staleReason === "rate-limited"
      ? "GitHub rate-limited the last detail refresh"
      : freshness.staleReason === "timeout"
        ? "The last detail refresh timed out"
        : freshness.staleReason === "malformed"
          ? "The last detail refresh returned unreadable output"
          : freshness.staleReason === "disconnected"
            ? "GitHub was disconnected on the last detail refresh"
            : "The last detail refresh failed";
  const last =
    freshness.lastSuccessfulRefreshAt === undefined
      ? ""
      : ` Last success ${formatUpdatedAt(freshness.lastSuccessfulRefreshAt)}.`;
  const retry =
    freshness.retryAfter === undefined
      ? ""
      : ` Retry after ${formatUpdatedAt(freshness.retryAfter)}.`;
  return `${reason}.${last}${retry}`;
}

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function safeGithubUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
