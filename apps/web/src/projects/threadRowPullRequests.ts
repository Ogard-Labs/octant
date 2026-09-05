import type { ThreadBoardPullRequestIdentity } from "@octant/contracts";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import type { ThreadRowActions } from "./ThreadRowMenu";

export function pullRequestKey(identity: ThreadBoardPullRequestIdentity): string {
  return `${String(identity.projectId)}:${identity.repositoryOwner}/${identity.repositoryName}#${String(identity.number)}`;
}

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
 * A route the host did not wire is left out rather than shown inert.
 */
export function threadRowPullRequestDestinations(
  thread: ChatThreadNavigationItem,
  actions: Pick<ThreadRowActions, "onOpenPullRequest" | "onOpenPullRequestOnGithub">,
): ReadonlyArray<ThreadRowPullRequestDestination> {
  const items = thread.pullRequests?.items ?? [];
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
