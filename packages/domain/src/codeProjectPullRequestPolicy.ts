export const CODE_PROJECT_PULL_REQUEST_MAX_REPOSITORIES = 25;
export const CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS = 100;

export interface CodeProjectPullRequestRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
}

export interface CodeProjectLinkedThreadFact {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly repository: CodeProjectPullRequestRepositoryIdentity;
  readonly deliveryBranch?: string;
  readonly pullRequestNumbers?: ReadonlyArray<{
    readonly number: number;
    readonly observedAt: string;
  }>;
}

export interface CodeProjectPullRequestMatchTarget {
  readonly projectId: string;
  readonly repository: CodeProjectPullRequestRepositoryIdentity;
  readonly number: number;
  readonly headBranch: string;
  readonly title: string;
}

export interface CodeProjectLinkedThreadEvidence {
  readonly threadId: string;
  readonly title: string;
}

/**
 * Exact linked-thread evidence only: authorized repository plus the delivery
 * branch or a recorded pull-request number. Title text and loose branch
 * fragments never match.
 */
export function matchLinkedThreadsToPullRequest(input: {
  readonly pullRequest: CodeProjectPullRequestMatchTarget;
  readonly threads: ReadonlyArray<CodeProjectLinkedThreadFact>;
}): ReadonlyArray<CodeProjectLinkedThreadEvidence> {
  const matches: CodeProjectLinkedThreadEvidence[] = [];
  for (const thread of input.threads) {
    if (thread.projectId !== input.pullRequest.projectId) continue;
    if (!sameRepository(thread.repository, input.pullRequest.repository)) continue;
    const byBranch =
      thread.deliveryBranch !== undefined && thread.deliveryBranch === input.pullRequest.headBranch;
    const byIdentity =
      thread.pullRequestNumbers?.some((entry) => entry.number === input.pullRequest.number) ===
      true;
    if (!byBranch && !byIdentity) continue;
    matches.push({ threadId: thread.threadId, title: thread.title });
  }
  return matches;
}

export function boundActivePullRequestRefresh<Repository, PullRequest>(input: {
  readonly repositories: ReadonlyArray<Repository>;
  readonly pullRequestsFor: (repository: Repository) => ReadonlyArray<PullRequest>;
}): {
  readonly repositories: ReadonlyArray<Repository>;
  readonly pullRequests: ReadonlyArray<PullRequest>;
  readonly repositoriesTruncated: boolean;
  readonly pullRequestsTruncated: boolean;
} {
  const repositoriesTruncated =
    input.repositories.length > CODE_PROJECT_PULL_REQUEST_MAX_REPOSITORIES;
  const repositories = input.repositories.slice(0, CODE_PROJECT_PULL_REQUEST_MAX_REPOSITORIES);
  const pullRequests: PullRequest[] = [];
  let pullRequestsTruncated = false;
  for (const repository of repositories) {
    for (const pullRequest of input.pullRequestsFor(repository)) {
      if (pullRequests.length >= CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS) {
        pullRequestsTruncated = true;
        break;
      }
      pullRequests.push(pullRequest);
    }
    if (pullRequestsTruncated) break;
  }
  return { repositories, pullRequests, repositoriesTruncated, pullRequestsTruncated };
}

export function dropPrivatePullRequestFacts(input: {
  readonly title: string;
  readonly author: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly url: string;
  readonly number: number;
}): { readonly number: number } {
  return { number: input.number };
}

function sameRepository(
  left: CodeProjectPullRequestRepositoryIdentity,
  right: CodeProjectPullRequestRepositoryIdentity,
): boolean {
  return left.owner === right.owner && left.name === right.name;
}
