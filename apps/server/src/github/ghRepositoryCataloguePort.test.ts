import { describe, expect, it, vi } from "vitest";
import { GhRepositoryCataloguePort } from "./ghRepositoryCataloguePort";

function searchItem(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Confine Plan git per call",
    state: "open",
    user: { login: "octocat" },
    updated_at: "2026-08-28T10:00:00Z",
    html_url: "https://github.com/octant/octant/pull/12",
    repository_url: "https://api.github.com/repos/octant/octant",
    ...overrides,
  };
}

function portReturning(pages: ReadonlyArray<readonly unknown[]>) {
  let call = 0;
  const run = vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ items: pages[Math.min(call++, pages.length - 1)] ?? [] }),
  }));
  return { port: new GhRepositoryCataloguePort({ command: { run } }), run };
}

function repositoryItem(overrides: Record<string, unknown> = {}) {
  return {
    node_id: "R_kgDOG8x1Aa",
    owner: { login: "octant" },
    name: "octant",
    visibility: "public",
    default_branch: "main",
    permissions: { pull: true },
    ...overrides,
  };
}

describe("readRepository", () => {
  it("reads one repository by owner and name and normalizes its identity", async () => {
    const run = vi.fn(async (_arguments_: readonly string[]) => ({
      exitCode: 0,
      stdout: JSON.stringify(repositoryItem()),
    }));
    const port = new GhRepositoryCataloguePort({ command: { run } });
    expect(
      await port.readRepository({ owner: "octant", name: "octant" }, new AbortController().signal),
    ).toEqual({
      kind: "ok",
      value: {
        nodeId: "R_kgDOG8x1Aa",
        owner: "octant",
        name: "octant",
        visibility: "public",
        defaultBranch: "main",
        viewerPermission: "read",
      },
    });
    expect(run.mock.calls[0]?.[0]).toEqual(["api", "repos/octant/octant"]);
  });

  it("refuses an invalid owner or name before spawning gh", async () => {
    const run = vi.fn();
    const port = new GhRepositoryCataloguePort({ command: { run } });
    expect(
      await port.readRepository({ owner: "../evil", name: "octant" }, new AbortController().signal),
    ).toEqual({ kind: "unavailable" });
    expect(run).not.toHaveBeenCalled();
  });

  it("classifies a missing repository as an actionable bounded failure", async () => {
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 404: Not Found",
    }));
    const port = new GhRepositoryCataloguePort({ command: { run } });
    expect(
      await port.readRepository({ owner: "octant", name: "gone" }, new AbortController().signal),
    ).toEqual({
      kind: "scope-limited",
      remediation: "repository-access-or-scope-required",
    });
  });
});

describe("listAssignedWork", () => {
  it("merges the four viewer searches, own pull requests included, and keeps one row per item", async () => {
    const { port, run } = portReturning([
      [searchItem()],
      [searchItem()],
      [
        searchItem({
          number: 31,
          html_url: "https://github.com/octant/octant/pull/31",
          pull_request: { url: "https://api.github.com/repos/octant/octant/pulls/31" },
        }),
      ],
      [
        searchItem({
          number: 7,
          html_url: "https://github.com/octant/octant/issues/7",
        }),
      ],
    ]);
    const result = await port.listAssignedWork(new AbortController().signal);
    expect(result).toMatchObject({
      kind: "ok",
      value: [
        { category: "review-request", owner: "octant", name: "octant", number: 12 },
        { category: "pull-request", owner: "octant", name: "octant", number: 31 },
        { category: "issue", owner: "octant", name: "octant", number: 7 },
      ],
    });
    expect(run).toHaveBeenCalledTimes(4);
    const ownPullRequests = run.mock.calls.map(
      (call_) => (call_ as unknown as [readonly string[]])[0][1] ?? "",
    )[2];
    expect(ownPullRequests).toContain("author%3A%40me");
    const queries = run.mock.calls.map(
      (call_) => (call_ as unknown as [readonly string[]])[0][1] ?? "",
    );
    // Every query is bound to the signed-in account; none accepts a login.
    for (const query of queries) expect(query).toContain("%40me");
  });

  it("returns unavailable rather than rows it cannot attribute to a repository", async () => {
    const { port } = portReturning([
      [searchItem({ repository_url: "https://evil.example.com/repos/octant/octant" })],
    ]);
    expect(await port.listAssignedWork(new AbortController().signal)).toEqual({
      kind: "unavailable",
    });
  });
});
