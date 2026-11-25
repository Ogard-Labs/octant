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
        projectId: "project-a",
        repository: octantRepo,
        number: 12,
        headBranch: "feature/manual-refresh",
        title: "List active pull requests",
      },
      threads: [
        {
          threadId: "thread-branch",
          projectId: "project-a",
          title: "Manual refresh",
          repository: octantRepo,
          deliveryBranch: "feature/manual-refresh",
        },
      ],
    });
    expect(byBranch).toEqual([{ threadId: "thread-branch", title: "Manual refresh" }]);

    const byIdentity = matchLinkedThreadsToPullRequest({
      pullRequest: {
        projectId: "project-a",
        repository: octantRepo,
        number: 44,
        headBranch: "feature/other",
        title: "Unrelated title",
      },
      threads: [
        {
          threadId: "thread-identity",
          projectId: "project-a",
          title: "Recorded identity",
          repository: octantRepo,
          pullRequestNumbers: [{ number: 44, observedAt: "2026-08-22T08:00:00Z" }],
        },
      ],
    });
    expect(byIdentity).toEqual([{ threadId: "thread-identity", title: "Recorded identity" }]);
  });

  it("links a thread to a pull request a tool call wrote to in another of the Project's repositories, and only there", () => {
    const thread = {
      threadId: "thread-tool",
      projectId: "project-a",
      title: "Complete open PRs",
      repository: octantRepo,
      pullRequestNumbers: [
        {
          number: 7,
          observedAt: "2026-11-24T08:00:00Z",
          repository: { owner: "Octant", name: "Site" },
        },
      ],
    };
    const pullRequest = (repository: { owner: string; name: string }) => ({
      projectId: "project-a",
      repository,
      number: 7,
      headBranch: "feature/docs",
      title: "Docs",
    });
    expect(
      matchLinkedThreadsToPullRequest({
        pullRequest: pullRequest({ owner: "octant", name: "site" }),
        threads: [thread],
      }),
    ).toEqual([{ threadId: "thread-tool", title: "Complete open PRs" }]);
    // The same number in the thread's own repository is a different pull request.
    expect(
      matchLinkedThreadsToPullRequest({ pullRequest: pullRequest(octantRepo), threads: [thread] }),
    ).toEqual([]);
  });

  it("keeps a pull request a person unlinked off the thread until the thread touches it again", () => {
    const pullRequest = {
      projectId: "project-a",
      repository: octantRepo,
      number: 12,
      headBranch: "feature/manual-refresh",
      title: "List active pull requests",
    };
    const thread = (observedAt: string) => ({
      threadId: "thread-a",
      projectId: "project-a",
      title: "Manual refresh",
      repository: octantRepo,
      deliveryBranch: "feature/manual-refresh",
      pullRequestNumbers: [{ number: 12, observedAt }],
      unlinkedPullRequests: [
        { owner: "octant", repository: "octant", number: 12, unlinkedAt: "2026-11-24T10:00:00Z" },
      ],
    });
    // Unlinked after its last touch: neither the branch nor the identity links it.
    expect(
      matchLinkedThreadsToPullRequest({ pullRequest, threads: [thread("2026-11-24T09:00:00Z")] }),
    ).toEqual([]);
    // Touched again after the unlink: linked again.
    expect(
      matchLinkedThreadsToPullRequest({ pullRequest, threads: [thread("2026-11-24T11:00:00Z")] }),
    ).toEqual([{ threadId: "thread-a", title: "Manual refresh" }]);
  });

  it("never matches a linked thread by title or loose branch text", () => {
    expect(
      matchLinkedThreadsToPullRequest({
        pullRequest: {
          projectId: "project-a",
          repository: octantRepo,
          number: 12,
          headBranch: "feature/manual-refresh",
          title: "List active pull requests",
        },
        threads: [
          {
            threadId: "title-only",
            projectId: "project-a",
            title: "List active pull requests",
            repository: octantRepo,
            deliveryBranch: "feature/something-else",
          },
          {
            threadId: "loose-branch",
            projectId: "project-a",
            title: "Nearby branch",
            repository: octantRepo,
            deliveryBranch: "manual-refresh",
          },
          {
            threadId: "other-repo",
            projectId: "project-a",
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
