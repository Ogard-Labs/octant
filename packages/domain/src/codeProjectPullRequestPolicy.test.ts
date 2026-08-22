import { describe, expect, it } from "vitest";
import {
  CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS,
  CODE_PROJECT_PULL_REQUEST_MAX_REPOSITORIES,
  boundActivePullRequestRefresh,
  dropPrivatePullRequestFacts,
  matchLinkedThreadsToPullRequest,
} from "./codeProjectPullRequestPolicy";

const octantRepo = { owner: "octant", name: "octant" };

describe("Code Project pull-request policy", () => {
  it("matches a linked thread only on the exact authorized repository and delivery branch or recorded pull-request identity", () => {
    const byBranch = matchLinkedThreadsToPullRequest({
      pullRequest: {
        repository: octantRepo,
        number: 12,
        headBranch: "feature/manual-refresh",
        title: "List active pull requests",
      },
      threads: [
        {
          threadId: "thread-branch",
          title: "Manual refresh",
          repository: octantRepo,
          deliveryBranch: "feature/manual-refresh",
        },
      ],
    });
    expect(byBranch).toEqual([{ threadId: "thread-branch", title: "Manual refresh" }]);

    const byIdentity = matchLinkedThreadsToPullRequest({
      pullRequest: {
        repository: octantRepo,
        number: 44,
        headBranch: "feature/other",
        title: "Unrelated title",
      },
      threads: [
        {
          threadId: "thread-identity",
          title: "Recorded identity",
          repository: octantRepo,
          pullRequestNumber: 44,
        },
      ],
    });
    expect(byIdentity).toEqual([{ threadId: "thread-identity", title: "Recorded identity" }]);
  });

  it("never matches a linked thread by title or loose branch text", () => {
    expect(
      matchLinkedThreadsToPullRequest({
        pullRequest: {
          repository: octantRepo,
          number: 12,
          headBranch: "feature/manual-refresh",
          title: "List active pull requests",
        },
        threads: [
          {
            threadId: "title-only",
            title: "List active pull requests",
            repository: octantRepo,
            deliveryBranch: "feature/something-else",
          },
          {
            threadId: "loose-branch",
            title: "Nearby branch",
            repository: octantRepo,
            deliveryBranch: "manual-refresh",
          },
          {
            threadId: "other-repo",
            title: "Same branch elsewhere",
            repository: { owner: "octant", name: "other" },
            deliveryBranch: "feature/manual-refresh",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("labels truncation after 25 repositories and 100 active pull requests", () => {
    expect(CODE_PROJECT_PULL_REQUEST_MAX_REPOSITORIES).toBe(25);
    expect(CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS).toBe(100);

    const repositories = Array.from({ length: 27 }, (_, index) => `repo-${index}`);
    const bound = boundActivePullRequestRefresh({
      repositories,
      pullRequestsFor: (repository) =>
        repository === "repo-0"
          ? Array.from({ length: 101 }, (_, index) => `${repository}-${index}`)
          : [],
    });

    expect(bound.repositories).toHaveLength(25);
    expect(bound.repositoriesTruncated).toBe(true);
    expect(bound.pullRequests).toHaveLength(100);
    expect(bound.pullRequestsTruncated).toBe(true);
  });

  it("drops private actionable pull-request facts when authority is revoked", () => {
    expect(
      dropPrivatePullRequestFacts({
        title: "Secret delivery",
        author: "octocat",
        baseBranch: "development",
        headBranch: "feature/secret",
        url: "https://github.com/octant/octant/pull/9",
        number: 9,
      }),
    ).toEqual({ number: 9 });
  });
});
