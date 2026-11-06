import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GhRepositoryCataloguePort,
  createGhCatalogueCommandPort,
} from "./ghRepositoryCataloguePort";

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

  it("fails closed with the single sign-on remediation when an organization requires authorization", async () => {
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "HTTP 403: Resource protected by organization SAML enforcement. You must grant your token access to this organization.",
    }));
    const port = new GhRepositoryCataloguePort({ command: { run } });
    expect(
      await port.readRepository({ owner: "atlas", name: "private" }, new AbortController().signal),
    ).toEqual({
      kind: "scope-limited",
      remediation: "sso-authorization-required",
    });
  });
});

describe("readIssue", () => {
  function issueItem(overrides: Record<string, unknown> = {}) {
    return {
      number: 12,
      title: "Confine Plan git per call",
      state: "open",
      user: { login: "octocat" },
      created_at: "2026-08-27T10:00:00Z",
      updated_at: "2026-08-28T10:00:00Z",
      html_url: "https://github.com/octant/octant/pull/12",
      labels: [{ name: "bug" }],
      body: "Body",
      comments: 15,
      ...overrides,
    };
  }

  function commentItem(index: number) {
    return {
      user: { login: "reviewer" },
      created_at: "2026-08-28T10:00:00Z",
      body: `Comment ${index}`,
    };
  }

  function portFor(item: unknown, comments: readonly unknown[]) {
    const run = vi.fn(async (arguments_: readonly string[]) => ({
      exitCode: 0,
      stdout: JSON.stringify(String(arguments_[1]).includes("/comments") ? comments : item),
    }));
    return { port: new GhRepositoryCataloguePort({ command: { run } }), run };
  }

  it("cuts the body and comments to their bounds and counts the comments it leaves out", async () => {
    const { port } = portFor(
      issueItem({ body: "é".repeat(8 * 1024) }),
      Array.from({ length: 15 }, (_, index) => commentItem(index)),
    );

    const result = await port.readIssue(
      { owner: "octant", name: "octant", number: 12 },
      new AbortController().signal,
    );

    if (result.kind !== "ok") throw new Error(`expected an issue, got ${result.kind}`);
    expect(Buffer.byteLength(result.value.body, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(result.value.bodyTruncated).toBe(true);
    expect(result.value.comments.map((comment) => comment.body)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Comment ${index + 5}`),
    );
    expect(result.value.commentsOmitted).toBe(5);
    expect(result.value.pullRequest).toBeUndefined();
  });

  it("reads a pull request by number only when the caller asked for one", async () => {
    const pullRequest = issueItem({ pull_request: { merged_at: null }, comments: 0 });

    const refused = await portFor(pullRequest, []).port.readIssue(
      { owner: "octant", name: "octant", number: 12 },
      new AbortController().signal,
    );
    const read = await portFor(pullRequest, []).port.readIssue(
      { owner: "octant", name: "octant", number: 12, includePullRequest: true },
      new AbortController().signal,
    );

    expect(refused).toEqual({ kind: "unavailable" });
    expect(read).toMatchObject({
      kind: "ok",
      value: { number: 12, pullRequest: true, commentsOmitted: 0 },
    });
  });
});

describe("searchIssuesAndPullRequests", () => {
  it("searches only the named repository and drops qualifiers that would leave it", async () => {
    const { port, run } = portReturning([
      [
        searchItem({ pull_request: { merged_at: "2026-08-28T11:00:00Z" } }),
        searchItem({ number: 7, html_url: "https://github.com/octant/octant/issues/7" }),
      ],
    ]);

    const result = await port.searchIssuesAndPullRequests(
      {
        owner: "octant",
        name: "octant",
        query: "flaky repo:attacker/secrets org:attacker is:private login",
        pageSize: 20,
        state: "all",
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      kind: "ok",
      value: {
        rows: [
          { kind: "pull-request", number: 12, state: "merged" },
          { kind: "issue", number: 7, state: "open" },
        ],
      },
    });
    // The arguments are gh's: `api` and the request path.
    const path = decodeURIComponent(String(run.mock.calls.at(0)));
    expect(path).toContain('q=repo:octant/octant "flaky login" in:title,body');
    expect(path).not.toContain("attacker");
    expect(path).not.toContain("type:issue");
  });

  it("refuses a repository it cannot name safely before spawning gh", async () => {
    const { port, run } = portReturning([[]]);

    const result = await port.searchIssuesAndPullRequests(
      { owner: "../escape", name: "octant", query: "flaky", pageSize: 20, state: "open" },
      new AbortController().signal,
    );

    expect(result).toEqual({ kind: "unavailable" });
    expect(run).not.toHaveBeenCalled();
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

const commandDirectories: string[] = [];

afterEach(() => {
  while (commandDirectories.length > 0) {
    const directory = commandDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("the gh command port's stdin body", () => {
  it("stays alive when gh exits before reading the whole request body", async () => {
    // A script that closes stdin and exits at once reproduces the refusal a
    // bad credential or an aborted deadline causes: Node sees the child's
    // stdin pipe close while the body is still being written, which emits
    // EPIPE. Without a listener on that stream the host process dies.
    const directory = mkdtempSync(join(tmpdir(), "octant-gh-command-"));
    commandDirectories.push(directory);
    const executable = join(directory, "exit-before-reading");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const command = createGhCatalogueCommandPort(executable);

    const outcome = await command.run(
      ["api", "gists", "--method", "POST", "--input", "-"],
      { environment: {}, stdin: "x".repeat(256 * 1024) },
      new AbortController().signal,
    );

    expect(outcome.exitCode).toBe(1);
    command.close?.();
  }, 20_000);
});
