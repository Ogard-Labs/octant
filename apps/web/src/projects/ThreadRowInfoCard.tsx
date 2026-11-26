import "../styles/thread-row-info-card.css";
import type { ThreadBoardPullRequestSummaries } from "@octant/contracts";
import { pullRequestStateMark } from "../code/pullRequestState";
import { stackJoin, stackPlaceWords } from "../code/stackPlace";
import {
  touchedIssueIsFinished,
  touchedIssueKey,
  touchedIssuePlace,
  touchedIssueReference,
} from "../environment/touchedIssues";
import { liveStepLine } from "../home/liveStepLine";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { threadRowActivity, type ChatThreadNavigationItem } from "../shell/navigationModel";
import { describePullRequestSummary } from "../threadBoard/ThreadBoardPullRequestSummaries";
import { githubPullRequestUrl } from "../threadBoard/githubPullRequestUrl";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { CircleCheck, CircleDot, Cpu, ExternalLink, GitBranch, GitFork } from "../ui/icons";
import type { ReactNode } from "react";
import { ProjectMark } from "./ProjectMark";
import { threadEngine } from "./threadEngine";
import { threadRowState } from "./threadRowState";
import type { ThreadRowActions } from "./ThreadRowMenu";
import {
  linkedIssueKey,
  linkedIssueReference,
  pullRequestKey,
  threadCardIssues,
  type ThreadCardIssue,
} from "./threadRowPullRequests";

/**
 * The states worth naming at the top of the card, most actionable first. A row
 * can hold several at once, so each is its own marker rather than a joined
 * phrase.
 */
function threadRowStates(thread: ChatThreadNavigationItem): ReadonlyArray<string> {
  const states: string[] = [];
  if (thread.followUp === true) states.push("Follow-up");
  if (thread.unread === true) states.push("Unread");
  if (thread.pinned === true) states.push("Pinned");
  if (thread.woke === true) states.push("Snooze ended");
  else if (thread.shelf === "snoozed") states.push("Snoozed");
  if (thread.shelf === "completed") states.push("Settled");
  return states;
}

