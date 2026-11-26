import type {
  PullRequestStackPlace,
  ThreadBoardPullRequestIdentity,
  ThreadBoardPullRequestSummaries,
  ThreadLinkedIssue,
  ThreadTouchedIssue,
  ThreadTouchedIssues,
} from "@octant/contracts";
import { touchedIssueName, touchedIssueReference } from "../environment/touchedIssues";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import type { ThreadRowActions } from "./ThreadRowMenu";

/**
 * How many pull requests a thread has beyond the one its row names, counting
 * those past the navigation entry's bound too, so a thread that worked through
 * many never reads on its row as having one.
 */
export function morePullRequestsThanTheFirst(
  summaries: ThreadBoardPullRequestSummaries | undefined,
): number {
  if (summaries === undefined || summaries.items.length === 0) return 0;
  return summaries.items.length - 1 + summaries.hiddenCount;
}

/**
 * The stack place a row counts: the first of the thread's pull requests that
 * stands in a stack, in the host's order, which puts the ones in flight first.
 */
export function threadRowStack(
  summaries: ThreadBoardPullRequestSummaries | undefined,
): PullRequestStackPlace | undefined {
  return summaries?.items.find((summary) => summary.stack !== undefined)?.stack;
}

/** An issue a row names by its key: a Linear key or a GitHub "#3", with its words for a tooltip. */
export interface ThreadRowIssueKey {
  readonly reference: string;
  readonly name: string;
}

/** What a row says of a thread's issues: the one it belongs to, and how many others it wrote to. */
export interface ThreadRowIssues {
  readonly key?: ThreadRowIssueKey;
  /** Touched issues other than the keyed one; 0 when there are none. */
  readonly count: number;
}

export function linkedIssueReference(link: ThreadLinkedIssue): string {
  return link.issue.forge === "github" ? `#${String(link.issue.number)}` : link.issue.identifier;
}

/** One stable key per linked issue across both forges. */
export function linkedIssueKey(link: ThreadLinkedIssue): string {
  return link.issue.forge === "github"
    ? `github:${link.issue.owner}/${link.issue.repository}#${String(link.issue.number)}`
    : `linear:${link.issue.identifier}`;
}

/** A link in words, when no write has said anything more of its issue. */
function unwrittenLinkName(link: ThreadLinkedIssue): string {
  return `${link.issue.forge === "github" ? "GitHub" : "Linear"} issue ${linkedIssueReference(link)}`;
}

function sameIssue(link: ThreadLinkedIssue, touched: ThreadTouchedIssue): boolean {
  if (link.issue.forge === "github" && touched.forge === "github") {
    return (
      link.issue.number === touched.number &&
      link.issue.owner.toLowerCase() === touched.owner.toLowerCase() &&
      link.issue.repository.toLowerCase() === touched.repository.toLowerCase()
    );
  }
  return (
    link.issue.forge === "linear" &&
    touched.forge === "linear" &&
    link.issue.identifier === touched.identifier
  );
}

/** One issue line of the details card: a link, a write, or both for the same issue. */
export type ThreadCardIssue =
  | { readonly kind: "linked"; readonly link: ThreadLinkedIssue; readonly name: string }
  | {
      readonly kind: "touched";
      readonly issue: ThreadTouchedIssue;
      readonly linked: boolean;
      readonly name: string;
    };

/**
 * The details card's issues: the linked ones first, then the others the
 * thread's tool calls wrote to. An issue that is both is one line, said with
 * what the write knew of it, since a link holds no title or state.
 */
export function threadCardIssues(input: {
  readonly linkedIssues?: ReadonlyArray<ThreadLinkedIssue> | undefined;
  readonly touchedIssues?: ThreadTouchedIssues | undefined;
}): ReadonlyArray<ThreadCardIssue> {
  const linked = input.linkedIssues ?? [];
  const touched = input.touchedIssues?.items ?? [];
  const linkedLines = linked.map((link): ThreadCardIssue => {
    const issue = touched.find((candidate) => sameIssue(link, candidate));
    if (issue !== undefined) {
      return {
        kind: "touched",
        issue,
        linked: true,
        name: `${touchedIssueName(issue)}, Linked`,
      };
    }
    const place =
      link.issue.forge === "github" ? `, ${link.issue.owner}/${link.issue.repository}` : "";
    return { kind: "linked", link, name: `${unwrittenLinkName(link)}${place}, Linked` };
  });
  const otherLines = touched
    .filter((issue) => !linked.some((link) => sameIssue(link, issue)))
    .map(
      (issue): ThreadCardIssue => ({
        kind: "touched",
        issue,
        linked: false,
        name: touchedIssueName(issue),
      }),
    );
  return [...linkedLines, ...otherLines];
}

