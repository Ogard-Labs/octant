import { describe, expect, it } from "vitest";
import {
  decodeCodeProjectPullRequestActionCommand,
  decodeCodeProjectPullRequestActionOutcome,
  decodeCodeProjectPullRequestStackMergeCommand,
  decodeCodeProjectPullRequestStackMergeOutcome,
  decodeCodeProjectPullRequestDetailQuery,
  decodeCodeProjectPullRequestDetailRefreshCommand,
  decodeCodeProjectPullRequestDetailView,
  decodeCodeProjectPullRequestMergeCommand,
  decodeCodeProjectPullRequestMergeOutcome,
  decodeCodeProjectPullRequestMergeRecorded,
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
      state: "open",
      mergeability: "mergeable",
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
  projectFreshness: [
    {
      projectId,
      freshness: { status: "fresh", lastSuccessfulRefreshAt: generatedAt },
    },
    {
      projectId: "10000000-0000-4000-8000-000000000002",
      freshness: { status: "empty" },
    },
  ],
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
          state: "open",
          mergeability: "mergeable",
          checks: "passing",
          review: "approved",
          linkedThreads: [{ threadId }],
        },
      ],
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      freshness: { status: "fresh" },
      projectFreshness: [
        { projectId, freshness: { status: "fresh" } },
        {
          projectId: "10000000-0000-4000-8000-000000000002",
          freshness: { status: "empty" },
        },
      ],
    });
  });

  it("keeps who was asked to review when the list recorded it, and still reads a row that did not", () => {
    const withRequest = {
      ...connectedView,
      rows: [{ ...connectedView.rows[0], reviewRequestedFrom: ["reviewer"] }],
    };
    expect(decodeCodeProjectPullRequestView(withRequest).rows[0]?.reviewRequestedFrom).toEqual([
      "reviewer",
    ]);
    expect(decodeCodeProjectPullRequestView(connectedView).rows[0]?.reviewRequestedFrom).toBe(
      undefined,
    );
    expect(() =>
      decodeCodeProjectPullRequestView({
        ...connectedView,
        rows: [{ ...connectedView.rows[0], reviewRequestedFrom: ["ada", "Ada"] }],
      }),
    ).toThrow();
  });

  it("keeps failing checks the list recorded, and still reads a row that did not", () => {
    const withFailure = {
      ...connectedView,
      rows: [
        {
          ...connectedView.rows[0],
          failingChecks: [
            {
              name: "web tests",
              completedAt: "2026-08-22T07:40:00.000Z",
            },
          ],
        },
      ],
    };
    expect(decodeCodeProjectPullRequestView(withFailure).rows[0]?.failingChecks).toEqual([
      {
        name: "web tests",
        completedAt: "2026-08-22T07:40:00.000Z",
      },
    ]);
    expect(decodeCodeProjectPullRequestView(connectedView).rows[0]?.failingChecks).toBe(undefined);
    expect(() =>
      decodeCodeProjectPullRequestView({
        ...connectedView,
        rows: [
          {
            ...connectedView.rows[0],
            failingChecks: Array.from({ length: 9 }, () => ({ name: "web tests" })),
          },
        ],
      }),
    ).toThrow();
  });

  it("labels each Project's background refresh state and refuses duplicate entries", () => {
    expect(
      decodeCodeProjectPullRequestView({
        ...connectedView,
        backgroundRefresh: [
          { projectId, state: "scheduled", nextObservationAt: "2026-08-22T08:02:00.000Z" },
          {
            projectId: "10000000-0000-4000-8000-000000000002",
            state: "unavailable",
          },
        ],
      }),
    ).toMatchObject({
      backgroundRefresh: [
        { projectId, state: "scheduled" },
        { projectId: "10000000-0000-4000-8000-000000000002", state: "unavailable" },
      ],
    });
    expect(() =>
      decodeCodeProjectPullRequestView({
        ...connectedView,
        backgroundRefresh: [
          { projectId, state: "scheduled" },
          { projectId, state: "backing-off" },
        ],
      }),
    ).toThrow();
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

describe("Code Project pull-request detail contracts", () => {
  const detailQuery = {
    projectId,
    repositoryOwner: "octant",
    repositoryName: "octant",
    number: 12,
  };
  const observedDetail = {
    state: "observed",
    freshness: "fresh",
    ambiguous: false,
    staleSections: [],
    number: 12,
    url: "https://github.com/octant/octant/pull/12",
    title: "List active pull requests",
    pullRequestState: "open",
    baseRepository: "octant/octant",
    baseBranch: "development",
    headRepository: "octant",
    headBranch: "feature/manual-refresh",
    headSha: "a".repeat(40),
    author: "octocat",
    matchesDeliveryBranch: false,
    description: "Verified implementation.",
    diff: "diff --git a/x b/x\n",
    diffTruncated: false,
    commits: [{ oid: "a".repeat(40), messageHeadline: "feat: refresh", author: "octocat" }],
    files: [{ path: "apps/server/src/x.ts", additions: 5, deletions: 1 }],
    checks: [{ name: "web tests", state: "success" }],
    reviews: [{ author: "reviewer", state: "approved", body: "LGTM" }],
    comments: [{ author: "octocat", body: "Ready." }],
  } as const;

  it("accepts a cached detail query that cannot secretly refresh GitHub", () => {
    expect(decodeCodeProjectPullRequestDetailQuery(detailQuery)).toEqual(detailQuery);
    expect(() =>
      decodeCodeProjectPullRequestDetailQuery({ ...detailQuery, refresh: true }),
    ).toThrow();
    expect(() =>
      decodeCodeProjectPullRequestDetailQuery({ ...detailQuery, windowId: "win" }),
    ).toThrow();
  });

  it("accepts an explicit detail refresh and refuses renderer-authored repository identity", () => {
    expect(decodeCodeProjectPullRequestDetailRefreshCommand(detailQuery)).toEqual(detailQuery);
    expect(() =>
      decodeCodeProjectPullRequestDetailRefreshCommand({
        ...detailQuery,
        owner: "octant",
        credentials: "secret",
      }),
    ).toThrow();
  });

  it("models explicit merge methods and approval outcomes without accepting forged identity", () => {
    const command = { ...detailQuery, method: "squash" as const, headSha: "a".repeat(40) };
    expect(decodeCodeProjectPullRequestMergeCommand(command)).toEqual(command);
    expect(() =>
      decodeCodeProjectPullRequestMergeCommand({ ...command, credentials: "secret" }),
    ).toThrow();
    expect(
      decodeCodeProjectPullRequestMergeOutcome({
        status: "merged",
        number: 12,
        method: "squash",
        mergedAt: generatedAt,
      }),
    ).toMatchObject({ status: "merged", method: "squash" });
    expect(
      decodeCodeProjectPullRequestMergeOutcome({ status: "refused", reason: "not-mergeable" }),
    ).toEqual({ status: "refused", reason: "not-mergeable" });
  });

  it("records a merge attempt with its approved head and refuses a record that carries a credential", () => {
    const record = {
      projectId: detailQuery.projectId,
      repositoryOwner: detailQuery.repositoryOwner,
      repositoryName: detailQuery.repositoryName,
      number: detailQuery.number,
      method: "squash" as const,
      headSha: "a".repeat(40),
      result: { status: "refused" as const, reason: "stale" as const },
    };
    expect(decodeCodeProjectPullRequestMergeRecorded(record)).toEqual(record);
    expect(() =>
      decodeCodeProjectPullRequestMergeRecorded({ ...record, token: "ghp_secret" }),
    ).toThrow();
    expect(() =>
      decodeCodeProjectPullRequestMergeRecorded({
        ...record,
        result: { status: "merged", token: "ghp_secret" },
      }),
    ).toThrow();
  });

  it("decodes an observed detail with inline description and diff plus linked threads", () => {
    expect(
      decodeCodeProjectPullRequestDetailView({
        version: 1,
        query: detailQuery,
        detail: observedDetail,
        freshness: { status: "fresh", lastSuccessfulRefreshAt: generatedAt },
        linkedThreads: [{ threadId, title: "Manual refresh" }],
        generatedAt,
      }),
    ).toMatchObject({
      detail: { state: "observed", matchesDeliveryBranch: false, diffTruncated: false },
      linkedThreads: [{ threadId }],
    });
  });

  it("refuses credential-bearing pull-request URLs and labels empty or unavailable detail", () => {
    expect(
      decodeCodeProjectPullRequestDetailView({
        version: 1,
        query: detailQuery,
        detail: { state: "empty" },
        freshness: { status: "empty" },
        linkedThreads: [],
        generatedAt,
      }),
    ).toMatchObject({ detail: { state: "empty" } });
    expect(
      decodeCodeProjectPullRequestDetailView({
        version: 1,
        query: detailQuery,
        detail: { state: "unavailable" },
        freshness: {
          status: "stale",
          staleReason: "refresh-failed",
          lastSuccessfulRefreshAt: generatedAt,
        },
        linkedThreads: [],
        generatedAt,
      }),
    ).toMatchObject({ detail: { state: "unavailable" } });
    expect(() =>
      decodeCodeProjectPullRequestDetailView({
        version: 1,
        query: detailQuery,
        detail: {
          ...observedDetail,
          url: "https://secret:token@github.com/octant/octant/pull/12",
        },
        freshness: { status: "fresh", lastSuccessfulRefreshAt: generatedAt },
        linkedThreads: [],
        generatedAt,
      }),
    ).toThrow();
  });
});

describe("pull-request action contracts", () => {
  const target = {
    projectId,
    repositoryOwner: "octant",
    repositoryName: "octant",
    number: 12,
  };

  it("accepts the five actions and nothing else", () => {
    for (const command of [
      { kind: "labels", ...target, add: ["bug"], remove: [] },
      { kind: "comment", ...target, body: "Thanks." },
      { kind: "reply", ...target, reviewThreadId: "PRRT_kwDO1", body: "Fixed." },
      { kind: "close", ...target },
      { kind: "reopen", ...target },
    ]) {
      expect(decodeCodeProjectPullRequestActionCommand(command)).toMatchObject({
        kind: command.kind,
      });
    }
    for (const command of [
      { kind: "approve", ...target },
      { kind: "request-changes", ...target, body: "No." },
      { kind: "close", ...target, deleteBranch: true },
      { kind: "labels", ...target, add: [], remove: [] },
      { kind: "labels", ...target, add: ["a,b"], remove: [] },
      { kind: "labels", ...target, add: Array.from({ length: 21 }, (_, i) => `l${i}`), remove: [] },
      { kind: "comment", ...target, body: "" },
      { kind: "reply", ...target, reviewThreadId: "has spaces", body: "x" },
    ]) {
      expect(() => decodeCodeProjectPullRequestActionCommand(command)).toThrow();
    }
  });

  it("answers done, a named refusal, or unavailable", () => {
    for (const outcome of [
      { status: "done" },
      { status: "refused", reason: "label-not-found" },
      { status: "refused", reason: "merged" },
      { status: "unavailable", reason: "unauthenticated" },
    ]) {
      expect(decodeCodeProjectPullRequestActionOutcome(outcome)).toEqual(outcome);
    }
    expect(() =>
      decodeCodeProjectPullRequestActionOutcome({ status: "refused", reason: "because" }),
    ).toThrow();
  });

  it("takes a stack of one to ten confirmed heads, and a merge command may carry its confirmation", () => {
    const item = (number: number) => ({ number, headSha: "a".repeat(40) });
    const stack = {
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      method: "squash",
      confirmed: true,
      items: [item(1), item(2)],
    };
    expect(decodeCodeProjectPullRequestStackMergeCommand(stack).items).toHaveLength(2);
    for (const bad of [
      { ...stack, items: [] },
      { ...stack, items: Array.from({ length: 11 }, (_, i) => item(i + 1)) },
      { ...stack, confirmed: false },
      { ...stack, confirmed: undefined },
    ]) {
      expect(() => decodeCodeProjectPullRequestStackMergeCommand(bad)).toThrow();
    }
    expect(
      decodeCodeProjectPullRequestMergeCommand({
        ...target,
        method: "merge",
        headSha: "a".repeat(40),
        confirmed: true,
      }),
    ).toMatchObject({ confirmed: true });
    expect(() =>
      decodeCodeProjectPullRequestMergeCommand({
        ...target,
        method: "merge",
        headSha: "a".repeat(40),
        confirmed: false,
      }),
    ).toThrow();
  });

  it("answers a stack merge as merged, refused whole, or stopped with what landed", () => {
    for (const outcome of [
      { status: "merged", merged: [1, 2] },
      { status: "refused", reason: "not-a-chain" },
      {
        status: "stopped",
        merged: [1],
        stoppedAt: 2,
        outcome: { status: "refused", reason: "checks-not-passing" },
      },
    ]) {
      expect(decodeCodeProjectPullRequestStackMergeOutcome(outcome)).toEqual(outcome);
    }
  });
});
