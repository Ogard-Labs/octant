import { describe, expect, it, vi } from "vitest";
import type { GithubAuthenticationSnapshot } from "@octant/contracts";
import { GithubCatalogueService } from "./githubCatalogueService";
import { CacheStatsProjection } from "../cacheStatsProjection";
import { CACHE_BACKOFF_FIRST_DELAY_MS } from "@octant/domain/cache-backoff-policy";

const signal = () => new AbortController().signal;

const readySnapshot: GithubAuthenticationSnapshot = {
  state: "ready",
  account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
  capabilities: [
    { kind: "repository-catalogue", available: true },
    { kind: "issues-read", available: true },
    { kind: "pull-requests-read", available: true },
    { kind: "projects-read", available: true },
  ],
};

const observationRow = {
  nodeId: "R_kgDOG8x1Aa",
  owner: "octant",
  name: "octant",
  visibility: "private" as const,
  defaultBranch: "development",
  viewerPermission: "admin" as const,
};

function fakePort(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listRepositories: vi.fn(async () => ({
      kind: "ok" as const,
      value: { rows: [observationRow], hasNextPage: false },
    })),
    listIssues: vi.fn(async () => ({
      kind: "ok" as const,
      value: {
        rows: [
          {
            number: 7,
            title: "Issue",
            state: "open" as const,
            author: "octocat",
            updatedAt: "2026-08-11T10:00:00Z",
            url: "https://github.com/octant/octant/issues/7",
          },
        ],
        hasNextPage: false,
      },
    })),
    listPullRequests: vi.fn(async () => ({
      kind: "ok" as const,
      value: { rows: [], hasNextPage: false },
    })),
    listProjects: vi.fn(async () => ({
      kind: "ok" as const,
      value: { rows: [], hasNextPage: false },
    })),
    ...overrides,
  };
}

function service(
  options: {
    port?: ReturnType<typeof fakePort>;
    snapshot?: GithubAuthenticationSnapshot | (() => GithubAuthenticationSnapshot);
    now?: () => number;
    cacheStats?: CacheStatsProjection;
  } = {},
) {
  const port = options.port ?? fakePort();
  const snapshot = options.snapshot ?? readySnapshot;
  return {
    port,
    service: new GithubCatalogueService({
      port: port as never,
      snapshot: async () => (typeof snapshot === "function" ? snapshot() : snapshot),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.cacheStats === undefined ? {} : { cacheStats: options.cacheStats }),
    }),
  };
}

