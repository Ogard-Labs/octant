import type { ThreadBoardPullRequestSummaries } from "@octant/contracts";
import type { SidebarThreadStatus } from "@octant/contracts/sidebar-thread-status";
import { Bot, GitBranch, GitPullRequest, Network, type IconComponent } from "../ui/icons";
import { ProjectMark } from "./ProjectMark";
import { useAgentThreadName } from "../agentAccess/agentThreadAttribution";
import { ProviderGlyph } from "../providers/ProviderGlyph";
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

/** What a row says of its thread's state: a word, with an icon when it has one. */
export interface SidebarThreadRowState {
  readonly status: SidebarThreadStatus;
  /** The visible words, such as "Working 14m" or "Needs you". */
  readonly text: string;
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
}): string {
  return [
    input.title,
    input.projectName,
    input.branch,
    input.pullRequest === undefined
      ? undefined
      : `pull request #${String(input.pullRequest.identity.number)} ${PULL_REQUEST_STATE_WORD[input.pullRequest.state]}`,
    input.state ?? input.age,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(", ");
}

/**
 * What a sidebar thread row shows, in the one shape the Project tree and the
 * Activity feed share: up to three lines.
 *
 * The top line is small and quiet and says where the thread lives: the
 * Project's mark and name (the Activity feed, where nothing else says it), then
 * the branch in the monospace face. Its end carries the thread's state in words
 * (Working 14m, Needs you) when it has one to report, and otherwise how long
 * ago it moved. The title is the strongest text in the row, on a line of its
 * own. A third line appears only when there is something to put on it: the pull
 * request and its state, or who started the thread. The provider's mark sits at
 * the end of whichever line is last.
 *
 * Which facts appear is still each view's own property choice: a caller passes
 * only what its view currently shows, and an absent fact leaves no gap. A row
 * with no place to name carries its state or age at the end of the title line
 * instead of opening a line for it.
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
  readonly projectName?: string;
  /** The Project the mark names; absent for "No Project", which keeps the folder and asks for nothing. */
  readonly projectId?: string;
  readonly pullRequest?: ThreadRowPullRequest;
  readonly checkout?: ThreadCheckoutChip;
  /** The short age, or the time a snoozed thread returns. */
  readonly age?: { readonly label: string; readonly title?: string };
  /** The thread's state in words; it replaces the age at the end of the top line. */
  readonly state?: SidebarThreadRowState;
  /** New activity: a dot with its own name beside the age. */
  readonly unread?: boolean;
}) {
  const startedBy = useAgentThreadName(props.threadId);
  const hasPlace = props.projectName !== undefined || props.checkout !== undefined;
  const hasDetail =
    startedBy !== undefined ||
    props.coordinatorName !== undefined ||
    props.pullRequest !== undefined;
  const StateIcon = props.state?.icon;
  const trailing =
    props.state !== undefined ? (
      <span
        className="sidebar-navigation__thread-state"
        data-activity={props.state.status}
        title={props.state.text}
      >
        {StateIcon === undefined ? null : <StateIcon aria-hidden="true" size={12} />}
        <span>{props.state.text}</span>
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
  const provider =
    props.coordinator === true ? (
      <span className="sidebar-navigation__thread-provider" title="Coordinator">
        <Network aria-label="Coordinator" role="img" size={12} />
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
      {hasPlace ? (
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
          {trailing}
        </span>
      ) : null}
      <span className="sidebar-navigation__thread-main">
        <span className="oct-nav-name sidebar-navigation__thread-title">{props.title}</span>
        {hasPlace ? null : trailing}
        {hasDetail ? null : provider}
      </span>
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
          {props.pullRequest === undefined ? null : (
            <span
              className="sidebar-navigation__thread-pr sidebar-navigation__thread-pr-mark"
              data-state={props.pullRequest.state}
              title={`Pull request #${String(props.pullRequest.identity.number)} · ${PULL_REQUEST_STATE_WORD[props.pullRequest.state]}${props.pullRequest.checks === "passing" ? " · checks passing" : ""}`}
            >
              <GitPullRequest aria-hidden="true" size={12} />
              {`#${String(props.pullRequest.identity.number)} ${PULL_REQUEST_STATE_WORD[props.pullRequest.state]}`}
            </span>
          )}
          {provider}
        </span>
      ) : null}
    </span>
  );
}
