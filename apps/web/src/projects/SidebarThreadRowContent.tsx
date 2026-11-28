import type { PullRequestStackPlace, ThreadBoardPullRequestSummaries } from "@octant/contracts";
import type { SidebarThreadStatus } from "@octant/contracts/sidebar-thread-status";
import { pullRequestStateMark } from "../code/pullRequestState";
import { stackPlaceSentence } from "../code/stackPlace";
import { Bot, CircleDot, GitBranch, Layers, Network, type IconComponent } from "../ui/icons";
import { ProjectMark } from "./ProjectMark";
import { CoordinatorMark, WorkerMark } from "./coordinatorMarks";
import type { ReactNode } from "react";
import { useAgentThreadName } from "../agentAccess/agentThreadAttribution";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantSpinner } from "../ui/base/OctantSpinner";
import type { ThreadCheckoutChip, ThreadProviderIdentity } from "../shell/navigationModel";

type ThreadRowPullRequest = ThreadBoardPullRequestSummaries["items"][number];

/** The words a pull request's state is read as on a row. */
const PULL_REQUEST_STATE_WORD: Readonly<Record<ThreadRowPullRequest["state"], string>> = {
  open: "open",
  merged: "merged",
  closed: "closed",
  draft: "draft",
  unknown: "status unknown",
};

/** " and 15 more pull requests", or nothing when the row's pull request is the only one. */
function morePullRequestsWords(more: number | undefined): string {
  if (more === undefined || more <= 0) return "";
  return ` and ${String(more)} more ${more === 1 ? "pull request" : "pull requests"}`;
}

/** "pull request #12 open and 15 more pull requests": the mark's name, said once. */
function pullRequestWords(pullRequest: ThreadRowPullRequest, more: number | undefined): string {
  return `pull request #${String(pullRequest.identity.number)} ${PULL_REQUEST_STATE_WORD[pullRequest.state]}${morePullRequestsWords(more)}`;
}

/** "4 issues": how many other issues a thread wrote to. */
function issueCountWords(count: number): string {
  return `${String(count)} ${count === 1 ? "issue" : "issues"}`;
}

/** "in a stack of 3": the stack mark's name. */
function stackWords(stack: PullRequestStackPlace): string {
  return `in a stack of ${String(stack.size)}`;
}

/** The longest branch a row writes out before it folds the middle away. */
const BRANCH_CHARACTERS = 22;

/**
 * A long branch keeps its start (the kind of work) and its end (the name that
 * tells two apart) and gives up the middle, which a trailing ellipsis would
 * hide along with the end.
 */
export function middleTruncate(label: string, limit: number = BRANCH_CHARACTERS): string {
  const characters = [...label];
  if (characters.length <= limit) return label;
  const keep = limit - 1;
  const head = Math.ceil(keep / 2);
  return `${characters.slice(0, head).join("")}…${characters.slice(characters.length - (keep - head)).join("")}`;
}

/** What a row says of its thread's state: a mark and a short age, with the words in its tooltip. */
export interface SidebarThreadRowState {
  readonly status: SidebarThreadStatus;
  /** The state in words, such as "Working 14m" or "Needs you", for the tooltip. */
  readonly text: string;
  /** The short age drawn beside the mark, such as "14m"; absent when there is none to say. */
  readonly age?: string | undefined;
  readonly icon?: IconComponent | undefined;
}

/**
 * The one name a screen reader hears for a row: the thread's title first, then
 * where it lives, then how it stands. The marks inside the row are all
 * decoration of the same facts, so reading them again would say each twice.
 */
