import type {
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestDetailSection,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestLinkedThread,
  CodeProjectPullRequestMergeMethod,
  CodeProjectPullRequestMergeOutcome,
} from "@octant/contracts";
import { Activity, GitBranch, GitPullRequest, MessageSquare, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantBadge, type OctantBadgeProps } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { Markdown } from "../markdown/Markdown";
import { CodeBlock } from "../transcript/CodeBlock";
import "./project-pull-request-review.css";
import { PullRequestConversation } from "./CodeReviewPane";

const PR_STATE_LABELS: Record<CodeProjectPullRequestDetailObserved["pullRequestState"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const PR_STATE_VARIANTS: Record<
  CodeProjectPullRequestDetailObserved["pullRequestState"],
  NonNullable<OctantBadgeProps["variant"]>
> = {
  open: "secondary",
  draft: "outline",
  merged: "success",
  closed: "destructive",
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

const CHECK_STATE_VARIANTS: Record<
  CodeProjectPullRequestDetailObserved["checks"][number]["state"],
  NonNullable<OctantBadgeProps["variant"]>
> = {
  success: "success",
  failure: "destructive",
  pending: "warning",
  neutral: "secondary",
  unknown: "secondary",
};

export interface ProjectPullRequestReviewPaneProps {
  readonly detail: CodeProjectPullRequestDetailObserved;
  readonly freshness: CodeProjectPullRequestFreshness;
  readonly linkedThreads: ReadonlyArray<CodeProjectPullRequestLinkedThread>;
  readonly onOpenLinkedThread?: (thread: CodeProjectPullRequestLinkedThread) => void;
  readonly onOpenChat?: (detail: CodeProjectPullRequestDetailObserved) => void;
  readonly onMerge?: (
    method: CodeProjectPullRequestMergeMethod,
    headSha: string,
  ) => Promise<CodeProjectPullRequestMergeOutcome>;
  readonly onRefresh?: () => void;
}

export function ProjectPullRequestReviewPane(props: ProjectPullRequestReviewPaneProps) {
  const { detail } = props;
  const mergeOpener = useRef<HTMLButtonElement>(null);
  const cancelMerge = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const mergeResult = useRef<HTMLParagraphElement>(null);
  const focusResultAfterAttempt = useRef(false);
  const [mergeMethod, setMergeMethod] = useState<CodeProjectPullRequestMergeMethod>("squash");
  const [mergeConfirmationOpen, setMergeConfirmationOpen] = useState(false);
  const [mergePending, setMergePending] = useState(false);
  const [mergeOutcome, setMergeOutcome] = useState<CodeProjectPullRequestMergeOutcome>();
  const stale = (section: CodeProjectPullRequestDetailSection) =>
    detail.staleSections.includes(section);
  const waiting = detail.ambiguous || detail.freshness === "stale";
  const mergeAvailable =
    props.onMerge !== undefined &&
    detail.headSha !== "" &&
    detail.pullRequestState === "open" &&
    detail.mergeability === "mergeable" &&
    props.freshness.status === "fresh" &&
    !waiting;
  const githubUrl = safeGithubUrl(detail.url);

  useEffect(() => {
    if (mergePending) return;
    if (mergeConfirmationOpen) cancelMerge.current?.focus();
    else if (focusResultAfterAttempt.current) {
      focusResultAfterAttempt.current = false;
      mergeResult.current?.focus();
    }
  }, [mergeConfirmationOpen, mergePending]);

  function cancelConfirmation() {
    if (mergePending) return;
    setMergeConfirmationOpen(false);
    const target = mergeOpener.current;
    if (target !== null && !target.disabled) target.focus();
    else reviewHeading.current?.focus();
  }

  async function confirmMerge(): Promise<void> {
    if (props.onMerge === undefined || !mergeAvailable) return;
    setMergePending(true);
    setMergeOutcome(undefined);
    try {
      const outcome = await props.onMerge(mergeMethod, detail.headSha);
      focusResultAfterAttempt.current = true;
      setMergeOutcome(outcome);
      setMergeConfirmationOpen(false);
      if (outcome.status === "merged") props.onRefresh?.();
    } catch {
      setMergeOutcome({ status: "unavailable", reason: "unavailable" });
    } finally {
      setMergePending(false);
    }
  }

  return (
    <section aria-label="Pull request review" className="code-pr-review">
      <header className="code-pr-review__header">
        <div>
          <div className="code-pr-review__eyebrow">
            <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Pull request #{detail.number}</span>
          </div>
          <h1 ref={reviewHeading} tabIndex={-1}>
            {detail.title.length === 0 ? `Pull request #${detail.number}` : detail.title}
          </h1>
          <p className="code-pr-review__meta">
            <OctantBadge variant={PR_STATE_VARIANTS[detail.pullRequestState]}>
              {PR_STATE_LABELS[detail.pullRequestState]}
            </OctantBadge>
            <span className="code-pr-review__meta-item">
              <GitBranch aria-hidden="true" size={14} strokeWidth={1.8} />
              {detail.headBranch} → {detail.baseRepository}:{detail.baseBranch}
            </span>
            {detail.author.length === 0 ? null : (
              <span className="code-pr-review__meta-item">by {detail.author}</span>
            )}
          </p>
          <p className="code-project-pull-requests__status code-pr-review__freshness" role="status">
            <Activity aria-hidden="true" size={14} strokeWidth={1.8} />
            {freshnessCopy(props.freshness)}
          </p>
        </div>
        <div className="code-pr-review__actions">
          {props.onOpenChat === undefined ? null : (
            <OctantButton
              onClick={() => props.onOpenChat?.(detail)}
              size="sm"
              type="button"
              variant="secondary"
            >
              <MessageSquare aria-hidden="true" size={14} strokeWidth={1.8} />
              Open chat
            </OctantButton>
          )}
          {props.onMerge === undefined ? null : (
            <div className="code-pr-review__merge-actions">
              <OctantSelectField
                aria-label="Merge method"
                className="code-pr-review__merge-method"
                disabled={!mergeAvailable || mergePending}
                onValueChange={(value) => {
                  if (isMergeMethod(value)) {
                    setMergeMethod(value);
                  }
                }}
                options={[
                  { id: "merge", label: "Merge commit" },
                  { id: "squash", label: "Squash and merge" },
                  { id: "rebase", label: "Rebase and merge" },
                ]}
                value={mergeMethod}
              />
              <OctantButton
                disabled={!mergeAvailable || mergePending}
                ref={mergeOpener}
                onClick={() => {
                  setMergeOutcome(undefined);
                  setMergeConfirmationOpen(true);
                }}
                size="sm"
                title={
                  mergeAvailable
                    ? "Merge this pull request after confirming the selected method."
                    : "Merge is available after a fresh, mergeable pull-request observation."
                }
                type="button"
                variant="secondary"
              >
                {mergePending ? "Merging…" : "Merge"}
              </OctantButton>
            </div>
          )}
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
              <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
              Refresh detail
            </OctantButton>
          )}
        </div>
      </header>

      {mergeConfirmationOpen ? (
        <div
          aria-label="Confirm pull-request merge"
          className="code-pr-review__merge-confirmation"
          role="region"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !mergePending) {
              event.preventDefault();
              event.stopPropagation();
              cancelConfirmation();
            }
          }}
        >
          <strong>Merge pull request #{detail.number}?</strong>
          {mergeAvailable ? (
            <p>
              This merges the head you reviewed ({detail.headSha.slice(0, 7)}). Octant refuses if
              the pull request changed since then.
            </p>
          ) : (
            <p>
              This pull request changed or is no longer mergeable. Refresh the detail before
              merging.
            </p>
          )}
          <div className="code-pr-review__actions">
            <OctantButton
              disabled={mergePending}
              ref={cancelMerge}
              onClick={cancelConfirmation}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </OctantButton>
            <OctantButton
              disabled={mergePending || !mergeAvailable}
              onClick={() => void confirmMerge()}
              size="sm"
              type="button"
              variant="destructive"
            >
              Confirm merge
            </OctantButton>
          </div>
        </div>
      ) : null}
      {mergeOutcome === undefined ? null : (
        <p
          ref={mergeResult}
          tabIndex={-1}
          className={`code-pr-review__merge-result code-pr-review__merge-result--${mergeOutcome.status}`}
          role={mergeOutcome.status === "merged" ? "status" : "alert"}
        >
          {mergeOutcomeCopy(mergeOutcome)}
        </p>
      )}

      <p className="code-pr-review__guardrail">
        Review data is read-only; merging is explicit and approval-gated.
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
          <>
            <Markdown body={detail.description} className="code-pr-review__prose" skipHtml />
            <details className="code-pr-review__source">
              <summary>Original description</summary>
              <div className="code-pr-review__diff">
                <CodeBlock code={detail.description} language="markdown" />
              </div>
            </details>
          </>
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
                <OctantBadge variant={CHECK_STATE_VARIANTS[check.state]}>
                  {CHECK_STATE_LABELS[check.state]}
                </OctantBadge>
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
          <div className="code-pr-review__diff">
            <CodeBlock code={detail.diff} language="diff" />
          </div>
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

function mergeOutcomeCopy(outcome: CodeProjectPullRequestMergeOutcome): string {
  if (outcome.status === "merged") {
    return `Merged pull request #${outcome.number}. Refreshing its review state.`;
  }
  if (outcome.status === "unavailable") {
    const reason =
      outcome.reason === "unauthenticated"
        ? "GitHub authentication is unavailable"
        : outcome.reason === "disconnected"
          ? "GitHub could not be reached"
          : "the GitHub merge command is unavailable";
    return `Merge unavailable: ${reason}.`;
  }
  const reason =
    outcome.reason === "not-authorized"
      ? "this Project is not authorized for that repository"
      : outcome.reason === "not-open"
        ? "the pull request is no longer open"
        : outcome.reason === "not-mergeable"
          ? "GitHub reports that it is not mergeable"
          : outcome.reason === "stale"
            ? "the pull request changed since this review"
            : outcome.reason === "conflict"
              ? "GitHub reported a merge conflict"
              : "GitHub rejected the merge";
  return `Merge refused: ${reason}.`;
}

function isMergeMethod(value: string): value is CodeProjectPullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}
