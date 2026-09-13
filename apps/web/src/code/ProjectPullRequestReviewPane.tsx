import type {
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestDetailSection,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestLinkedThread,
} from "@octant/contracts";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleMinus,
  CircleQuestionMark,
  CircleUserRound,
  CircleX,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LockKeyhole,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { OctantBadge, type OctantBadgeProps } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
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
  open: "success",
  draft: "outline",
  merged: "default",
  closed: "destructive",
};

const PR_STATE_ICONS: Record<CodeProjectPullRequestDetailObserved["pullRequestState"], LucideIcon> =
  {
    open: GitPullRequest,
    draft: GitPullRequestDraft,
    merged: GitMerge,
    closed: GitPullRequestClosed,
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

const CHECK_STATE_ICONS: Record<
  CodeProjectPullRequestDetailObserved["checks"][number]["state"],
  LucideIcon
> = {
  success: CircleCheck,
  failure: CircleX,
  pending: LoaderCircle,
  neutral: CircleMinus,
  unknown: CircleQuestionMark,
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

  const StateIcon = PR_STATE_ICONS[detail.pullRequestState];

  return (
    <section
      aria-label="Pull request review"
      className="code-pr-review"
      data-pr-state={detail.pullRequestState}
    >
      <header className="code-pr-review__header">
        <div className="code-pr-review__headline">
          <span aria-hidden="true" className="code-pr-review__state-mark">
            <StateIcon size={20} strokeWidth={1.8} />
          </span>
          <div className="code-pr-review__title-block">
            <p className="code-pr-review__eyebrow">
              <span className="code-pr-review__eyebrow-label">Pull request</span>
              <span className="code-pr-review__number">#{detail.number}</span>
            </p>
            <h1>{detail.title.length === 0 ? `Pull request #${detail.number}` : detail.title}</h1>
          </div>
        </div>
        <div className="code-pr-review__actions">
          {githubUrl === undefined ? null : (
            <a
              className="code-pr-review__github-link"
              href={githubUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>Open on GitHub</span>
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
              <span>Refresh detail</span>
            </OctantButton>
          )}
        </div>
        <p className="code-pr-review__meta">
          <OctantBadge variant={PR_STATE_VARIANTS[detail.pullRequestState]}>
            <StateIcon aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{PR_STATE_LABELS[detail.pullRequestState]}</span>
          </OctantBadge>
          <span
            className="code-pr-review__route"
            title={`${detail.headRepository}:${detail.headBranch} → ${detail.baseRepository}:${detail.baseBranch}`}
          >
            <GitBranch aria-hidden="true" size={14} strokeWidth={1.8} />
            <code>
              {detail.headRepository}:{detail.headBranch}
            </code>
            <ArrowRight aria-hidden="true" size={14} strokeWidth={1.8} />
            <code>
              {detail.baseRepository}:{detail.baseBranch}
            </code>
          </span>
          {detail.author.length === 0 ? null : (
            <span className="code-pr-review__author">
              <CircleUserRound aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>by {detail.author}</span>
            </span>
          )}
        </p>
        <p className="code-pr-review__freshness" role="status">
          <Activity aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>{freshnessCopy(props.freshness)}</span>
        </p>
      </header>

      <p className="code-pr-review__guardrail">
        <LockKeyhole aria-hidden="true" size={14} strokeWidth={1.8} />
        <span>Read-only review · use GitHub for review actions.</span>
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
          <SectionHeading icon={MessagesSquare} title="Linked threads" />
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
        <SectionHeading
          icon={FileText}
          stale={stale("description") ? "description" : undefined}
          title="Description"
        />
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
        <SectionHeading
          count={detail.commits.length}
          icon={GitCommitHorizontal}
          stale={stale("commits") ? "commits" : undefined}
          title="Commits"
        />
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
        <SectionHeading
          count={detail.files.length}
          icon={FileDiff}
          stale={stale("files") ? "files" : undefined}
          title="Changed files"
        />
        {detail.files.length === 0 ? (
          <p role="status">No changed files observed.</p>
        ) : (
          <ul className="code-pr-review__files">
            {detail.files.map((file) => (
              <li key={file.path}>
                <span>{file.path}</span>
                <span className="code-pr-review__diff-stat">
                  <span className="code-pr-review__additions">+{file.additions}</span>
                  <span className="code-pr-review__deletions">−{file.deletions}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request checks" className="code-pr-review__section">
        <SectionHeading
          count={detail.checks.length}
          icon={CircleCheck}
          stale={stale("checks") ? "checks" : undefined}
          title="Checks"
        />
        {detail.checks.length === 0 ? (
          <p role="status">No checks observed.</p>
        ) : (
          <ul className="code-pr-review__checks">
            {detail.checks.map((check, index) => (
              <li data-check-state={check.state} key={`${check.name}-${index}`}>
                <span>{check.name}</span>
                <OctantBadge data-status={check.state} variant={CHECK_STATE_VARIANTS[check.state]}>
                  {(() => {
                    const CheckIcon = CHECK_STATE_ICONS[check.state];
                    return <CheckIcon aria-hidden="true" size={14} strokeWidth={1.8} />;
                  })()}
                  <span>{CHECK_STATE_LABELS[check.state]}</span>
                </OctantBadge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request diff" className="code-pr-review__section">
        <SectionHeading
          icon={GitCompareArrows}
          stale={stale("diff") ? "diff" : undefined}
          title="Diff"
        />
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

function SectionHeading(props: {
  readonly count?: number;
  readonly icon: LucideIcon;
  readonly stale?: string | undefined;
  readonly title: string;
}) {
  const Icon = props.icon;
  return (
    <header className="code-pr-review__section-header">
      <span className="code-pr-review__section-heading">
        <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
        <h2>
          {props.title}
          {props.count === undefined ? null : (
            <span className="code-pr-review__section-count">{props.count}</span>
          )}
        </h2>
      </span>
      {props.stale === undefined ? null : <StaleTag section={props.stale} />}
    </header>
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
