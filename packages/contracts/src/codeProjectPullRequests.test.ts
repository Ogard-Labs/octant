import { describe, expect, it } from "vitest";
import {
  decodeCodeProjectPullRequestQuery,
  decodeCodeProjectPullRequestRefreshCommand,
  decodeCodeProjectPullRequestView,
} from "./codeProjectPullRequests";

const projectId = "10000000-0000-4000-8000-000000000001";
const threadId = "20000000-0000-4000-8000-000000000001";
const generatedAt = "2026-08-22T08:00:00.000Z";

const connectedView = {
  version: 1,
  query: { version: 1 },
  projects: [
    {
      kind: "connected",
      projectId,
      projectName: "Octant",
      repositoryOwner: "octant",
      repositoryName: "octant",
    },
    {
      kind: "unconnected",
      projectId: "10000000-0000-4000-8000-000000000002",
      projectName: "Local notes",
    },
  ],
  rows: [
    {
      projectId,
      projectName: "Octant",
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 12,
      title: "List active pull requests",
      draft: false,
      author: "octocat",
      baseBranch: "development",
      headBranch: "feature/manual-refresh",
      updatedAt: "2026-08-22T07:00:00.000Z",
      checks: "passing",
      review: "approved",
      linkedThreads: [{ threadId, title: "Manual refresh" }],
    },
  ],
  repositoriesTruncated: false,
  pullRequestsTruncated: false,
  freshness: {
    status: "fresh",
    lastSuccessfulRefreshAt: generatedAt,
  },
  generatedAt,
};

describe("Code Project pull-request contracts", () => {
  it("accepts a cached query that cannot secretly refresh GitHub", () => {
    expect(decodeCodeProjectPullRequestQuery({ version: 1 })).toEqual({ version: 1 });
    expect(() => decodeCodeProjectPullRequestQuery({ version: 1, refresh: true })).toThrow();
    expect(() =>
      decodeCodeProjectPullRequestQuery({
        version: 1,
        owner: "octant",
        name: "octant",
      }),
    ).toThrow();
    expect(() => decodeCodeProjectPullRequestQuery({ version: 1, windowId: "win" })).toThrow();
  });

  it("accepts an explicit refresh-all or per-Project refresh and refuses renderer-authored repository identity", () => {
    expect(decodeCodeProjectPullRequestRefreshCommand({ kind: "refresh-all" })).toEqual({
      kind: "refresh-all",
    });
    expect(
      decodeCodeProjectPullRequestRefreshCommand({ kind: "refresh-project", projectId }),
    ).toEqual({ kind: "refresh-project", projectId });
    expect(() =>
      decodeCodeProjectPullRequestRefreshCommand({
        kind: "refresh-all",
        owner: "octant",
        name: "octant",
      }),
    ).toThrow();
    expect(() =>
      decodeCodeProjectPullRequestRefreshCommand({
        kind: "refresh-project",
        projectId,
        credentials: "secret",
      }),
    ).toThrow();
  });

  it("decodes a Project-scoped snapshot with connection, row facts, freshness, and truncation labels", () => {
    expect(decodeCodeProjectPullRequestView(connectedView)).toMatchObject({
      version: 1,
      projects: [{ kind: "connected" }, { kind: "unconnected" }],
      rows: [
        {
          number: 12,
          draft: false,
          checks: "passing",
          review: "approved",
          linkedThreads: [{ threadId }],
        },
      ],
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      freshness: { status: "fresh" },
    });
  });

  it("labels a stale retained snapshot with reason, last success, and retry time", () => {
    expect(
      decodeCodeProjectPullRequestView({
        ...connectedView,
        freshness: {
          status: "stale",
          staleReason: "rate-limited",
          lastSuccessfulRefreshAt: generatedAt,
          retryAfter: "2026-08-22T08:05:00.000Z",
        },
      }),
    ).toMatchObject({
      freshness: {
        status: "stale",
        staleReason: "rate-limited",
        lastSuccessfulRefreshAt: generatedAt,
        retryAfter: "2026-08-22T08:05:00.000Z",
      },
    });
    for (const staleReason of ["timeout", "malformed", "disconnected", "refresh-failed"] as const) {
      expect(
        decodeCodeProjectPullRequestView({
          ...connectedView,
          freshness: { status: "stale", staleReason, lastSuccessfulRefreshAt: generatedAt },
        }),
      ).toMatchObject({ freshness: { status: "stale", staleReason } });
    }
  });
});
