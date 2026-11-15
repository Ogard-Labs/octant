import type { OwnerUnlockNotGiven } from "@octant/client-runtime";
import type {
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestMergeMethod,
  CodeProjectPullRequestMergeOutcome,
} from "@octant/contracts";
import {
  ChevronDown,
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  GitBranch,
  Link2,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  TriangleAlert,
} from "../ui/icons";
import { useState, type ReactNode, type RefObject } from "react";
import { PullRequestStatePill } from "./PullRequestStatePill";
import { Markdown } from "../markdown/Markdown";
import { relativeTimeLabel } from "../lib/relativeTime";
import { CodeBlock } from "../transcript/CodeBlock";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import {
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { OctantTabs, OctantTabsList, OctantTabsPanel, OctantTabsTab } from "../ui/base/OctantTabs";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import {
  DESKTOP_ONLY,
  ProjectPullRequestActions,
  actionRefusalCopy,
  isUnauthorized,
} from "./ProjectPullRequestActions";
import type { ProjectPullRequestReviewPaneProps } from "./ProjectPullRequestReviewPane";
import {
  PullRequestSwitches,
  StaleTag,
  freshnessCopy,
  isMergeMethod,
  mergeOutcomeCopy,
  safeGithubUrl,
} from "./ProjectPullRequestSupport";
import "./project-pull-request-review.css";
import "./pull-request-page.css";

/** The merge flow the pane owns, handed to the page so both draw one confirmation. */
export interface ProjectPullRequestMergeFlow {
  readonly available: boolean;
  readonly pending: boolean;
  readonly method: CodeProjectPullRequestMergeMethod;
  readonly setMethod: (method: CodeProjectPullRequestMergeMethod) => void;
  readonly confirmationOpen: boolean;
  readonly open: () => void;
  readonly cancel: () => void;
  readonly confirm: () => void;
  readonly outcome: CodeProjectPullRequestMergeOutcome | OwnerUnlockNotGiven | undefined;
  readonly openerRef: RefObject<HTMLButtonElement | null>;
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
  readonly resultRef: RefObject<HTMLParagraphElement | null>;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}

export interface ProjectPullRequestPageProps extends ProjectPullRequestReviewPaneProps {
  readonly merge: ProjectPullRequestMergeFlow;
}

type Tab = "summary" | "changes" | "timeline";

const MERGE_METHODS: ReadonlyArray<{
  readonly value: CodeProjectPullRequestMergeMethod;
  readonly label: string;
}> = [
  { value: "squash", label: "Squash and merge" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase and merge" },
];

const REVIEW_WORDS: Record<
  CodeProjectPullRequestDetailObserved["reviews"][number]["state"],
  string
> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
  dismissed: "Dismissed",
  pending: "Pending",
  unknown: "Unknown",
};

type CheckState = CodeProjectPullRequestDetailObserved["checks"][number]["state"];

const CHECK_ORDER: Record<CheckState, number> = {
  failure: 0,
  pending: 1,
  unknown: 2,
  neutral: 3,
  success: 4,
};

const CHECKS_SHOWN = 6;

function mergeStatusLine(detail: CodeProjectPullRequestDetailObserved): {
  readonly text: string;
  readonly tone: "good" | "bad" | "quiet";
} {
  if (detail.pullRequestState === "merged") return { text: "Merged", tone: "quiet" };
  if (detail.pullRequestState === "closed")
    return { text: "Closed without merging", tone: "quiet" };
  if (detail.pullRequestState === "draft") {
    return { text: "A draft: not ready to merge", tone: "quiet" };
  }
  if (detail.mergeability === "conflicting") {
    return { text: "Has merge conflicts", tone: "bad" };
  }
  if (detail.mergeability === "mergeable") {
    return { text: "Can merge without conflicts", tone: "good" };
  }
  return { text: "Mergeability is not known yet", tone: "quiet" };
}

function CheckIcon(props: { readonly state: CheckState }) {
  const common = { "aria-hidden": true, size: 14 } as const;
  if (props.state === "success") return <CircleCheck {...common} data-tone="good" />;
  if (props.state === "failure") return <CircleX {...common} data-tone="bad" />;
  if (props.state === "pending") return <Clock {...common} data-tone="wait" />;
  return <Circle {...common} data-tone="quiet" />;
}

/**
 * The destination's reading pane for one pull request: tabs for what it says
 * (Summary), what it changes and what has been said about it, a status column
 * for what stands between it and a merge, and the person's actions at the top.
 * It holds every capability the dock's review holds; only the arrangement
 * differs, and the forms live in the Timeline tab.
 */
export function ProjectPullRequestPage(props: ProjectPullRequestPageProps) {
  const { detail, merge } = props;
  const [tab, setTab] = useState<Tab>("summary");
  const [allChecks, setAllChecks] = useState(false);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeNotice, setCloseNotice] = useState<{
    readonly tone: "done" | "refused";
    readonly text: string;
  }>();
  const githubUrl = safeGithubUrl(detail.url);
  const stale = (section: CodeProjectPullRequestDetailObserved["staleSections"][number]) =>
    detail.staleSections.includes(section);
  const waiting = detail.ambiguous || detail.freshness === "stale";
  const added = detail.files.reduce((sum, file) => sum + file.additions, 0);
  const removed = detail.files.reduce((sum, file) => sum + file.deletions, 0);
  const title = detail.title.length === 0 ? `Pull request #${detail.number}` : detail.title;
  const status = mergeStatusLine(detail);
  const checks = [...detail.checks].sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
  const shownChecks = allChecks ? checks : checks.slice(0, CHECKS_SHOWN);
  // The latest word of each reviewer is what the pull request stands on.
  const reviewers = [...new Map(detail.reviews.map((review) => [review.author, review])).values()];
  const closed = detail.pullRequestState === "closed";
  const merged = detail.pullRequestState === "merged";
  const act = props.onAct;

  async function copyLink(): Promise<void> {
    if (githubUrl === undefined) return;
    try {
      await navigator.clipboard.writeText(githubUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  async function closeOrReopen(): Promise<void> {
    if (act === undefined) return;
    setClosing(true);
    setCloseNotice(undefined);
    try {
      const outcome = await act(closed ? { kind: "reopen" } : { kind: "close" });
      if (outcome.status === "done") {
        setCloseNotice({
          tone: "done",
          text: closed ? "Reopened the pull request." : "Closed the pull request.",
        });
        props.onRefresh?.();
      } else {
        setCloseNotice({ tone: "refused", text: actionRefusalCopy(outcome) });
      }
    } catch (error) {
      setCloseNotice({
        tone: "refused",
        text: isUnauthorized(error) ? DESKTOP_ONLY : "That did not go through. Try again.",
      });
    } finally {
      setClosing(false);
    }
  }

  return (
    <section aria-label="Pull request review" className="pr-detail">
      <OctantTabs
        className="pr-detail__tabs"
        onValueChange={(value) => {
          if (value === "summary" || value === "changes" || value === "timeline") setTab(value);
        }}
        value={tab}
      >
        <div className="pr-detail__bar">
          <OctantTabsList aria-label="Pull request views" className="pr-detail__tablist">
            <OctantTabsTab value="summary">Summary</OctantTabsTab>
            <OctantTabsTab value="changes">
              Changes
              <span className="pr-detail__delta">
                <span data-tone="added">+{added}</span>
                <span data-tone="removed">−{removed}</span>
              </span>
            </OctantTabsTab>
            <OctantTabsTab value="timeline">Timeline</OctantTabsTab>
          </OctantTabsList>
          <div className="pr-detail__tools">
            {githubUrl === undefined ? null : (
              <OctantTooltip label="Open on GitHub">
                <a
                  aria-label="Open on GitHub"
                  className={octantButtonClassName({ variant: "ghost", size: "icon-sm" })}
                  href={githubUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink aria-hidden="true" size={14} />
                </a>
              </OctantTooltip>
            )}
            {githubUrl === undefined ? null : (
              <OctantTooltip label={copied ? "Link copied" : "Copy link"}>
                <OctantButton
                  aria-label="Copy link"
                  onClick={() => void copyLink()}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Link2 aria-hidden="true" size={14} />
                </OctantButton>
              </OctantTooltip>
            )}
            {props.onRefresh === undefined ? null : (
              <OctantTooltip label="Refresh detail">
                <OctantButton
                  aria-label="Refresh detail"
                  onClick={() => props.onRefresh?.()}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw aria-hidden="true" size={14} />
                </OctantButton>
              </OctantTooltip>
            )}
            {props.onOpenChat === undefined ? null : (
              <OctantButton
                onClick={() => props.onOpenChat?.(detail)}
                size="sm"
                type="button"
                variant="secondary"
              >
                <MessageSquare aria-hidden="true" size={14} />
                Open chat
              </OctantButton>
            )}
            {props.onMerge === undefined ? null : (
              <div className="pr-detail__split">
                <OctantButton
                  disabled={!merge.available || merge.pending}
                  onClick={merge.open}
                  ref={merge.openerRef}
                  size="sm"
                  title={
                    merge.available
                      ? "Merge this pull request after confirming the selected method."
                      : "Merge is available after a fresh, mergeable pull-request observation."
                  }
                  type="button"
                  variant="default"
                >
                  {merge.pending ? "Merging…" : "Merge"}
                </OctantButton>
                <OctantMenuRoot>
                  <OctantMenuTrigger
                    aria-label="Merge method"
                    className={octantButtonClassName({ variant: "default", size: "icon-sm" })}
                    disabled={!merge.available || merge.pending}
                  >
                    <ChevronDown aria-hidden="true" size={14} />
                  </OctantMenuTrigger>
                  <OctantMenuPortal>
                    <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
                      <OctantMenuPopup aria-label="Merge method" className="min-w-[13rem]">
                        <OctantMenuRadioGroup
                          onValueChange={(value) => {
                            if (typeof value === "string" && isMergeMethod(value)) {
                              merge.setMethod(value);
                            }
                          }}
                          value={merge.method}
                        >
                          {MERGE_METHODS.map((method) => (
                            <OctantMenuRadioItem
                              closeOnClick
                              key={method.value}
                              label={method.label}
                              value={method.value}
                            >
                              {method.label}
                            </OctantMenuRadioItem>
                          ))}
                        </OctantMenuRadioGroup>
                      </OctantMenuPopup>
                    </OctantMenuPositioner>
                  </OctantMenuPortal>
                </OctantMenuRoot>
              </div>
            )}
            {act === undefined || merged ? null : (
              <OctantMenuRoot>
                <OctantTooltip label="More">
                  <OctantMenuTrigger
                    aria-label="More actions"
                    className={octantButtonClassName({ variant: "ghost", size: "icon-sm" })}
                  >
                    <MoreHorizontal aria-hidden="true" size={14} />
                  </OctantMenuTrigger>
                </OctantTooltip>
                <OctantMenuPortal>
                  <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
                    <OctantMenuPopup aria-label="More actions" className="min-w-[13rem]">
                      <OctantMenuItem disabled={closing} onClick={() => void closeOrReopen()}>
                        {closed ? "Reopen pull request" : "Close pull request"}
                      </OctantMenuItem>
                    </OctantMenuPopup>
                  </OctantMenuPositioner>
                </OctantMenuPortal>
              </OctantMenuRoot>
            )}
          </div>
        </div>

        {merge.confirmationOpen ? (
          <div
            aria-label="Confirm pull-request merge"
            className="code-pr-review__merge-confirmation pr-detail__notice"
            role="region"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !merge.pending) {
                event.preventDefault();
                event.stopPropagation();
                merge.cancel();
              }
            }}
          >
            <strong>Merge pull request #{detail.number}?</strong>
            {merge.available ? (
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
                disabled={merge.pending}
                onClick={merge.cancel}
                ref={merge.cancelRef}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </OctantButton>
              <OctantButton
                disabled={merge.pending || !merge.available}
                onClick={merge.confirm}
                size="sm"
                type="button"
                variant="destructive"
              >
                Confirm merge
              </OctantButton>
            </div>
          </div>
        ) : null}
        {merge.outcome === undefined ? null : (
          /* ui-boundary-exception: compact-status */
          <p
            className={`code-pr-review__merge-result code-pr-review__merge-result--${merge.outcome.status} pr-detail__notice`}
            ref={merge.resultRef}
            role={merge.outcome.status === "merged" ? "status" : "alert"}
            tabIndex={-1}
          >
            {mergeOutcomeCopy(merge.outcome)}
          </p>
        )}
        {closeNotice === undefined ? null : (
          /* ui-boundary-exception: compact-status */
          <p
            className={`code-pr-review__merge-result code-pr-review__merge-result--${closeNotice.tone === "done" ? "merged" : "refused"} pr-detail__notice`}
            role={closeNotice.tone === "done" ? "status" : "alert"}
          >
            {closeNotice.text}
          </p>
        )}

        <div className="pr-detail__body" data-tab={tab}>
          <header className="pr-detail__head">
            <p className="pr-detail__kicker">
              <PullRequestStatePill state={detail.pullRequestState} />
              <span className="oct-meta">
                {detail.baseRepository} #{detail.number}
              </span>
            </p>
            <h1 className="oct-page-title pr-detail__title" ref={merge.headingRef} tabIndex={-1}>
              {title}
            </h1>
            <p className="pr-detail__meta">
              {detail.author.length === 0 ? null : <span>{detail.author}</span>}
              {props.updatedAt === undefined ? null : (
                <span>{relativeTimeLabel(props.updatedAt)}</span>
              )}
              <span className="pr-detail__branches">
                <GitBranch aria-hidden="true" size={12} />
                {detail.headBranch} → {detail.baseBranch}
              </span>
            </p>
          </header>

          <aside aria-label="Pull request status" className="pr-detail__status">
            <section aria-label="Merge status" className="pr-detail__group">
              <h2 className="oct-nav-group">Merge status</h2>
              <p className="pr-detail__line" data-tone={status.tone}>
                {status.tone === "bad" ? (
                  <TriangleAlert aria-hidden="true" size={14} />
                ) : status.tone === "good" ? (
                  <CircleCheck aria-hidden="true" size={14} />
                ) : (
                  <Circle aria-hidden="true" size={14} />
                )}
                {status.text}
              </p>
              {waiting ? (
                <p className="pr-detail__quiet" role="status">
                  Waiting on a fresh GitHub observation.
                  {detail.freshness === "stale"
                    ? " This is the last known GitHub metadata and may be out of date."
                    : " Some sections could not be fully observed."}
                </p>
              ) : null}
            </section>

            <section aria-label="Checks" className="pr-detail__group">
              <h2 className="oct-nav-group">
                Checks {stale("checks") ? <StaleTag section="checks" /> : null}
              </h2>
              {checks.length === 0 ? (
                <p className="pr-detail__quiet" role="status">
                  No checks observed.
                </p>
              ) : (
                <ul className="pr-detail__list">
                  {shownChecks.map((check, index) => (
                    <li key={`${check.name}-${index}`}>
                      <CheckIcon state={check.state} />
                      <span className="pr-detail__name">{check.name}</span>
                      <span className="sr-only">{check.state}</span>
                    </li>
                  ))}
                </ul>
              )}
              {checks.length > CHECKS_SHOWN ? (
                <OctantButton
                  variant="bare"
                  className="pr-detail__link"
                  onClick={() => setAllChecks((all) => !all)}
                  type="button"
                >
                  {allChecks ? "Show fewer" : "View all"}
                </OctantButton>
              ) : null}
            </section>

            <section aria-label="Reviews" className="pr-detail__group">
              <h2 className="oct-nav-group">
                Reviews {stale("reviews") ? <StaleTag section="reviews" /> : null}
              </h2>
              {reviewers.length === 0 ? (
                <p className="pr-detail__quiet" role="status">
                  No reviews observed.
                </p>
              ) : (
                <ul className="pr-detail__list">
                  {reviewers.map((review) => (
                    <li key={review.author}>
                      <span className="pr-detail__name">
                        {review.author.length === 0 ? "Unknown reviewer" : review.author}
                      </span>
                      <span className="pr-detail__state" data-state={review.state}>
                        {REVIEW_WORDS[review.state]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Comments" className="pr-detail__group">
              <h2 className="oct-nav-group">
                Comments {stale("comments") ? <StaleTag section="comments" /> : null}
              </h2>
              <OctantButton
                variant="bare"
                className="pr-detail__link"
                onClick={() => setTab("timeline")}
                type="button"
              >
                {detail.comments.length === 1 ? "1 comment" : `${detail.comments.length} comments`}
              </OctantButton>
            </section>

            {props.linkedThreads.length === 0 ? null : (
              <section aria-label="Linked threads" className="pr-detail__group">
                <h2 className="oct-nav-group">Linked threads</h2>
                <ul className="pr-detail__list">
                  {props.linkedThreads.map((thread) => (
                    <li key={String(thread.threadId)}>
                      {props.onOpenLinkedThread === undefined ? (
                        <span className="pr-detail__name">{thread.title}</span>
                      ) : (
                        <OctantButton
                          variant="bare"
                          className="pr-detail__link pr-detail__name"
                          onClick={() => props.onOpenLinkedThread?.(thread)}
                          title="Open linked thread"
                          type="button"
                        >
                          {thread.title}
                        </OctantButton>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {props.switches === undefined ? null : (
              <PullRequestSwitches
                compact
                detail={detail}
                linkedThreads={props.linkedThreads}
                mergeMethod={merge.method}
                switches={props.switches}
                {...(props.onMergeWhenReady === undefined
                  ? {}
                  : { onMergeWhenReady: props.onMergeWhenReady })}
                {...(props.onAutoFix === undefined ? {} : { onAutoFix: props.onAutoFix })}
              />
            )}

            <p className="pr-detail__quiet" role="status">
              {freshnessCopy(props.freshness)}
            </p>
          </aside>

          <div className="pr-detail__content">
            <OctantTabsPanel className="pr-detail__panel" value="summary">
              {stale("description") ? <StaleTag section="description" /> : null}
              {detail.description.length === 0 ? (
                <p className="pr-detail__quiet" role="status">
                  No description provided.
                </p>
              ) : (
                <Markdown body={detail.description} className="pr-detail__prose" skipHtml />
              )}
            </OctantTabsPanel>

            <OctantTabsPanel className="pr-detail__panel" value="changes">
              <Block
                label={`Commits (${detail.commits.length})`}
                stale={stale("commits") ? "commits" : undefined}
              >
                {detail.commits.length === 0 ? (
                  <p className="pr-detail__quiet" role="status">
                    No commits observed.
                  </p>
                ) : (
                  <ul className="pr-detail__rows">
                    {detail.commits.map((commit) => (
                      <li key={commit.oid}>
                        <code>{commit.oid.slice(0, 7)}</code>
                        <span className="pr-detail__name">{commit.messageHeadline}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Block>
              <Block
                label={`Changed files (${detail.files.length})`}
                stale={stale("files") ? "files" : undefined}
              >
                {detail.files.length === 0 ? (
                  <p className="pr-detail__quiet" role="status">
                    No changed files observed.
                  </p>
                ) : (
                  <ul className="pr-detail__rows">
                    {detail.files.map((file) => (
                      <li key={file.path}>
                        <span className="pr-detail__name">{file.path}</span>
                        <span className="pr-detail__delta">
                          <span data-tone="added">+{file.additions}</span>
                          <span data-tone="removed">−{file.deletions}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Block>
              <Block label="Diff" stale={stale("diff") ? "diff" : undefined}>
                {detail.diffTruncated ? (
                  <p className="pr-detail__quiet" role="note">
                    This diff is truncated and is not complete.
                  </p>
                ) : null}
                {detail.diff.length === 0 ? (
                  <p className="pr-detail__quiet" role="status">
                    No diff observed.
                  </p>
                ) : (
                  <div className="code-pr-review__diff">
                    <CodeBlock code={detail.diff} language="diff" />
                  </div>
                )}
              </Block>
            </OctantTabsPanel>

            {/* Kept mounted while hidden: it holds the comment and review drafts,
                and leaving the tab unmounted them and lost what the person typed. */}
            <OctantTabsPanel className="pr-detail__panel" keepMounted value="timeline">
              {detail.reviews.length === 0 && detail.comments.length === 0 ? (
                <p className="pr-detail__quiet" role="status">
                  No reviews or comments yet.
                </p>
              ) : (
                <ol className="pr-detail__timeline">
                  {detail.reviews.map((review, index) => (
                    <li key={`review-${review.author}-${index}`}>
                      <p className="pr-detail__who">
                        <strong>
                          {review.author.length === 0 ? "Unknown reviewer" : review.author}
                        </strong>
                        <span className="pr-detail__state" data-state={review.state}>
                          {REVIEW_WORDS[review.state]}
                        </span>
                      </p>
                      {review.body.length === 0 ? null : (
                        <Markdown body={review.body} className="pr-detail__prose" />
                      )}
                    </li>
                  ))}
                  {detail.comments.map((comment, index) => (
                    <li key={`comment-${comment.author}-${index}`}>
                      <p className="pr-detail__who">
                        <strong>
                          {comment.author.length === 0 ? "Unknown author" : comment.author}
                        </strong>
                        <span className="oct-meta">commented</span>
                      </p>
                      {comment.body.length === 0 ? null : (
                        <Markdown body={comment.body} className="pr-detail__prose" />
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {props.onLoadActionContext === undefined || props.onAct === undefined ? null : (
                <ProjectPullRequestActions
                  headSha={detail.headSha}
                  layout="timeline"
                  loadContext={props.onLoadActionContext}
                  onAct={props.onAct}
                  pullRequestState={detail.pullRequestState}
                  {...(props.onRefresh === undefined ? {} : { onChanged: props.onRefresh })}
                />
              )}
            </OctantTabsPanel>
          </div>
        </div>
      </OctantTabs>
    </section>
  );
}

function Block(props: {
  readonly label: string;
  readonly stale: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.label} className="pr-detail__block">
      <h2 className="oct-nav-group">
        {props.label} {props.stale === undefined ? null : <StaleTag section={props.stale} />}
      </h2>
      {props.children}
    </section>
  );
}