describe("GithubCatalogueService", () => {
  it("serves a fresh repository page with per-operation capability state on every row", async () => {
    const { service: catalogue } = service();
    const response = await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(response).toMatchObject({
      kind: "repositories",
      page: {
        sort: "pushed-desc",
        freshness: { status: "fresh" },
        rows: [
          {
            nodeId: "R_kgDOG8x1Aa",
            viewerPermission: "admin",
            capabilities: [
              { kind: "issues-read", available: true },
              { kind: "pull-requests-read", available: true },
              { kind: "projects-read", available: true },
            ],
          },
        ],
      },
    });
  });

  it("gates each read independently on honest capability state", async () => {
    const scopeLimited: GithubAuthenticationSnapshot = {
      state: "scope-limited",
      account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
      capabilities: [
        { kind: "repository-catalogue", available: true },
        { kind: "issues-read", available: true },
        { kind: "pull-requests-read", available: true },
        { kind: "projects-read", available: false, remediation: "read:project scope required" },
      ],
    };
    const { service: catalogue, port } = service({ snapshot: scopeLimited });
    expect(
      await catalogue.read(
        { kind: "projects", owner: "octant", name: "octant", pageSize: 10 },
        signal(),
      ),
    ).toEqual({
      kind: "unavailable",
      capability: "projects-read",
      reason: "scope-limited",
      remediation: "read:project scope required",
    });
    expect(port.listProjects).not.toHaveBeenCalled();
    expect(
      await catalogue.read(
        { kind: "issues", owner: "octant", name: "octant", pageSize: 10 },
        signal(),
      ),
    ).toMatchObject({ kind: "issues" });
  });

  it("maps authentication failure states onto actionable unavailable responses", async () => {
    const { service: catalogue, port } = service({
      snapshot: { state: "unauthorized", capabilities: [] },
    });
    expect(await catalogue.read({ kind: "repositories", pageSize: 10 }, signal())).toEqual({
      kind: "unavailable",
      capability: "repository-catalogue",
      reason: "unauthorized",
    });
    expect(port.listRepositories).not.toHaveBeenCalled();
  });

  it("serves a cached page while fresh instead of refetching", async () => {
    let clock = 0;
    const { service: catalogue, port } = service({ now: () => clock });
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    clock += 1_000;
    const second = await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(port.listRepositories).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      kind: "repositories",
      page: { freshness: { status: "fresh" } },
    });
  });

  it("refresh bypasses the cache and a refresh failure labels the stale page", async () => {
    let clock = 0;
    let fail = false;
    const port = fakePort({
      listRepositories: vi.fn(async () =>
        fail
          ? { kind: "rate-limited" as const }
          : { kind: "ok" as const, value: { rows: [observationRow], hasNextPage: false } },
      ),
    });
    const { service: catalogue } = service({ port, now: () => clock });
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    fail = true;
    clock += 1_000;
    const stale = await catalogue.read(
      { kind: "repositories", pageSize: 30, refresh: true },
      signal(),
    );
    expect(port.listRepositories).toHaveBeenCalledTimes(2);
    expect(stale).toMatchObject({
      kind: "repositories",
      page: { freshness: { status: "stale", staleReason: "refresh-failed" } },
    });
  });

  it("labels rate-limited stale pages and surfaces retry facts when nothing is cached", async () => {
    const port = fakePort({
      listRepositories: vi.fn(async () => ({
        kind: "rate-limited" as const,
        retryAfterSeconds: 30,
      })),
    });
    const { service: catalogue } = service({ port });
    expect(await catalogue.read({ kind: "repositories", pageSize: 30 }, signal())).toEqual({
      kind: "unavailable",
      capability: "repository-catalogue",
      reason: "rate-limited",
      retryAfterSeconds: 30,
    });
  });

  it("never serves cached private data after the authenticated account changes", async () => {
    let clock = 0;
    let login = "octocat";
    const { service: catalogue, port } = service({
      now: () => clock,
      snapshot: () => ({
        ...readySnapshot,
        account: { login, gitProtocol: "https", scopes: ["repo"] },
      }),
    });
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    await catalogue.recordRecentRepository(
      { kind: "record-recent-repository", nodeId: "R_kgDOG8x1Aa" },
      signal(),
    );
    login = "someone-else";
    clock += 1_000;
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(port.listRepositories).toHaveBeenCalledTimes(2);
    expect(await catalogue.read({ kind: "recent-repositories" }, signal())).toEqual({
      kind: "recent-repositories",
      rows: [],
    });
  });

  it("records recents only for repositories the server itself observed", async () => {
    const { service: catalogue } = service();
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(
      await catalogue.recordRecentRepository(
        { kind: "record-recent-repository", nodeId: "R_kgDOG8x1Aa" },
        signal(),
      ),
    ).toMatchObject({ kind: "recent-repositories", rows: [{ nodeId: "R_kgDOG8x1Aa" }] });
    expect(
      await catalogue.recordRecentRepository(
        { kind: "record-recent-repository", nodeId: "R_invented" },
        signal(),
      ),
    ).toMatchObject({ kind: "unavailable", capability: "repository-catalogue" });
  });

  it("bounds the recents list to the most recent twenty selections", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      ...observationRow,
      nodeId: `R_${index}`,
      name: `repo-${index}`,
    }));
    const port = fakePort({
      listRepositories: vi.fn(async () => ({
        kind: "ok" as const,
        value: { rows, hasNextPage: false },
      })),
    });
    const { service: catalogue } = service({ port });
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    for (const row of rows) {
      await catalogue.recordRecentRepository(
        { kind: "record-recent-repository", nodeId: row.nodeId },
        signal(),
      );
    }
    const recents = await catalogue.read({ kind: "recent-repositories" }, signal());
    if (recents.kind !== "recent-repositories") throw new Error("expected recents");
    expect(recents.rows).toHaveLength(20);
    expect(recents.rows[0]).toMatchObject({ nodeId: "R_24" });
  });

  it("propagates invalid cursors instead of retrying", async () => {
    const port = fakePort({
      listIssues: vi.fn(async () => ({ kind: "invalid-cursor" as const })),
    });
    const { service: catalogue } = service({ port });
    expect(
      await catalogue.read(
        {
          kind: "issues",
          owner: "octant",
          name: "octant",
          pageSize: 10,
          cursor: "Zm9yZ2Vk",
        },
        signal(),
      ),
    ).toEqual({ kind: "unavailable", capability: "issues-read", reason: "invalid-cursor" });
  });

  it("stops re-asking a failing GitHub on every read until the pacing delay passes", async () => {
    const clock = { ms: 1_000 };
    const now = () => clock.ms;
    const port = fakePort({
      listRepositories: vi.fn(async () => ({ kind: "rate-limited" as const })),
    });
    const cacheStats = new CacheStatsProjection({
      now,
      clock: () => new Date(clock.ms).toISOString(),
    });
    const { service: catalogue } = service({ port, now, cacheStats });

    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(port.listRepositories).toHaveBeenCalledTimes(1);

    // An expired entry would normally be refetched; while the streak paces the
    // cache, GitHub is left alone instead.
    clock.ms += 1;
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(port.listRepositories).toHaveBeenCalledTimes(1);

    clock.ms += CACHE_BACKOFF_FIRST_DELAY_MS;
    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(port.listRepositories).toHaveBeenCalledTimes(2);
    expect(cacheStats.read()).toEqual([
      expect.objectContaining({ key: "github-catalogue", failureStreak: 2 }),
    ]);
  });

  it("still reads GitHub for a refresh the user asked for while pacing failures", async () => {
    const clock = { ms: 1_000 };
    const now = () => clock.ms;
    const port = fakePort({
      listRepositories: vi.fn(async () => ({ kind: "unavailable" as const })),
    });
    const cacheStats = new CacheStatsProjection({
      now,
      clock: () => new Date(clock.ms).toISOString(),
    });
    const { service: catalogue } = service({ port, now, cacheStats });

    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    await catalogue.read({ kind: "repositories", pageSize: 30, refresh: true }, signal());

    expect(port.listRepositories).toHaveBeenCalledTimes(2);
  });

  it("does not hold the next account's unattended reads after a rate-limited previous account", async () => {
    const clock = { ms: 1_000 };
    const now = () => clock.ms;
    let login = "octocat";
    let failing = true;
    const port = fakePort({
      listRepositories: vi.fn(async () =>
        failing
          ? { kind: "rate-limited" as const }
          : {
              kind: "ok" as const,
              value: { rows: [observationRow], hasNextPage: false },
            },
      ),
    });
    const cacheStats = new CacheStatsProjection({
      now,
      clock: () => new Date(clock.ms).toISOString(),
    });
    const { service: catalogue } = service({
      port,
      now,
      cacheStats,
      snapshot: () => ({
        ...readySnapshot,
        account: { login, gitProtocol: "https", scopes: ["repo"] },
      }),
    });

    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(port.listRepositories).toHaveBeenCalledTimes(1);
    expect(cacheStats.holdsUnattendedRefresh("github-catalogue")).toBe(true);

    failing = false;
    login = "someone-else";
    clock.ms += 1;

    const response = await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    expect(port.listRepositories).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({
      kind: "repositories",
      page: { freshness: { status: "fresh" } },
    });
    expect(cacheStats.holdsUnattendedRefresh("github-catalogue")).toBe(false);
  });

  it("clears the failure streak once GitHub answers again", async () => {
    const clock = { ms: 1_000 };
    const now = () => clock.ms;
    let failing = true;
    const port = fakePort({
      listRepositories: vi.fn(async () =>
        failing
          ? { kind: "unavailable" as const }
          : {
              kind: "ok" as const,
              value: { rows: [observationRow], hasNextPage: false },
            },
      ),
    });
    const cacheStats = new CacheStatsProjection({
      now,
      clock: () => new Date(clock.ms).toISOString(),
    });
    const { service: catalogue } = service({ port, now, cacheStats });

    await catalogue.read({ kind: "repositories", pageSize: 30 }, signal());
    failing = false;
    await catalogue.read({ kind: "repositories", pageSize: 30, refresh: true }, signal());

    expect(cacheStats.read()).toEqual([
      expect.objectContaining({
        failureStreak: 0,
        lastRefreshAt: new Date(clock.ms).toISOString(),
      }),
    ]);
    expect(cacheStats.holdsUnattendedRefresh("github-catalogue")).toBe(false);
  });

  it("fails closed when a port row violates the renderer contract", async () => {
    const port = fakePort({
      listRepositories: vi.fn(async () => ({
        kind: "ok" as const,
        value: {
          rows: [{ ...observationRow, defaultBranch: "ghp_abcdefghijklmnopqrstuv" }],
          hasNextPage: false,
        },
      })),
    });
    const { service: catalogue } = service({ port });
    expect(await catalogue.read({ kind: "repositories", pageSize: 30 }, signal())).toMatchObject({
      kind: "unavailable",
      capability: "repository-catalogue",
      reason: "unavailable",
    });
  });
});
