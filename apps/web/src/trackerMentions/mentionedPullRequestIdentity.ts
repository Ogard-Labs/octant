import { decodeThreadBoardPullRequestIdentity } from "@octant/contracts";
import type { ConnectedGitHubRepository, ThreadBoardPullRequestIdentity } from "@octant/contracts";

/** What the window's Project list says; one that names no repository holds no pull request. */
type ListedProject = {
  readonly id: unknown;
  readonly type?: string;
  readonly lifecycle?: string;
  readonly connectedRepository?: ConnectedGitHubRepository | undefined;
};

const PULL_REQUEST = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/;

/**
 * The pull request a mentioned URL names, in a Code Project this window holds
 * for that repository; Octant's pane can show only those.
 */
export function mentionedPullRequestIdentity(
  url: string,
  projects: ReadonlyArray<ListedProject>,
): ThreadBoardPullRequestIdentity | undefined {
  const [, owner, name, number] = PULL_REQUEST.exec(url) ?? [];
  if (owner === undefined || name === undefined || number === undefined) return undefined;
  const project = projects.find(
    (candidate) =>
      candidate.type === "code" &&
      candidate.lifecycle === "active" &&
      candidate.connectedRepository?.owner.toLowerCase() === owner.toLowerCase() &&
      candidate.connectedRepository.repository.toLowerCase() === name.toLowerCase(),
  );
  if (project === undefined) return undefined;
  try {
    return decodeThreadBoardPullRequestIdentity({
      projectId: project.id,
      repositoryOwner: owner,
      repositoryName: name,
      number: Number(number),
    });
  } catch {
    // A typed URL GitHub would never give opens in the browser instead.
    return undefined;
  }
}
