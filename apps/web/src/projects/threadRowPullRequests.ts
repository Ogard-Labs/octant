import type {
  ThreadBoardPullRequestIdentity,
  ThreadBoardPullRequestSummaries,
} from "@octant/contracts";
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