/**
 * A row names the issue a thread belongs to by its key, and counts the other
 * issues its tool calls wrote to. A thread belongs to an issue when it is
 * linked to exactly one, or, linked to none, when it wrote to exactly one.
 * Both come from the navigation entry the host already sent; drawing a row
 * asks no tracker anything.
 */
export function threadRowIssues(input: {
  readonly linkedIssues?: ReadonlyArray<ThreadLinkedIssue> | undefined;
  readonly touchedIssues?: ThreadTouchedIssues | undefined;
}): ThreadRowIssues {
  const linked = input.linkedIssues ?? [];
  const touched = input.touchedIssues?.items ?? [];
  const hidden = input.touchedIssues?.hiddenCount ?? 0;
  const soleLink = linked.length === 1 ? linked[0] : undefined;
  if (soleLink !== undefined) {
    const described = touched.find((issue) => sameIssue(soleLink, issue));
    const reference = linkedIssueReference(soleLink);
    return {
      key: {
        reference,
        name: described === undefined ? unwrittenLinkName(soleLink) : touchedIssueName(described),
      },
      count: touched.length - (described === undefined ? 0 : 1) + hidden,
    };
  }
  const soleTouched =
    linked.length === 0 && hidden === 0 && touched.length === 1 ? touched[0] : undefined;
  if (soleTouched !== undefined) {
    return {
      key: { reference: touchedIssueReference(soleTouched), name: touchedIssueName(soleTouched) },
      count: 0,
    };
  }
  return { count: touched.length + hidden };
}

/** The counted marks a row passes on beside its first pull request. */
export interface ThreadRowCounts {
  readonly stack?: PullRequestStackPlace;
  readonly issueKey?: ThreadRowIssueKey;
  readonly issueCount?: number;
}

export const NO_THREAD_ROW_COUNTS: ThreadRowCounts = {};

/** A row's stack and issue marks, from its navigation entry alone. */
export function threadRowCounts(
  thread: Pick<ChatThreadNavigationItem, "pullRequests" | "touchedIssues" | "linkedIssues">,
): ThreadRowCounts {
  const stack = threadRowStack(thread.pullRequests);
  const issues = threadRowIssues(thread);
  return {
    ...(stack === undefined ? {} : { stack }),
    ...(issues.key === undefined ? {} : { issueKey: issues.key }),
    ...(issues.count > 0 ? { issueCount: issues.count } : {}),
  };
}

export function pullRequestKey(identity: ThreadBoardPullRequestIdentity): string {
  return `${String(identity.projectId)}:${identity.repositoryOwner}/${identity.repositoryName}#${String(identity.number)}`;
}

/**
 * How many of a thread's pull requests a row menu lists inline. A thread can
 * carry dozens, two destinations each; past this the right-click menu folds
 * them into a Pull requests submenu and the flat overflow menu keeps only the
 * most relevant few, so neither menu becomes a wall of pull requests.
 */
export const THREAD_ROW_MENU_INLINE_PULL_REQUESTS = 3;

export interface ThreadRowPullRequestDestination {
  readonly key: string;
  readonly label: string;
  readonly run: () => void;
}

/**
 * The pull-request destinations a row's menus offer, one pair per exact
 * linked pull request: Review inside Octant, then github.com. The menus are
 * the route for keyboard and coarse-pointer use, where the hover card never
 * opens, so every destination the card offers has to be reachable here too.
 * A route the host did not wire is left out rather than shown inert. `limit`
 * keeps only the first pull requests, which the host already orders in-flight
 * first.
 */
export function threadRowPullRequestDestinations(
  thread: ChatThreadNavigationItem,
  actions: Pick<ThreadRowActions, "onOpenPullRequest" | "onOpenPullRequestOnGithub">,
  limit?: number,
): ReadonlyArray<ThreadRowPullRequestDestination> {
  const all = thread.pullRequests?.items ?? [];
  const items = limit === undefined ? all : all.slice(0, limit);
  const destinations: ThreadRowPullRequestDestination[] = [];
  for (const summary of items) {
    const key = pullRequestKey(summary.identity);
    const number = String(summary.identity.number);
    const openInReview = actions.onOpenPullRequest;
    if (openInReview !== undefined) {
      destinations.push({
        key: `pr-open:${key}`,
        label: `Open pull request #${number}`,
        run: () => openInReview(summary.identity),
      });
    }
    const openOnGithub = actions.onOpenPullRequestOnGithub;
    if (openOnGithub !== undefined) {
      destinations.push({
        key: `pr-github:${key}`,
        label: `Open #${number} on GitHub`,
        run: () => openOnGithub(summary.identity),
      });
    }
  }
  return destinations;
}
