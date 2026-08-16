import { describe, expect, it } from "vitest";
import {
  decodeGithubCatalogueReadRequest,
  decodeGithubCatalogueReadResponse,
  decodeGithubRecentRepositoryCommand,
} from "./githubCatalogue";

const repositoryRow = {
  nodeId: "R_kgDOG8x1Aa",
  owner: "octant",
  name: "octant",
  visibility: "private",
  defaultBranch: "development",
  viewerPermission: "admin",
  capabilities: [
    { kind: "issues-read", available: true },
    { kind: "pull-requests-read", available: true },
    { kind: "projects-read", available: false, remediation: "read:project scope required" },
  ],
} as const;

describe("GitHub catalogue contracts", () => {
  it("accepts a bounded repository page with identity, permission, and capability facts", () => {
    const decoded = decodeGithubCatalogueReadResponse({
      kind: "repositories",
      page: {
        rows: [repositoryRow],
        hasNextPage: true,
        endCursor: "eyJwYWdlIjoyfQ",
        sort: "pushed-desc",
        freshness: { status: "fresh" },
      },
    });
    expect(decoded).toMatchObject({
      kind: "repositories",
      page: { rows: [{ nodeId: "R_kgDOG8x1Aa", viewerPermission: "admin" }], hasNextPage: true },
    });
  });

  it("labels a served stale page with an explicit reason", () => {
    expect(
      decodeGithubCatalogueReadResponse({
        kind: "repositories",
        page: {
          rows: [],
          hasNextPage: false,
          sort: "pushed-desc",
          freshness: { status: "stale", staleReason: "rate-limited" },
        },
      }),
    ).toMatchObject({ page: { freshness: { status: "stale", staleReason: "rate-limited" } } });
  });

  it("bounds the requested page size between 1 and 100", () => {
    expect(decodeGithubCatalogueReadRequest({ kind: "repositories", pageSize: 100 })).toMatchObject(
      { pageSize: 100 },
    );
    expect(() => decodeGithubCatalogueReadRequest({ kind: "repositories", pageSize: 0 })).toThrow();
    expect(() =>
      decodeGithubCatalogueReadRequest({ kind: "repositories", pageSize: 101 }),
    ).toThrow();
    expect(() =>
      decodeGithubCatalogueReadRequest({ kind: "repositories", pageSize: 5.5 }),
    ).toThrow();
  });

  it("accepts only opaque url-safe cursors", () => {
    expect(
      decodeGithubCatalogueReadRequest({
        kind: "repositories",
        pageSize: 30,
        cursor: "eyJwYWdlIjoyLCJvZmZzZXQiOjN9",
      }),
    ).toMatchObject({ cursor: "eyJwYWdlIjoyLCJvZmZzZXQiOjN9" });
    expect(() =>
      decodeGithubCatalogueReadRequest({
        kind: "repositories",
        pageSize: 30,
        cursor: "page=2&owner=../secrets",
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCatalogueReadRequest({
        kind: "repositories",
        pageSize: 30,
        cursor: "x".repeat(601),
      }),
    ).toThrow();
  });

  it("rejects raw endpoint, flag, field, host, and mutation selection at the request boundary", () => {
    expect(() =>
      decodeGithubCatalogueReadRequest({
        kind: "repositories",
        pageSize: 30,
        endpoint: "/user/repos",
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCatalogueReadRequest({
        kind: "repositories",
        pageSize: 30,
        hostname: "ghe.example",
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCatalogueReadRequest({
        kind: "issues",
        owner: "octant",
        name: "octant",
        pageSize: 30,
        fields: ["title"],
      }),
    ).toThrow();
    expect(() => decodeGithubCatalogueReadRequest({ kind: "mutate-issue" })).toThrow();
  });

  it("validates strict owner and repository identities on scoped reads", () => {
    expect(
      decodeGithubCatalogueReadRequest({
        kind: "pull-requests",
        owner: "octant-labs",
        name: "repo.name_1",
        pageSize: 25,
      }),
    ).toMatchObject({ owner: "octant-labs", name: "repo.name_1" });
    for (const owner of ["-leading", "a".repeat(40), "own/er", "own er", ""]) {
      expect(() =>
        decodeGithubCatalogueReadRequest({ kind: "issues", owner, name: "repo", pageSize: 10 }),
      ).toThrow();
    }
    for (const name of ["..", ".", "a".repeat(101), "na/me", ""]) {
      expect(() =>
        decodeGithubCatalogueReadRequest({
          kind: "issues",
          owner: "octant",
          name,
          pageSize: 10,
        }),
      ).toThrow();
    }
  });

  it("bounds issue, pull-request, and project rows and pins their URLs to github.com", () => {
    const decoded = decodeGithubCatalogueReadResponse({
      kind: "issues",
      page: {
        rows: [
          {
            number: 770,
            title: "GitHub onboarding: repository catalogue and normalized reads",
            state: "open",
            author: "octocat",
            updatedAt: "2026-08-11T12:00:00Z",
            url: "https://github.com/octant/octant/issues/770",
          },
        ],
        hasNextPage: false,
        sort: "updated-desc",
        freshness: { status: "fresh" },
      },
    });
    expect(decoded).toMatchObject({ kind: "issues", page: { rows: [{ number: 770 }] } });
    expect(() =>
      decodeGithubCatalogueReadResponse({
        kind: "issues",
        page: {
          rows: [
            {
              number: 1,
              title: "t",
              state: "open",
              author: "a",
              updatedAt: "2026-08-11T12:00:00Z",
              url: "https://attacker.example/issues/1",
            },
          ],
          hasNextPage: false,
          sort: "updated-desc",
          freshness: { status: "fresh" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCatalogueReadResponse({
        kind: "issues",
        page: {
          rows: [
            {
              number: 1,
              title: "t",
              state: "open",
              author: "a",
              updatedAt: "2026-08-11T12:00:00Z",
              url: "https://token@github.com/x",
            },
          ],
          hasNextPage: false,
          sort: "updated-desc",
          freshness: { status: "fresh" },
        },
      }),
    ).toThrow();
  });

  it("accepts normalized pull-request and Projects rows", () => {
    expect(
      decodeGithubCatalogueReadResponse({
        kind: "pull-requests",
        page: {
          rows: [
            {
              number: 12,
              title: "feat: add catalogue",
              state: "merged",
              author: "octocat",
              updatedAt: "2026-08-10T09:30:00Z",
              url: "https://github.com/octant/octant/pull/12",
              baseBranch: "development",
              headBranch: "feature/issue-12",
            },
          ],
          hasNextPage: false,
          sort: "updated-desc",
          freshness: { status: "fresh" },
        },
      }),
    ).toMatchObject({ kind: "pull-requests" });
    expect(
      decodeGithubCatalogueReadResponse({
        kind: "projects",
        page: {
          rows: [
            {
              number: 14,
              title: "Delivery",
              closed: false,
              updatedAt: "2026-08-01T00:00:00Z",
              url: "https://github.com/orgs/octant/projects/14",
            },
          ],
          hasNextPage: false,
          sort: "updated-desc",
          freshness: { status: "fresh" },
        },
      }),
    ).toMatchObject({ kind: "projects" });
  });

  it("rejects token-like material anywhere in a served row", () => {
    expect(() =>
      decodeGithubCatalogueReadResponse({
        kind: "repositories",
        page: {
          rows: [{ ...repositoryRow, defaultBranch: "ghp_abcdefghijklmnopqrstuvwx" }],
          hasNextPage: false,
          sort: "pushed-desc",
          freshness: { status: "fresh" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCatalogueReadResponse({
        kind: "issues",
        page: {
          rows: [
            {
              number: 1,
              title: "Authorization: Bearer abc",
              state: "open",
              author: "a",
              updatedAt: "2026-08-11T12:00:00Z",
              url: "https://github.com/o/r/issues/1",
            },
          ],
          hasNextPage: false,
          sort: "updated-desc",
          freshness: { status: "fresh" },
        },
      }),
    ).toThrow();
  });

  it("carries independent, actionable unavailable states per capability", () => {
    expect(
      decodeGithubCatalogueReadResponse({
        kind: "unavailable",
        capability: "projects-read",
        reason: "scope-limited",
        remediation: "Grant read:project through a confirmed scope refresh.",
      }),
    ).toMatchObject({ capability: "projects-read", reason: "scope-limited" });
    expect(
      decodeGithubCatalogueReadResponse({
        kind: "unavailable",
        capability: "repository-catalogue",
        reason: "rate-limited",
        retryAfterSeconds: 90,
      }),
    ).toMatchObject({ reason: "rate-limited", retryAfterSeconds: 90 });
    expect(() =>
      decodeGithubCatalogueReadResponse({
        kind: "unavailable",
        capability: "issues-read",
        reason: "rate-limited",
        retryAfterSeconds: -1,
      }),
    ).toThrow();
  });

  it("accepts bounded recents and rejects oversize recents payloads", () => {
    expect(
      decodeGithubCatalogueReadResponse({
        kind: "recent-repositories",
        rows: [repositoryRow],
      }),
    ).toMatchObject({ kind: "recent-repositories" });
    expect(() =>
      decodeGithubCatalogueReadResponse({
        kind: "recent-repositories",
        rows: Array.from({ length: 21 }, () => repositoryRow),
      }),
    ).toThrow();
    expect(
      decodeGithubRecentRepositoryCommand({
        kind: "record-recent-repository",
        nodeId: "R_kgDOG8x1Aa",
      }),
    ).toMatchObject({ nodeId: "R_kgDOG8x1Aa" });
    expect(() =>
      decodeGithubRecentRepositoryCommand({
        kind: "record-recent-repository",
        nodeId: "R_kgDOG8x1Aa",
        cloneUrl: "https://github.com/x/y.git",
      }),
    ).toThrow();
  });

  it("bounds a repository page to at most 100 rows", () => {
    expect(() =>
      decodeGithubCatalogueReadResponse({
        kind: "repositories",
        page: {
          rows: Array.from({ length: 101 }, (_, index) => ({
            ...repositoryRow,
            nodeId: `R_${index}`,
          })),
          hasNextPage: false,
          sort: "pushed-desc",
          freshness: { status: "fresh" },
        },
      }),
    ).toThrow();
  });

  it("bounds and validates the repository search text", () => {
    expect(
      decodeGithubCatalogueReadRequest({ kind: "repositories", pageSize: 30, search: "atlas" }),
    ).toMatchObject({ search: "atlas" });
    expect(() =>
      decodeGithubCatalogueReadRequest({
        kind: "repositories",
        pageSize: 30,
        search: "x".repeat(161),
      }),
    ).toThrow();
  });
});