function threadRowAge(updatedAt: string | undefined): string | undefined {
  if (updatedAt === undefined) return undefined;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** One mark-and-label line of the info card. */
interface ThreadRowFact {
  readonly mark: ReactNode;
  readonly key: string;
  readonly label: string;
}

/**
 * The thread's live state in the words its row uses, with the running turn's
 * step or what it waits on. A thread that is neither working nor waiting on the
 * person has none: unread and a snooze's end are markers of their own above.
 */
function threadLiveFact(thread: ChatThreadNavigationItem):
  | {
      readonly mark: ReactNode;
      readonly status: "working" | "attention";
      readonly label: string;
      readonly step?: string;
    }
  | undefined {
  const { state } = threadRowState({
    activity: threadRowActivity(thread),
    unread: false,
    woke: false,
    startedAt: thread.turnStartedAt,
  });
  if (state === undefined || (state.status !== "working" && state.status !== "attention")) {
    return undefined;
  }
  const step =
    thread.liveStep !== undefined
      ? liveStepLine(thread.liveStep).text
      : thread.awaitingKind !== undefined
        ? liveStepLine({ kind: "waiting", reason: thread.awaitingKind }).text
        : undefined;
  const Icon = state.icon;
  return {
    mark: Icon === undefined ? null : <Icon aria-hidden="true" size={14} />,
    status: state.status,
    label: state.text,
    ...(step === undefined ? {} : { step }),
  };
}

/**
 * Builds the card's fact rows from values already present in the navigation
 * item and Project context. It does not invent transcript detail, model names,
 * or turn counts; those are not in the row's contract.
 */
function threadRowFacts(props: {
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}): ReadonlyArray<ThreadRowFact> {
  const facts: ThreadRowFact[] = [];
  if (props.projectName !== undefined) {
    facts.push({
      mark: (
        <ProjectMark
          name={props.projectName}
          {...(props.thread.projectId === undefined ? {} : { projectId: props.thread.projectId })}
        />
      ),
      key: "project",
      label: props.projectName,
    });
  }
  if (props.thread.checkoutChip !== undefined) {
    facts.push({
      mark: <GitBranch aria-hidden="true" size={14} />,
      key: "checkout",
      label: props.thread.checkoutChip.label,
    });
  }
  const engine = threadEngine(props.thread);
  if (engine !== undefined) {
    facts.push({
      mark:
        props.thread.provider === undefined ? (
          <Cpu aria-hidden="true" size={14} />
        ) : (
          <ProviderGlyph
            displayName={props.thread.provider.displayName}
            driverKind={props.thread.provider.driverKind}
            size={14}
          />
        ),
      key: "provider",
      label: engine,
    });
  }
  if (props.lineageParentTitle !== undefined) {
    facts.push({
      mark: <GitFork aria-hidden="true" size={14} />,
      key: "lineage",
      label: `Forked from ${props.lineageParentTitle}`,
    });
  } else if (props.thread.lineageParentThreadId !== undefined) {
    facts.push({
      mark: <GitFork aria-hidden="true" size={14} />,
      key: "lineage",
      label: "Forked from a thread no longer available",
    });
  }
  return facts;
}

type ThreadRowPullRequestSummary = ThreadBoardPullRequestSummaries["items"][number];

/** How a pull request's checks read beside its number, while it can still merge. */
function checksMark(summary: ThreadRowPullRequestSummary): string | undefined {
  if (summary.state !== "open" && summary.state !== "draft") return undefined;
  return summary.checks === "unknown" ? undefined : summary.checks;
}

/**
 * Every pull request the thread worked on, one line each, inside the card.
 *
 * A line is the state glyph in its colour, a checks dot while the pull request
 * can still merge, the number and the title; the remaining facts (checks,
 * review, conflicts, freshness) are in its tooltip and accessible name, so a
 * thread with dozens of pull requests still reads at a glance. The repository
 * is named only when the thread's pull requests span more than one.
 *
 * A click opens the pull request in Octant's Review dock; Cmd-click (Ctrl on
 * other platforms) and the trailing control go to github.com, so both
 * destinations stay one gesture apart. Without a Review route the reference
 * is plain text — a button that could open nothing would read as broken —
 * and without an external route neither the control nor the modifier is
 * offered. The facts come from the cached snapshot the row already carries;
 * nothing here asks GitHub for more.
 */
function ThreadRowPullRequests(props: {
  readonly actions: ThreadRowActions;
  readonly summaries: ThreadBoardPullRequestSummaries;
}) {
  const openInReview = props.actions.onOpenPullRequest;
  const openOnGithub = props.actions.onOpenPullRequestOnGithub;
  const repositories = new Set(
    props.summaries.items.map(
      (summary) => `${summary.identity.repositoryOwner}/${summary.identity.repositoryName}`,
    ),
  );
  const namesRepository = repositories.size > 1;
  return (
    <span aria-label="Linked pull requests" className="thread-row-info-card__prs" role="group">
      <span className="thread-row-info-card__pr-list">
        {props.summaries.items.map((summary, index) => {
          const number = String(summary.identity.number);
          const repo = `${summary.identity.repositoryOwner}/${summary.identity.repositoryName}`;
          const meta = [repo, ...describePullRequestSummary(summary)].join(" · ");
          const externalUrl =
            openOnGithub === undefined ? undefined : githubPullRequestUrl(summary.identity);
          const mark = pullRequestStateMark(summary.state);
          const checks = checksMark(summary);
          const reference = (
            <>
              <span className="thread-row-info-card__pr-state" data-pr-state={mark.tone}>
                <mark.Icon aria-hidden="true" size={14} />
              </span>
              {/* The dot's slot is kept on every line so numbers align down
                  the list whether or not a pull request still has checks. */}
              <span
                aria-hidden="true"
                className="thread-row-info-card__pr-checks"
                data-checks={checks ?? "none"}
              />
              <span className="thread-row-info-card__pr-number">#{number}</span>
              <span className="thread-row-info-card__pr-title">{summary.title}</span>
              {summary.stack === undefined ? null : (
                <span className="thread-row-info-card__pr-stack">
                  {stackPlaceWords(summary.stack)}
                </span>
              )}
              {namesRepository ? (
                <span className="thread-row-info-card__pr-repository">
                  {summary.identity.repositoryName}
                </span>
              ) : null}
            </>
          );
          const tooltip = [
            `#${number} ${summary.title}`,
            meta,
            ...(openInReview === undefined
              ? []
              : [
                  externalUrl === undefined
                    ? "Opens in Review."
                    : "Opens in Review. Cmd-click opens on GitHub.",
                ]),
          ].join("\n");
          return (
            <span
              className="thread-row-info-card__pr"
              data-stack-join={stackJoin(props.summaries.items, index)}
              key={pullRequestKey(summary.identity)}
            >
              {openInReview === undefined ? (
                <span
                  aria-label={`Pull request #${number}: ${summary.title} · ${meta}`}
                  className="thread-row-info-card__pr-reference"
                  role="img"
                  title={tooltip}
                >
                  {reference}
                </span>
              ) : (
                <OctantButton
                  aria-label={`Open pull request #${number}: ${summary.title} · ${meta}`}
                  className="thread-row-info-card__pr-reference thread-row-info-card__pr-open"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey) {
                      if (externalUrl !== undefined) openOnGithub?.(summary.identity);
                      return;
                    }
                    openInReview(summary.identity);
                  }}
                  title={tooltip}
                  type="button"
                  variant="ghost"
                >
                  {reference}
                </OctantButton>
              )}
              {externalUrl === undefined ? null : (
                <OctantIconButton
                  className="thread-row-info-card__pr-github"
                  label={`Open #${number} on GitHub`}
                  onClick={() => openOnGithub?.(summary.identity)}
                  title={`Open #${number} on GitHub`}
                  type="button"
                  variant="bare"
                >
                  <ExternalLink aria-hidden="true" size={14} />
                </OctantIconButton>
              )}
            </span>
          );
        })}
      </span>
      {props.summaries.hiddenCount === 0 ? null : (
        <span className="thread-row-info-card__pr-more">
          +{String(props.summaries.hiddenCount)} more
        </span>
      )}
    </span>
  );
}

