import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { describe, expect, it, vi } from "vitest";
import {
  CodeProjectPullRequestService,
  type CodeProjectPullRequestAuthorizedProject,
} from "./codeProjectPullRequestService";
import type {
  GhActivePullRequestListResult,
  GhActivePullRequestRow,
  GhPullRequestReviewResult,
} from "./ghPullRequestPort";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectA = decodeProjectId("10000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("10000000-0000-4000-8000-000000000002");
const projectC = decodeProjectId("10000000-0000-4000-8000-000000000003");
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const now = "2026-08-22T08:00:00.000Z";

function codeProject(input: {
  readonly id: typeof projectA;
  readonly name: string;
  readonly root: string;
}): CodeProjectPullRequestAuthorizedProject {
  return {
    id: input.id,
    name: input.name,
    type: "code",
    lifecycle: "active",
    binding: { canonicalRoot: input.root },
  };
}

function ghRow(overrides: Partial<GhActivePullRequestRow> = {}): GhActivePullRequestRow {
  return {
    number: 12,
    title: "List active pull requests",
    draft: false,
    state: "open",
    mergeability: "mergeable",
    author: "octocat",
    baseBranch: "development",
    headBranch: "feature/manual-refresh",
    updatedAt: "2026-08-22T07:00:00Z",
    url: "https://github.com/octant/octant/pull/12",
    checks: "passing",
    review: "approved",
    ...overrides,
  };
}

function serviceFixture(options: {
  readonly projects?: ReadonlyArray<CodeProjectPullRequestAuthorizedProject>;
  readonly remotes?: Record<
    string,
    ReadonlyArray<{ readonly name: string; readonly fetchUrl: string }>
  >;
  readonly list?: (
    request: { readonly owner: string; readonly name: string; readonly limit: number },
    signal: AbortSignal,
  ) => Promise<GhActivePullRequestListResult>;
  readonly detail?: (
    request: {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
      readonly maxDiffBytes: number;
    },
    signal: AbortSignal,
  ) => Promise<GhPullRequestReviewResult>;
  readonly journal?: { readonly append: ReturnType<typeof vi.fn> };
  readonly knownPullRequests?: ReadonlyArray<{
    readonly number: number;
    readonly observedAt: string;
  }>;
}) {
  const listActive = vi.fn(
    options.list ??
      (async () =>
        ({
          status: "ok",
          rows: [ghRow()],
        }) satisfies GhActivePullRequestListResult),
  );
  const observeReviewByIdentity = vi.fn(
    options.detail ?? (async () => ({ status: "unavailable" }) satisfies GhPullRequestReviewResult),
  );
  const journal = options.journal ?? { append: vi.fn() };
  const service = new CodeProjectPullRequestService({
    projects: {
      bootstrap: async () => ({
        active: options.projects ?? [
          codeProject({ id: projectA, name: "Octant", root: "/repos/octant" }),
          codeProject({ id: projectB, name: "Local notes", root: "/repos/notes" }),
        ],
      }),
    },
    remotes: {
      remotes: async (root) =>
        options.remotes?.[root] ??
        (root === "/repos/octant"
          ? [{ name: "origin", fetchUrl: "https://github.com/octant/octant.git" }]
          : []),
    },
    list: { listActive },
    detail: { observeReviewByIdentity },
    threads: {
      list: async () => [
        {
          threadId: String(threadId),
          projectId: String(projectA),
          title: "Manual refresh",
          repository: { owner: "octant", name: "octant" },
          deliveryBranch: "feature/manual-refresh",
          pullRequestNumbers: options.knownPullRequests ?? [],
        },
      ],
    },
    clock: () => now,
  });
  return { service, listActive, observeReviewByIdentity, journal };
}

describe("CodeProjectPullRequestService", () => {
  it("returns authorized projects without invoking GitHub on a cached query", async () => {
    const { service, listActive, journal } = serviceFixture({});

    const view = await service.query(windowId, { version: 1 });

    expect(view.projects).toEqual([
      {
        kind: "connected",
        projectId: projectA,
        projectName: "Octant",
        repositoryOwner: "octant",
        repositoryName: "octant",
      },
      { kind: "unconnected", projectId: projectB, projectName: "Local notes" },
    ]);
    expect(view.rows).toEqual([]);
    expect(view.freshness).toEqual({ status: "empty" });
    expect(listActive).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("resolves HTTPS, SCP-style, and ssh GitHub remotes and leaves other remotes unconnected", async () => {
    const { service } = serviceFixture({
      projects: [
        codeProject({ id: projectA, name: "HTTPS", root: "/https" }),
        codeProject({ id: projectB, name: "SCP", root: "/scp" }),
        codeProject({ id: projectC, name: "SSH", root: "/ssh" }),
        codeProject({
          id: decodeProjectId("10000000-0000-4000-8000-000000000004"),
          name: "Enterprise",
          root: "/enterprise",
        }),
      ],
      remotes: {
        "/https": [{ name: "origin", fetchUrl: "https://github.com/octant/https.git" }],
        "/scp": [{ name: "origin", fetchUrl: "git@github.com:octant/scp.git" }],
        "/ssh": [{ name: "origin", fetchUrl: "ssh://git@github.com/octant/ssh.git" }],
        "/enterprise": [{ name: "origin", fetchUrl: "https://github.example.com/octant/ent.git" }],
      },
    });

    const view = await service.query(windowId, { version: 1 });
    expect(view.projects.map((project) => [project.kind, project.projectName])).toEqual([
      ["connected", "HTTPS"],
      ["connected", "SCP"],
      ["connected", "SSH"],
      ["unconnected", "Enterprise"],
    ]);
  });

  it("does not guess a Project repository from conflicting remotes", async () => {
    const { service } = serviceFixture({
      projects: [codeProject({ id: projectA, name: "Ambiguous", root: "/ambiguous" })],
      remotes: {
        "/ambiguous": [
          { name: "origin", fetchUrl: "https://github.com/acme/one.git" },
          { name: "upstream", fetchUrl: "https://github.com/acme/two.git" },
        ],
      },
    });

    const view = await service.query(windowId, { version: 1 });

    expect(view.projects).toEqual([
      { kind: "unconnected", projectId: projectA, projectName: "Ambiguous" },
    ]);
  });

  it("refreshes repositories sequentially and keeps an unconnected project visible", async () => {
    const order: string[] = [];
    const { service, listActive, journal } = serviceFixture({
      projects: [
        codeProject({ id: projectA, name: "Octant", root: "/repos/octant" }),
        codeProject({ id: projectB, name: "Notes", root: "/repos/notes" }),
        codeProject({ id: projectC, name: "Docs", root: "/repos/docs" }),
      ],
      remotes: {
        "/repos/octant": [{ name: "origin", fetchUrl: "https://github.com/octant/octant.git" }],
        "/repos/notes": [],
        "/repos/docs": [{ name: "origin", fetchUrl: "git@github.com:octant/docs.git" }],
      },
      list: async (request) => {
        order.push(`start:${request.owner}/${request.name}`);
        await Promise.resolve();
        order.push(`end:${request.owner}/${request.name}`);
        return { status: "ok", rows: [ghRow({ number: request.name === "docs" ? 4 : 12 })] };
      },
    });

    const view = await service.refresh(
      windowId,
      { kind: "refresh-all" },
      new AbortController().signal,
    );

    expect(order).toEqual([
      "start:octant/octant",
      "end:octant/octant",
      "start:octant/docs",
      "end:octant/docs",
    ]);
    expect(listActive).toHaveBeenCalledTimes(2);
    expect(view.projects.some((project) => project.kind === "unconnected")).toBe(true);
    expect(view.rows.map((row) => row.number)).toEqual([12, 4]);
    expect(view.rows[0]?.linkedThreads).toEqual([{ threadId, title: "Manual refresh" }]);
    expect(view.freshness).toEqual({ status: "fresh", lastSuccessfulRefreshAt: now });
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("keeps the Project workspace active-only while the board snapshot includes merged history", async () => {
    const { service } = serviceFixture({
      list: async () => ({
        status: "ok",
        rows: [
          ghRow({ number: 12, state: "open" }),
          ghRow({
            number: 11,
            state: "merged",
            mergeability: "unknown",
            updatedAt: "2026-08-22T06:00:00Z",
          }),
        ],
      }),
    });

    const workspace = await service.refresh(
      windowId,
      { kind: "refresh-all" },
      new AbortController().signal,
    );
    const board = await service.boardSnapshot(windowId);

    expect(workspace.rows.map((row) => row.number)).toEqual([12]);
    expect(board.rows.map((row) => [row.number, row.state])).toEqual([
      [12, "open"],
      [11, "merged"],
    ]);
  });

  it("reconstructs merged and closed board history on the first manual refresh after restart", async () => {
    const first = serviceFixture({
      knownPullRequests: [{ number: 11, observedAt: "2026-08-21T08:00:00Z" }],
      list: async () => ({ status: "ok", rows: [] }),
      detail: async () => ({
        ...observedDetail,
        pullRequest: {
          ...observedDetail.pullRequest,
          number: 11,
          url: "https://github.com/octant/octant/pull/11",
          title: "Merged pull request",
          state: "merged",
          mergeability: "unknown",
          updatedAt: "2026-08-22T07:30:00Z",
        },
      }),
    });
    const before = await first.service.boardSnapshot(windowId);
    expect(before.freshness).toEqual({ status: "stale" });
    expect(before.rows[0]).toMatchObject({ number: 11, state: "unknown" });
    expect(first.listActive).not.toHaveBeenCalled();
    expect(first.observeReviewByIdentity).not.toHaveBeenCalled();

    await first.service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);
    expect(first.observeReviewByIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octant", name: "octant", number: 11 }),
      expect.any(AbortSignal),
    );
    expect((await first.service.boardSnapshot(windowId)).rows[0]).toMatchObject({
      number: 11,
      state: "merged",
    });
  });

  it("keeps an unresolved known identity unknown and stale after refresh", async () => {
    const fixture = serviceFixture({
      knownPullRequests: [{ number: 11, observedAt: "2026-08-21T08:00:00Z" }],
      list: async () => ({ status: "ok", rows: [] }),
      detail: async () => ({ status: "unavailable" }),
    });

    await fixture.service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);
    const board = await fixture.service.boardSnapshot(windowId);

    expect(board.rows[0]).toMatchObject({ number: 11, state: "unknown" });
    expect(board.freshness).toMatchObject({ status: "stale", staleReason: "refresh-failed" });
  });

  it("bounds restart-recovered identities before returning a board snapshot", async () => {
    const knownPullRequests = Array.from({ length: 101 }, (_, index) => ({
      number: index + 1,
      observedAt: `2026-08-21T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
    }));
    const fixture = serviceFixture({ knownPullRequests });

    const board = await fixture.service.boardSnapshot(windowId);

    expect(board.rows).toHaveLength(100);
    expect(board.rows[0]?.number).toBe(101);
    expect(board.rows.at(-1)?.number).toBe(2);
  });

  it("refreshes only the requested Project and leaves the other cached rows in place", async () => {
    const { service, listActive } = serviceFixture({
      projects: [
        codeProject({ id: projectA, name: "Octant", root: "/repos/octant" }),
        codeProject({ id: projectC, name: "Docs", root: "/repos/docs" }),
      ],
      remotes: {
        "/repos/octant": [{ name: "origin", fetchUrl: "https://github.com/octant/octant.git" }],
        "/repos/docs": [{ name: "origin", fetchUrl: "https://github.com/octant/docs.git" }],
      },
      list: async (request) => ({
        status: "ok",
        rows: [ghRow({ number: request.name === "docs" ? 4 : 12, title: request.name })],
      }),
    });

    await service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);
    listActive.mockClear();
    const view = await service.refresh(
      windowId,
      { kind: "refresh-project", projectId: projectC },
      new AbortController().signal,
    );

    expect(listActive).toHaveBeenCalledTimes(1);
    expect(listActive.mock.calls[0]?.[0]).toMatchObject({ owner: "octant", name: "docs" });
    expect(view.rows.map((row) => row.number)).toEqual([12, 4]);
  });

  it("bounds the combined cache when one Project is refreshed", async () => {
    let selectedRefresh = false;
    const fixture = serviceFixture({
      projects: [
        codeProject({ id: projectA, name: "Octant", root: "/repos/octant" }),
        codeProject({ id: projectC, name: "Docs", root: "/repos/docs" }),
      ],
      remotes: {
        "/repos/octant": [{ name: "origin", fetchUrl: "https://github.com/octant/octant.git" }],
        "/repos/docs": [{ name: "origin", fetchUrl: "https://github.com/octant/docs.git" }],
      },
      list: async (request) => ({
        status: "ok",
        rows: Array.from(
          { length: selectedRefresh && request.name === "docs" ? 100 : 50 },
          (_, index) => ghRow({ number: index + 1, title: `${request.name} ${index + 1}` }),
        ),
      }),
    });

    await fixture.service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);
    selectedRefresh = true;
    const view = await fixture.service.refresh(
      windowId,
      { kind: "refresh-project", projectId: projectC },
      new AbortController().signal,
    );

    expect(view.rows).toHaveLength(100);
    expect(view.pullRequestsTruncated).toBe(true);
  });

  it("labels refresh when more than 25 connected repositories or 100 pull requests are present", async () => {
    const projects = Array.from({ length: 26 }, (_, index) =>
      codeProject({
        id: decodeProjectId(`10000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`),
        name: `Repo ${index}`,
        root: `/repos/r${index}`,
      }),
    );
    const remotes = Object.fromEntries(
      projects.map((project, index) => [
        `/repos/r${index}`,
        [{ name: "origin", fetchUrl: `https://github.com/octant/r${index}.git` }],
      ]),
    );
    const many = serviceFixture({
      projects,
      remotes,
      list: async () => ({ status: "ok", rows: [ghRow({ number: 1 })] }),
    });
    const truncatedRepos = await many.service.refresh(
      windowId,
      { kind: "refresh-all" },
      new AbortController().signal,
    );
    expect(many.listActive).toHaveBeenCalledTimes(25);
    expect(truncatedRepos.repositoriesTruncated).toBe(true);
    expect(truncatedRepos.pullRequestsTruncated).toBe(false);

    const overflow = serviceFixture({
      list: async (request) => ({
        status: "ok",
        rows: Array.from({ length: request.limit }, (_, index) =>
          ghRow({ number: index + 1, title: `PR ${index + 1}` }),
        ),
      }),
    });
    const truncatedPrs = await overflow.service.refresh(
      windowId,
      { kind: "refresh-all" },
      new AbortController().signal,
    );
    expect(truncatedPrs.rows).toHaveLength(100);
    expect(truncatedPrs.pullRequestsTruncated).toBe(true);
  });

  it("keeps the last authorized snapshot when GitHub rate-limits, times out, or returns malformed output", async () => {
    let next: GhActivePullRequestListResult = { status: "ok", rows: [ghRow()] };
    const { service } = serviceFixture({
      list: async () => next,
    });
    await service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);

    next = { status: "rate-limited", retryAfterSeconds: 30 };
    const rateLimited = await service.refresh(
      windowId,
      { kind: "refresh-all" },
      new AbortController().signal,
    );
    expect(rateLimited.rows).toHaveLength(1);
    expect(rateLimited.rows[0]?.title).toBe("List active pull requests");
    expect(rateLimited.freshness).toEqual({
      status: "stale",
      staleReason: "rate-limited",
      lastSuccessfulRefreshAt: now,
      retryAfter: "2026-08-22T08:00:30.000Z",
    });

    next = { status: "timeout" };
    expect(
      (await service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal))
        .freshness,
    ).toMatchObject({
      status: "stale",
      staleReason: "timeout",
      lastSuccessfulRefreshAt: now,
    });

    next = { status: "malformed" };
    expect(
      (await service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal))
        .freshness,
    ).toMatchObject({
      status: "stale",
      staleReason: "malformed",
    });

    next = { status: "disconnected" };
    const disconnected = await service.refresh(
      windowId,
      { kind: "refresh-all" },
      new AbortController().signal,
    );
    expect(disconnected.rows[0]?.title).toBe("List active pull requests");
    expect(disconnected.freshness.staleReason).toBe("disconnected");

    const cached = await service.query(windowId, { version: 1 });
    expect(cached.rows[0]?.title).toBe("List active pull requests");
    expect(cached.freshness.status).toBe("stale");
  });

  it("drops private pull-request facts when GitHub authority is revoked", async () => {
    const { service } = serviceFixture({});
    await service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);
    service.revokeGithub();

    const view = await service.query(windowId, { version: 1 });
    expect(view.rows).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("List active pull requests");
    expect(JSON.stringify(view)).not.toContain("octocat");
    expect(JSON.stringify(view)).not.toContain("feature/manual-refresh");
    expect(view.freshness).toEqual({ status: "stale", staleReason: "disconnected" });
  });

  it("drops a Project's cached rows once that Project is no longer authorized", async () => {
    let active: ReadonlyArray<CodeProjectPullRequestAuthorizedProject> = [
      codeProject({ id: projectA, name: "Octant", root: "/repos/octant" }),
      codeProject({ id: projectC, name: "Docs", root: "/repos/docs" }),
    ];
    const service = new CodeProjectPullRequestService({
      projects: { bootstrap: async () => ({ active }) },
      remotes: {
        remotes: async (root) =>
          root === "/repos/notes"
            ? []
            : [
                {
                  name: "origin",
                  fetchUrl:
                    root === "/repos/docs"
                      ? "https://github.com/octant/docs.git"
                      : "https://github.com/octant/octant.git",
                },
              ],
      },
      list: {
        listActive: async (request) => ({
          status: "ok",
          rows: [ghRow({ number: request.name === "docs" ? 4 : 12, title: request.name })],
        }),
      },
      detail: { observeReviewByIdentity: async () => ({ status: "unavailable" }) },
      threads: { list: async () => [] },
      clock: () => now,
    });

    await service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);
    active = [codeProject({ id: projectC, name: "Docs", root: "/repos/docs" })];
    const view = await service.query(windowId, { version: 1 });
    expect(view.projects.map((project) => project.projectName)).toEqual(["Docs"]);
    expect(view.rows.map((row) => row.repositoryName)).toEqual(["docs"]);
    expect(view.rows.some((row) => row.repositoryName === "octant")).toBe(false);
  });

  const detailQuery = {
    projectId: projectA,
    repositoryOwner: "octant",
    repositoryName: "octant",
    number: 12,
  } as const;

  const observedDetail = {
    status: "observed",
    freshness: "fresh",
    ambiguous: false,
    staleSections: [],
    pullRequest: {
      number: 12,
      url: "https://github.com/octant/octant/pull/12",
      title: "List active pull requests",
      state: "open",
      baseRepository: "octant/octant",
      baseBranch: "development",
      headRepository: "octant",
      headBranch: "feature/manual-refresh",
      author: "octocat",
      matchesDeliveryBranch: false,
    },
    description: "Verified implementation.",
    diff: "diff --git a/x b/x\n",
    diffTruncated: false,
    commits: [{ oid: "a".repeat(40), messageHeadline: "feat: refresh", author: "octocat" }],
    files: [{ path: "apps/server/src/x.ts", additions: 5, deletions: 1 }],
    checks: [{ name: "web tests", state: "success" }],
    reviews: [{ author: "reviewer", state: "approved", body: "LGTM" }],
    comments: [{ author: "octocat", body: "Ready." }],
  } satisfies GhPullRequestReviewResult;

  it("returns authorized detail from cache without invoking GitHub on query", async () => {
    const { service, observeReviewByIdentity } = serviceFixture({
      detail: async () => observedDetail,
    });

    await service.refreshDetail(windowId, detailQuery, new AbortController().signal);
    observeReviewByIdentity.mockClear();
    const view = await service.queryDetail(windowId, detailQuery);

    expect(observeReviewByIdentity).not.toHaveBeenCalled();
    expect(view.detail).toMatchObject({
      state: "observed",
      number: 12,
      description: "Verified implementation.",
      diff: "diff --git a/x b/x\n",
    });
    expect(view.linkedThreads).toEqual([{ threadId, title: "Manual refresh" }]);
    expect(view.freshness).toEqual({ status: "fresh", lastSuccessfulRefreshAt: now });
  });

  it("keeps the last authorized detail when refresh fails", async () => {
    let next: GhPullRequestReviewResult = observedDetail;
    const { service } = serviceFixture({
      detail: async () => next,
    });

    await service.refreshDetail(windowId, detailQuery, new AbortController().signal);
    next = { status: "unavailable" };
    const view = await service.refreshDetail(windowId, detailQuery, new AbortController().signal);

    expect(view.detail).toMatchObject({ state: "observed", title: "List active pull requests" });
    expect(view.freshness).toEqual({
      status: "stale",
      staleReason: "refresh-failed",
      lastSuccessfulRefreshAt: now,
    });
  });

  it("keeps the last authorized detail when an identity observation is partial", async () => {
    let next: GhPullRequestReviewResult = observedDetail;
    const { service } = serviceFixture({ detail: async () => next });

    await service.refreshDetail(windowId, detailQuery, new AbortController().signal);
    next = {
      ...observedDetail,
      freshness: "stale",
      ambiguous: true,
      staleSections: ["description", "checks"],
      pullRequest: {
        ...observedDetail.pullRequest,
        title: "",
        baseBranch: "",
        headBranch: "",
      },
    };
    const view = await service.refreshDetail(windowId, detailQuery, new AbortController().signal);

    expect(view.detail).toMatchObject({ state: "observed", title: "List active pull requests" });
    expect(view.freshness).toMatchObject({ status: "stale", staleReason: "refresh-failed" });
  });

  it("drops cached detail when GitHub authority is revoked", async () => {
    const { service } = serviceFixture({
      detail: async () => observedDetail,
    });
    await service.refreshDetail(windowId, detailQuery, new AbortController().signal);
    service.revokeGithub();

    const view = await service.queryDetail(windowId, detailQuery);
    expect(view.detail).toEqual({ state: "unavailable" });
    expect(JSON.stringify(view)).not.toContain("Verified implementation.");
    expect(view.freshness).toEqual({ status: "stale", staleReason: "disconnected" });
  });
});