export function sidebarThreadRowLabel(input: {
  readonly title: string;
  readonly projectName?: string | undefined;
  readonly branch?: string | undefined;
  readonly state?: string | undefined;
  readonly age?: string | undefined;
  readonly pullRequest?: ThreadRowPullRequest | undefined;
  /** The thread's pull requests beyond `pullRequest`. */
  readonly morePullRequests?: number | undefined;
  readonly stack?: PullRequestStackPlace | undefined;
  readonly issueKey?: { readonly reference: string } | undefined;
  readonly issueCount?: number | undefined;
}): string {
  return [
    input.title,
    input.projectName,
    input.branch,
    input.pullRequest === undefined
      ? undefined
      : pullRequestWords(input.pullRequest, input.morePullRequests),
    input.stack === undefined ? undefined : stackWords(input.stack),
    input.issueKey === undefined ? undefined : `issue ${input.issueKey.reference}`,
    input.issueCount === undefined || input.issueCount <= 0
      ? undefined
      : `${input.issueKey === undefined ? "" : "and "}${issueCountWords(input.issueCount)}`,
    input.state ?? input.age,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(", ");
}

/**
 * What a sidebar thread row shows, in the one shape the Project tree and the
 * Activity feed share: up to three lines.
 *
 * The title comes first, the strongest text in the row, and its line ends
 * with how the thread stands: a status mark and a short age (a spinner and
 * "9m" while a turn runs, a pause mark and "5m" while it waits on the person),
 * or, with no state to report, how long ago it moved and a dot for new
 * activity. The state's words stay in the tooltip and the row's accessible
 * name. A quiet second line says where the thread lives and what it carries:
 * the Project's small mark and name (the Activity feed, where nothing else
 * says it), the branch in the monospace face, the counted marks (its pull
 * requests in the first one's state colour, its stack, the issue it belongs
 * to and how many others it wrote to), and the provider's mark at its end. A
 * third line appears only when there is something to put on it: who started
 * the thread and a worker's coordinator.
 *
 * Which facts appear is still each view's own property choice: a caller passes
 * only what its view currently shows, and an absent fact leaves no gap. A row
 * with nothing for its second line keeps the provider's mark at the end of the
 * title line instead of opening a line for it.
 */
export function SidebarThreadRowContent(props: {
  readonly title: string;
  /** Names the outside agent that started the thread, when one did. */
  readonly threadId?: string;
  readonly provider?: ThreadProviderIdentity;
  /**
   * A coordinator wears the coordinator mark in place of its provider's, so
   * the role reads at a glance in every view.
   */
  readonly coordinator?: boolean;
  /** A worker's coordinator, named as a fact beneath the title. */
  readonly coordinatorName?: string;
  /**
   * The thread is a worker of the coordinator with this title, listed outside
   * that coordinator: it wears the worker mark, the coordinator mark's smaller
   * pair, instead of its provider's.
   */
  readonly workerOf?: string;
  readonly projectName?: string;
  /** The Project the mark names; absent for "No Project", which keeps the folder and asks for nothing. */
  readonly projectId?: string;
  readonly pullRequest?: ThreadRowPullRequest;
  /**
   * The thread's pull requests beyond `pullRequest`, counted after it as "+15"
   * so a thread that worked through many is not read as having one.
   */
  readonly morePullRequests?: number;
  /** Where the thread's stacked pull request stands; the row counts the stack's layers. */
  readonly stack?: PullRequestStackPlace;
  /** The issue the thread belongs to, named by its key. */
  readonly issueKey?: { readonly reference: string; readonly name: string };
  /** How many other issues the thread's tool calls wrote to. */
  readonly issueCount?: number;
  readonly checkout?: ThreadCheckoutChip;
  /** The short age, or the time a snoozed thread returns. */
  readonly age?: { readonly label: string; readonly title?: string };
  /** The thread's state; its mark and age replace the plain age at the end of the title line. */
  readonly state?: SidebarThreadRowState;
  /** New activity: a dot with its own name beside the age. */
  readonly unread?: boolean;
  /** A coordinator's workers that its row stands for, counted beside the title. */
  readonly workerCounts?: ReactNode;
}) {
  const startedBy = useAgentThreadName(props.threadId);
  const issueCount = props.issueCount ?? 0;
  const hasQuietLine =
    props.projectName !== undefined ||
    props.checkout !== undefined ||
    props.pullRequest !== undefined ||
    props.stack !== undefined ||
    props.issueKey !== undefined ||
    issueCount > 0;
  const hasDetail = startedBy !== undefined || props.coordinatorName !== undefined;
  const pullRequestMark =
    props.pullRequest === undefined ? undefined : pullRequestStateMark(props.pullRequest.state);
  const StateIcon = props.state?.icon;
  const trailing =
    props.state !== undefined ? (
      <span
        className="sidebar-navigation__thread-state"
        data-activity={props.state.status}
        title={props.state.text}
      >
        {props.state.status === "working" ? (
          <OctantSpinner size={12} />
        ) : StateIcon === undefined ? null : (
          <StateIcon aria-hidden="true" size={12} />
        )}
        {props.state.age === undefined ? null : <span>{props.state.age}</span>}
      </span>
    ) : props.age === undefined && props.unread !== true ? null : (
      <span className="sidebar-navigation__thread-when">
        {props.unread === true ? (
          <span
            aria-label="New activity"
            className="sidebar-navigation__thread-unread-dot"
            role="img"
            title="New activity"
          />
        ) : null}
        {props.age === undefined ? null : (
          <span className="sidebar-navigation__thread-age" title={props.age.title}>
            {props.age.label}
          </span>
        )}
      </span>
    );
  // A coordinator and a coordinator's worker wear their role's mark in place
  // of the provider's, so the role reads at a glance in every view.
  const provider =
    props.coordinator === true ? (
      <span className="sidebar-navigation__thread-provider" title="Coordinator">
        <CoordinatorMark />
      </span>
    ) : props.workerOf !== undefined ? (
      <span className="sidebar-navigation__thread-provider" title={`Worker of ${props.workerOf}`}>
        <WorkerMark coordinatorName={props.workerOf} />
      </span>
    ) : props.provider === undefined ? null : (
      <span className="sidebar-navigation__thread-provider" title={props.provider.displayName}>
        <ProviderGlyph
          displayName={props.provider.displayName}
          driverKind={props.provider.driverKind}
          size={12}
        />
      </span>
    );
  return (
    <span className="sidebar-navigation__thread-copy">
      <span className="sidebar-navigation__thread-main">
        <span className="oct-nav-name sidebar-navigation__thread-title">{props.title}</span>
        {props.workerCounts}
        {trailing}
        {hasQuietLine ? null : provider}
      </span>
      {hasQuietLine ? (
        <span className="sidebar-navigation__thread-context">
          {props.projectName === undefined ? null : (
            <span className="sidebar-navigation__thread-project" title={props.projectName}>
              <ProjectMark
                name={props.projectName}
                {...(props.projectId === undefined ? {} : { projectId: props.projectId })}
              />
              <span className="sidebar-navigation__thread-project-label">{props.projectName}</span>
            </span>
          )}
          {props.checkout === undefined ? null : (
            <span className="sidebar-navigation__thread-checkout" title={props.checkout.label}>
              <GitBranch aria-hidden="true" size={12} />
              <span className="sidebar-navigation__thread-checkout-label">
                {middleTruncate(props.checkout.label)}
              </span>
            </span>
          )}
          {/* Each count is one mark: a glyph and a number, named in words for
              a screen reader and a tooltip, so a list of rows can be scanned
              for how much each thread carries. The hover card lists them. */}
          {props.pullRequest === undefined || pullRequestMark === undefined ? null : (
            <span
              aria-label={pullRequestWords(props.pullRequest, props.morePullRequests)}
              className="sidebar-navigation__thread-pr sidebar-navigation__thread-pr-mark"
              data-pr-state={pullRequestMark.tone}
              data-state={props.pullRequest.state}
              role="img"
              title={`Pull request #${String(props.pullRequest.identity.number)} · ${PULL_REQUEST_STATE_WORD[props.pullRequest.state]}${props.pullRequest.checks === "passing" ? " · checks passing" : ""}${morePullRequestsWords(props.morePullRequests)}`}
            >
              <pullRequestMark.Icon aria-hidden="true" size={12} />
              <span aria-hidden="true">{`#${String(props.pullRequest.identity.number)}`}</span>
              {props.morePullRequests === undefined || props.morePullRequests <= 0 ? null : (
                <span aria-hidden="true" className="sidebar-navigation__thread-pr-more">
                  +{String(props.morePullRequests)}
                </span>
              )}
            </span>
          )}
          {props.stack === undefined ? null : (
            <span
              aria-label={stackWords(props.stack)}
              className="sidebar-navigation__thread-count"
              data-count="stack"
              role="img"
              title={stackPlaceSentence(props.stack)}
            >
              <Layers aria-hidden="true" size={12} />
              <span aria-hidden="true">{String(props.stack.size)}</span>
            </span>
          )}
          {props.issueKey === undefined ? null : (
            <span
              aria-label={`issue ${props.issueKey.reference}`}
              className="sidebar-navigation__thread-count"
              data-count="issue-key"
              role="img"
              title={props.issueKey.name}
            >
              <CircleDot aria-hidden="true" size={12} />
              <span aria-hidden="true">{props.issueKey.reference}</span>
            </span>
          )}
          {issueCount <= 0 ? null : (
            <span
              aria-label={`${props.issueKey === undefined ? "" : "and "}${issueCountWords(issueCount)}`}
              className="sidebar-navigation__thread-count"
              data-count="issues"
              role="img"
              title={`Wrote to ${issueCountWords(issueCount)}${props.issueKey === undefined ? "" : ` besides ${props.issueKey.reference}`}`}
            >
              <CircleDot aria-hidden="true" size={12} />
              <span aria-hidden="true">{String(issueCount)}</span>
            </span>
          )}
          {provider}
        </span>
      ) : null}
      {hasDetail ? (
        <span className="sidebar-navigation__thread-detail">
          {startedBy === undefined ? null : (
            <span className="sidebar-navigation__thread-project" title={`Started by ${startedBy}`}>
              <Bot aria-hidden="true" size={12} />
              <span className="sidebar-navigation__thread-project-label">
                {`Started by ${startedBy}`}
              </span>
            </span>
          )}
          {props.coordinatorName === undefined ? null : (
            <span
              className="sidebar-navigation__thread-project"
              title={`Coordinator: ${props.coordinatorName}`}
            >
              <Network aria-hidden="true" size={12} />
              <span className="sidebar-navigation__thread-project-label">
                {props.coordinatorName}
              </span>
            </span>
          )}
        </span>
      ) : null}
    </span>
  );
}