/** At most this many issues are named in the card; the rest are counted. */
const CARD_ISSUES = 5;

/**
 * The issues the thread is linked to and those its tool calls wrote to, after
 * its pull requests, in the same one-line recipe: open or finished mark,
 * reference and title, with the repository or Linear and the state in the
 * tooltip and accessible name. A link no write has described says only
 * "Linked", in the neutral mark, since its title and state are unknown here and
 * the card asks no tracker. They are facts here, not links.
 */
function ThreadRowIssueList(props: {
  readonly issues: ReadonlyArray<ThreadCardIssue>;
  /** Touched issues past the navigation entry's bound. */
  readonly hiddenCount: number;
}) {
  const shown = props.issues.slice(0, CARD_ISSUES);
  const more = props.issues.length - shown.length + props.hiddenCount;
  return (
    <span aria-label="Issues" className="thread-row-info-card__prs" role="group">
      <span className="thread-row-info-card__pr-list">
        {shown.map((line) => {
          const state =
            line.kind === "linked"
              ? "unknown"
              : touchedIssueIsFinished(line.issue)
                ? "merged"
                : "open";
          const Icon = state === "merged" ? CircleCheck : CircleDot;
          const reference =
            line.kind === "linked"
              ? linkedIssueReference(line.link)
              : touchedIssueReference(line.issue);
          return (
            <span
              className="thread-row-info-card__pr"
              key={line.kind === "linked" ? linkedIssueKey(line.link) : touchedIssueKey(line.issue)}
            >
              <span
                aria-label={line.name}
                className="thread-row-info-card__pr-reference"
                role="img"
                title={line.name}
              >
                <span className="thread-row-info-card__pr-state" data-pr-state={state}>
                  <Icon aria-hidden="true" size={14} />
                </span>
                <span className="thread-row-info-card__pr-number">{reference}</span>
                {line.kind === "linked" ? null : (
                  <span className="thread-row-info-card__pr-title">
                    {line.issue.title ?? touchedIssuePlace(line.issue)}
                  </span>
                )}
                {line.kind === "linked" || line.linked ? (
                  <span className="thread-row-info-card__issue-linked">Linked</span>
                ) : null}
              </span>
            </span>
          );
        })}
      </span>
      {more === 0 ? null : (
        <span className="thread-row-info-card__pr-more">+{String(more)} more</span>
      )}
    </span>
  );
}

/**
 * A delayed, non-modal summary of the facts the navigation row and its Project
 * context already carry, plus the row's exact linked pull requests.
 *
 * It reads on the ordinary raised surface rather than the inverted tooltip
 * ground: the card's own tokens paint `--oct-fg` text, which on the tooltip's
 * `--oct-fg` background rendered the title invisible and left the facts at a
 * grey that failed against near-black.
 */
export function ThreadRowInfoCard(props: {
  readonly actions: ThreadRowActions;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  const states = threadRowStates(props.thread);
  const issues = threadCardIssues(props.thread);
  const age = threadRowAge(props.thread.updatedAt);
  const live = threadLiveFact(props.thread);
  const facts = threadRowFacts({
    ...(props.lineageParentTitle === undefined
      ? {}
      : { lineageParentTitle: props.lineageParentTitle }),
    projectName: props.projectName,
    thread: props.thread,
  });
  return (
    <span className="thread-row-info-card">
      <span className="thread-row-info-card__header">
        <span className="thread-row-info-card__title">{props.thread.title}</span>
        {age === undefined ? null : <span className="thread-row-info-card__age">{age}</span>}
      </span>
      {states.length === 0 ? null : (
        <span className="thread-row-info-card__states">
          {states.map((state) => (
            <span className="thread-row-info-card__state" key={state}>
              {state}
            </span>
          ))}
        </span>
      )}
      {facts.length === 0 && live === undefined ? null : (
        <span className="thread-row-info-card__facts">
          {live === undefined ? null : (
            <span className="thread-row-info-card__fact" data-live={live.status}>
              <span className="thread-row-info-card__mark">{live.mark}</span>
              <span className="thread-row-info-card__fact-label">
                {live.label}
                {live.step === undefined ? null : (
                  <span className="thread-row-info-card__step">{` · ${live.step}`}</span>
                )}
              </span>
            </span>
          )}
          {facts.map((fact) => (
            <span className="thread-row-info-card__fact" key={fact.key}>
              <span className="thread-row-info-card__mark">{fact.mark}</span>
              <span className="thread-row-info-card__fact-label">{fact.label}</span>
            </span>
          ))}
        </span>
      )}
      {props.thread.pullRequests === undefined ||
      (props.thread.pullRequests.items.length === 0 &&
        props.thread.pullRequests.hiddenCount === 0) ? null : (
        <ThreadRowPullRequests actions={props.actions} summaries={props.thread.pullRequests} />
      )}
      {issues.length === 0 ? null : (
        <ThreadRowIssueList
          hiddenCount={props.thread.touchedIssues?.hiddenCount ?? 0}
          issues={issues}
        />
      )}
    </span>
  );
}
