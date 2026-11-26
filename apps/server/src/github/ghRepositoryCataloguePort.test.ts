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

function issueItem(number: number, overrides: Record<string, unknown> = {}) {
  return searchItem({
    number,
    html_url: `https://github.com/octant/octant/issues/${number}`,
    ...overrides,
  });
}

describe("why an issue was closed", () => {
  const reasons = [
    issueItem(1, { state: "closed", state_reason: "completed" }),
    issueItem(2, { state: "closed", state_reason: "not_planned" }),
    issueItem(3, { state: "closed", state_reason: "duplicate" }),
    issueItem(4, { state: "closed", state_reason: null }),
    issueItem(5, { state: "closed", state_reason: "a_reason_added_later" }),
    issueItem(6, { state: "closed" }),
    issueItem(7, { state: "open", state_reason: "reopened" }),
    issueItem(8, { state: "open", state_reason: "completed" }),
    issueItem(9, { state: "closed", state_reason: "reopened" }),
  ];
  const expected = [
    "completed",
    "not-planned",
    "duplicate",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ];

  it("reports the reason GitHub gives for a closed issue and nothing for any other answer", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(reasons) }));
    const port = new GhRepositoryCataloguePort({ command: { run } });
    const result = await port.listIssues(
      { owner: "octant", name: "octant", pageSize: 20, state: "all" },
      new AbortController().signal,
    );
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.value.rows.map((row) => row.stateReason)).toEqual(expected);
    expect(result.value.rows.filter((row) => "stateReason" in row)).toHaveLength(3);
  });

  it("reports the reason on a title search and on a repository search", async () => {
    const { port } = portReturning([reasons]);
    const listed = await port.listIssues(
      { owner: "octant", name: "octant", pageSize: 20, state: "all", search: "crash" },
      new AbortController().signal,
    );
    const searched = await port.searchIssuesAndPullRequests(
      { owner: "octant", name: "octant", query: "crash", pageSize: 20, state: "all" },
      new AbortController().signal,
    );
    if (listed.kind !== "ok" || searched.kind !== "ok") throw new Error("search failed");
    expect(listed.value.rows.map((row) => row.stateReason)).toEqual(expected);
    expect(searched.value.rows.map((row) => row.stateReason)).toEqual(expected);
  });

  it("gives a closed pull request no reason", async () => {
    const { port } = portReturning([
      [searchItem({ state: "closed", state_reason: "completed", pull_request: {} })],
    ]);
    const searched = await port.searchIssuesAndPullRequests(
      { owner: "octant", name: "octant", query: "crash", pageSize: 20, state: "all" },
      new AbortController().signal,
    );
    if (searched.kind !== "ok") throw new Error(searched.kind);
    expect(searched.value.rows[0]).not.toHaveProperty("stateReason");
  });

  it("reports the reason on one issue read by number", async () => {
    const run = vi.fn(async (arguments_: readonly string[]) => ({
      exitCode: 0,
      stdout: arguments_[1]?.includes("/comments")
        ? "[]"
        : JSON.stringify(
            issueItem(7, {
              state: "closed",
              state_reason: "not_planned",
              created_at: "2026-08-20T10:00:00Z",
              body: "",
              labels: [],
            }),
          ),
    }));
    const port = new GhRepositoryCataloguePort({ command: { run } });
    const result = await port.readIssue(
      { owner: "octant", name: "octant", number: 7 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "ok", value: { stateReason: "not-planned" } });
  });

  it("reads a closed reason through issue search, scoped to the repository's closed issues", async () => {
    const { port, run } = portReturning([[]]);
    const queries: string[] = [];
    for (const request of [
      { closedReason: "completed" as const },
      { closedReason: "not-planned" as const, assignee: "none" as const },
      { closedReason: "completed" as const, search: "label:bug crash" },
    ]) {
      await port.listIssues(
        { owner: "octant", name: "octant", pageSize: 20, state: "closed", ...request },
        new AbortController().signal,
      );
      const path = String((run.mock.lastCall as unknown as [string[]])[0][1]);
      expect(path.startsWith("search/issues?q=")).toBe(true);
      queries.push(decodeURIComponent(path.slice("search/issues?q=".length).split("&")[0] ?? ""));
    }
    expect(queries).toEqual([
      "repo:octant/octant type:issue is:closed reason:completed",
      'repo:octant/octant type:issue is:closed reason:"not planned" no:assignee',
      'repo:octant/octant type:issue is:closed reason:completed "crash" in:title',
    ]);
  });

  it("keeps a long pasted title and its scope when a closed reason is chosen", async () => {
    const { port, run } = portReturning([[]]);
    const owner = "o".repeat(30);
    const name = "n".repeat(30);
    const title = "t".repeat(140);
    const ask = async (closedReason?: "not-planned"): Promise<string> => {
      await port.listIssues(
        {
          owner,
          name,
          pageSize: 20,
          state: "closed",
          search: title,
          ...(closedReason === undefined ? {} : { closedReason }),
        },
        new AbortController().signal,
      );
      const path = String((run.mock.lastCall as unknown as [string[]])[0][1]);
      return decodeURIComponent(path.slice("search/issues?q=".length).split("&")[0] ?? "");
    };
    const plain = await ask();
    expect(plain.length).toBeGreaterThan(256 - ' reason:"not planned"'.length);
    expect(plain).toContain(`"${title}" in:title`);
    expect(await ask("not-planned")).toBe(
      plain.replace("is:closed", 'is:closed reason:"not planned"'),
    );
  });

  it("answers an empty list when every search term was dropped, reason or not", async () => {
    const { port, run } = portReturning([[]]);
    expect(
      await port.listIssues(
        {
          owner: "octant",
          name: "octant",
          pageSize: 20,
          state: "closed",
          closedReason: "completed",
          search: "label:bug",
        },
        new AbortController().signal,
      ),
    ).toEqual({ kind: "ok", value: { rows: [], hasNextPage: false } });
    expect(run).not.toHaveBeenCalled();
  });

  it("ends the list at search's thousandth result instead of asking past it", async () => {
    const full = Array.from({ length: 100 }, (_, index) =>
      issueItem(index + 1, { state: "closed", state_reason: "completed" }),
    );
    const run = vi.fn(async (arguments_: readonly string[]) =>
      Number(/&page=(\d+)/.exec(arguments_[1] ?? "")?.[1]) > 10
        ? { exitCode: 1, stdout: "", stderr: "HTTP 422: Only the first 1000 search results" }
        : { exitCode: 0, stdout: JSON.stringify({ items: full }) },
    );
    const port = new GhRepositoryCataloguePort({ command: { run } });
    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = await port.listIssues(
        {
          owner: "octant",
          name: "octant",
          pageSize: 30,
          state: "closed",
          closedReason: "completed",
          ...(cursor === undefined ? {} : { cursor }),
        },
        new AbortController().signal,
      );
      if (page.kind !== "ok") throw new Error(`${page.kind} after ${String(seen)} rows`);
      seen += page.value.rows.length;
      cursor = page.value.endCursor;
    } while (cursor !== undefined && seen <= 1000);
    expect(seen).toBe(1000);
  });

  it("refuses to continue a page cursor under a different closed reason", async () => {
    const { port } = portReturning([
      [1, 2, 3].map((n) => issueItem(n, { state: "closed", state_reason: "completed" })),
    ]);
    const read = (closedReason?: "completed" | "not-planned", cursor?: string) =>
      port.listIssues(
        {
          owner: "octant",
          name: "octant",
          pageSize: 2,
          state: "closed",
          ...(closedReason === undefined ? {} : { closedReason }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        new AbortController().signal,
      );
    const first = await read("completed");
    if (first.kind !== "ok" || first.value.endCursor === undefined) throw new Error("no cursor");
    expect(await read("completed", first.value.endCursor)).toMatchObject({ kind: "ok" });
    expect(await read("not-planned", first.value.endCursor)).toEqual({ kind: "invalid-cursor" });
    expect(await read(undefined, first.value.endCursor)).toEqual({ kind: "invalid-cursor" });
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

  it("marks a draft pull request and leaves the flag off everything else", async () => {
    const { port } = portReturning([
      [searchItem({ number: 40, draft: true })],
      [searchItem({ number: 41, draft: false })],
      [],
      [searchItem({ number: 42, draft: true, pull_request: undefined })],
    ]);
    const result = await port.listAssignedWork(new AbortController().signal);
    if (result.kind !== "ok") throw new Error("expected rows");
    const byNumber = new Map(result.value.map((item) => [item.number, item]));
    expect(byNumber.get(40)?.draft).toBe(true);
    expect(byNumber.get(41)).not.toHaveProperty("draft");
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
