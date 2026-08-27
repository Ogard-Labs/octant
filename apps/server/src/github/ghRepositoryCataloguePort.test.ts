import { describe, expect, it } from "vitest";
import {
  GhRepositoryCataloguePort,
  type GhCatalogueCommandPort,
} from "./ghRepositoryCataloguePort";

const signal = () => new AbortController().signal;

function restRepository(index: number, overrides: Record<string, unknown> = {}) {
  return {
    node_id: `R_${index}`,
    name: `repo-${index}`,
    owner: { login: "octant" },
    visibility: "private",
    default_branch: "main",
    permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    ...overrides,
  };
}

function restIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    user: { login: "octocat" },
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-11T10:00:00Z",
    html_url: `https://github.com/octant/octant/issues/${number}`,
    labels: [{ name: "bug" }],
    body: "Steps to reproduce",
    ...overrides,
  };
}

function fakeCommandPort(
  respond: (
    arguments_: readonly string[],
    call: number,
  ) => {
    exitCode: number;
    stdout: string;
    stderr?: string;
  },
): GhCatalogueCommandPort & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (arguments_) => {
      calls.push([...arguments_]);
      return respond(arguments_, calls.length);
    },
  };
}

function port(command: GhCatalogueCommandPort) {
  return new GhRepositoryCataloguePort({ command, inheritedEnvironment: {} });
}

describe("GhRepositoryCataloguePort", () => {
  it("fills the requested page across several upstream pages and issues an opaque cursor", async () => {
    const command = fakeCommandPort((arguments_) => {
      const path = arguments_[1] ?? "";
      if ((/[?&]page=(\d+)/.exec(path)?.[1] ?? "1") === "1") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => restRepository(index))),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify([restRepository(100), restRepository(101)]),
      };
    });
    const first = await port(command).listRepositories({ pageSize: 100 }, signal());
    if (first.kind !== "ok") throw new Error(`expected ok, got ${first.kind}`);
    expect(first.value.rows).toHaveLength(100);
    expect(first.value.hasNextPage).toBe(true);
    expect(first.value.endCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await port(command).listRepositories(
      { pageSize: 100, cursor: first.value.endCursor },
      signal(),
    );
    if (second.kind !== "ok") throw new Error(`expected ok, got ${second.kind}`);
    expect(second.value.rows.map((row) => row.nodeId)).toEqual(["R_100", "R_101"]);
    expect(second.value.hasNextPage).toBe(false);
    expect(second.value.endCursor).toBeUndefined();
  });

  it("applies the bounded search filter to owner/name and keeps paginating until filled", async () => {
    const command = fakeCommandPort((arguments_) => {
      const path = arguments_[1] ?? "";
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
      if (page > 3) return { exitCode: 0, stdout: "[]" };
      const rows = Array.from({ length: 100 }, (_, index) => {
        const id = (page - 1) * 100 + index;
        return restRepository(id, { name: id % 50 === 0 ? `atlas-${id}` : `repo-${id}` });
      });
      return { exitCode: 0, stdout: JSON.stringify(rows) };
    });
    const result = await port(command).listRepositories(
      { pageSize: 4, search: "ATLAS-" },
      signal(),
    );
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.rows.map((row) => row.name)).toEqual([
      "atlas-0",
      "atlas-50",
      "atlas-100",
      "atlas-150",
    ]);
    expect(result.value.hasNextPage).toBe(true);
  });

  it("bounds upstream fetches for one request instead of walking GitHub forever", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => restRepository(index))),
    }));
    const result = await port(command).listRepositories(
      { pageSize: 10, search: "no-match-anywhere" },
      signal(),
    );
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.rows).toEqual([]);
    expect(result.value.hasNextPage).toBe(true);
    expect(command.calls.length).toBeLessThanOrEqual(10);
  });

  it("rejects forged or mismatched cursors instead of guessing", async () => {
    const command = fakeCommandPort(() => ({ exitCode: 0, stdout: "[]" }));
    expect(
      await port(command).listRepositories({ pageSize: 10, cursor: "not-base64-json" }, signal()),
    ).toMatchObject({ kind: "invalid-cursor" });
    const searchCursor = await port(
      fakeCommandPort(() => ({
        exitCode: 0,
        stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => restRepository(index))),
      })),
    ).listRepositories({ pageSize: 5, search: "repo" }, signal());
    if (searchCursor.kind !== "ok" || searchCursor.value.endCursor === undefined) {
      throw new Error("expected cursor");
    }
    expect(
      await port(command).listRepositories(
        { pageSize: 5, search: "different", cursor: searchCursor.value.endCursor },
        signal(),
      ),
    ).toMatchObject({ kind: "invalid-cursor" });
  });

  it("maps viewer permissions and preserves node identity, visibility, and default branch", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify([
        restRepository(1, {
          permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
          visibility: "public",
        }),
        restRepository(2, {
          permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
        }),
        restRepository(3, { permissions: undefined, default_branch: undefined }),
      ]),
    }));
    const result = await port(command).listRepositories({ pageSize: 10 }, signal());
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.rows).toEqual([
      {
        nodeId: "R_1",
        owner: "octant",
        name: "repo-1",
        visibility: "public",
        defaultBranch: "main",
        viewerPermission: "admin",
      },
      {
        nodeId: "R_2",
        owner: "octant",
        name: "repo-2",
        visibility: "private",
        defaultBranch: "main",
        viewerPermission: "read",
      },
      {
        nodeId: "R_3",
        owner: "octant",
        name: "repo-3",
        visibility: "private",
        viewerPermission: "none",
      },
    ]);
  });

  it("fails closed on malformed upstream repository payloads", async () => {
    for (const stdout of ["not json", '{"hello":1}', JSON.stringify([{ node_id: 5 }])]) {
      const result = await port(fakeCommandPort(() => ({ exitCode: 0, stdout }))).listRepositories(
        { pageSize: 10 },
        signal(),
      );
      expect(result).toMatchObject({ kind: "unavailable" });
    }
  });

  it("classifies authentication, rate-limit, and SSO/scope failures actionably", async () => {
    const cases: readonly [string, string][] = [
      ["HTTP 401: Bad credentials (https://api.github.com/user/repos)", "unauthorized"],
      ["HTTP 403: API rate limit exceeded for user", "rate-limited"],
      [
        "HTTP 403: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.",
        "scope-limited",
      ],
      ["HTTP 404: Not Found (https://api.github.com/repos/o/r/issues)", "scope-limited"],
      ["dial tcp: lookup api.github.com: no such host", "unavailable"],
    ];
    for (const [stderr, kind] of cases) {
      const result = await port(
        fakeCommandPort(() => ({ exitCode: 1, stdout: "", stderr })),
      ).listRepositories({ pageSize: 10 }, signal());
      expect(result).toMatchObject({ kind });
    }
  });

  it("lists issues without pull requests and redacts hostile text", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 7,
          title: "Ordinary issue",
          state: "open",
          user: { login: "octocat" },
          updated_at: "2026-08-11T10:00:00Z",
          html_url: "https://github.com/octant/octant/issues/7",
        },
        {
          number: 8,
          title: "Actually a PR",
          state: "open",
          user: { login: "octocat" },
          updated_at: "2026-08-11T10:00:00Z",
          html_url: "https://github.com/octant/octant/pull/8",
          pull_request: { url: "https://api.github.com/..." },
        },
        {
          number: 9,
          title: "leak Authorization: bearer ghp_abcdefghijklmnopqrstuv",
          state: "closed",
          user: null,
          updated_at: "2026-08-11T10:00:00Z",
          html_url: "https://github.com/octant/octant/issues/9",
        },
      ]),
    }));
    const result = await port(command).listIssues(
      { owner: "octant", name: "octant", pageSize: 10, state: "all" },
      signal(),
    );
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.rows.map((row) => row.number)).toEqual([7, 9]);
    expect(result.value.rows[1]).toMatchObject({ author: "unknown", state: "closed" });
    expect(JSON.stringify(result.value.rows[1])).not.toMatch(/ghp_|bearer|authorization/i);
  });

  it("normalizes pull-request state from draft and merge facts", async () => {
    const base = {
      title: "t",
      user: { login: "octocat" },
      updated_at: "2026-08-11T10:00:00Z",
      html_url: "https://github.com/octant/octant/pull/1",
      base: { ref: "development" },
      head: { ref: "feature/x" },
    };
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify([
        { ...base, number: 1, state: "open", draft: false, merged_at: null },
        { ...base, number: 2, state: "open", draft: true, merged_at: null },
        { ...base, number: 3, state: "closed", draft: false, merged_at: "2026-08-10T00:00:00Z" },
        { ...base, number: 4, state: "closed", draft: false, merged_at: null },
      ]),
    }));
    const result = await port(command).listPullRequests(
      { owner: "octant", name: "octant", pageSize: 10, state: "all" },
      signal(),
    );
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.rows.map((row) => row.state)).toEqual([
      "open",
      "draft",
      "merged",
      "closed",
    ]);
    expect(result.value.rows[0]).toMatchObject({
      baseBranch: "development",
      headBranch: "feature/x",
    });
  });

  it("reads bounded Projects metadata through the fixed GraphQL query", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            projectsV2: {
              nodes: [
                {
                  number: 14,
                  title: "Delivery",
                  closed: false,
                  updatedAt: "2026-08-01T00:00:00Z",
                  url: "https://github.com/orgs/octant/projects/14",
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjE=" },
            },
          },
        },
      }),
    }));
    const result = await port(command).listProjects(
      { owner: "octant", name: "octant", pageSize: 10 },
      signal(),
    );
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.rows).toEqual([
      {
        number: 14,
        title: "Delivery",
        closed: false,
        updatedAt: "2026-08-01T00:00:00Z",
        url: "https://github.com/orgs/octant/projects/14",
      },
    ]);
    expect(result.value.hasNextPage).toBe(true);
    expect(result.value.endCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(command.calls[0]?.[1]).toBe("graphql");
  });

  it("treats a GraphQL scope error as scope-limited even with exit code zero", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: { repository: null },
        errors: [
          {
            type: "INSUFFICIENT_SCOPES",
            message: "Your token has not been granted the required scopes",
          },
        ],
      }),
    }));
    expect(
      await port(command).listProjects({ owner: "octant", name: "octant", pageSize: 10 }, signal()),
    ).toMatchObject({ kind: "scope-limited" });
  });

  it("proves each operation independently and never invokes token-producing commands", async () => {
    const command = fakeCommandPort((arguments_) => {
      if (arguments_.some((argument) => argument.includes("projectsV2"))) {
        return { exitCode: 1, stdout: "", stderr: "HTTP 403: missing read:project" };
      }
      if (arguments_[1] === "graphql") {
        return { exitCode: 0, stdout: '{"data":{"viewer":{"issues":{"totalCount":1}}}}' };
      }
      return { exitCode: 0, stdout: "[]" };
    });
    const probes = await port(command).probeOperations(signal());
    expect(probes).toEqual({
      "repository-catalogue": true,
      "issues-read": true,
      "pull-requests-read": true,
      "projects-read": false,
    });
    for (const call of command.calls) {
      expect(call[0]).toBe("api");
      expect(call.join(" ")).not.toMatch(/auth|--with-token|token/);
    }
  });

  it("only ever issues allowlisted, non-mutating gh api reads", async () => {
    const command = fakeCommandPort((arguments_) => {
      const path = arguments_[1] ?? "";
      if (path.includes("/issues/7") && !path.includes("/comments")) {
        return { exitCode: 0, stdout: JSON.stringify(restIssue(7)) };
      }
      if (path.includes("/comments")) return { exitCode: 0, stdout: "[]" };
      if (path.startsWith("search/issues")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }),
        };
      }
      return { exitCode: 0, stdout: "[]" };
    });
    const catalogue = port(command);
    await catalogue.listRepositories({ pageSize: 5 }, signal());
    await catalogue.listIssues(
      { owner: "octant", name: "octant", pageSize: 5, state: "open" },
      signal(),
    );
    await catalogue.listIssues(
      { owner: "octant", name: "octant", pageSize: 5, state: "open", search: "crash" },
      signal(),
    );
    await catalogue.listPullRequests(
      { owner: "octant", name: "octant", pageSize: 5, state: "open" },
      signal(),
    );
    await catalogue.readIssue({ owner: "octant", name: "octant", number: 7 }, signal());
    for (const call of command.calls) {
      expect(call[0]).toBe("api");
      expect(call).not.toContain("--method");
      expect(call).not.toContain("--input");
      expect(call.join(" ")).not.toMatch(/-X|POST|PATCH|PUT|DELETE/);
    }
  });

  it("composes a server-owned search query from title, number, and author terms", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            number: 42,
            title: "crash on save",
            state: "open",
            user: { login: "octocat" },
            updated_at: "2026-08-11T10:00:00Z",
            html_url: "https://github.com/octant/octant/issues/42",
          },
        ],
      }),
    }));
    const result = await port(command).listIssues(
      {
        owner: "octant",
        name: "octant",
        pageSize: 10,
        state: "open",
        search: "crash #42 author:octocat",
      },
      signal(),
    );
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.rows.map((row) => row.number)).toEqual([42]);
    const path = command.calls[0]?.[1] ?? "";
    expect(path.startsWith("search/issues?")).toBe(true);
    const query = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q") ?? "";
    expect(query).toContain("repo:octant/octant");
    expect(query).toContain("type:issue");
    expect(query).toContain("is:open");
    expect(query).toContain("author:octocat");
    expect(query).toContain("42");
    expect(query).toContain("in:title");
    expect(query).toContain("crash");
  });

  it("does not forward raw GitHub search syntax from the client", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }),
    }));
    const empty = await port(command).listIssues(
      {
        owner: "octant",
        name: "octant",
        pageSize: 10,
        state: "open",
        search: "repo:evil/other type:pr is:open",
      },
      signal(),
    );
    expect(empty).toEqual({ kind: "ok", value: { rows: [], hasNextPage: false } });
    expect(command.calls).toEqual([]);

    await port(command).listIssues(
      {
        owner: "octant",
        name: "octant",
        pageSize: 10,
        state: "closed",
        search: "crash repo:evil/other",
      },
      signal(),
    );
    const path = command.calls[0]?.[1] ?? "";
    const query = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q") ?? "";
    expect(query).toContain("repo:octant/octant");
    expect(query).toContain('"crash"');
    expect(query).not.toContain("evil");
    expect(query).not.toContain("type:pr");
  });

  it("reads a bounded issue detail, redacts token-like text, and discloses truncation", async () => {
    const longBody = `${"a".repeat(8 * 1024)}tail`;
    const longComment = `${"b".repeat(2 * 1024)}tail`;
    const command = fakeCommandPort((arguments_) => {
      const path = arguments_[1] ?? "";
      if (path.includes("/comments")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            ...Array.from({ length: 12 }, (_, index) => ({
              user: { login: "hubot" },
              created_at: `2026-08-0${(index % 9) + 1}T10:00:00Z`,
              body: `comment-${index}`,
            })),
            {
              user: { login: "octocat" },
              created_at: "2026-08-11T11:00:00Z",
              body: `secret Authorization: bearer ghp_abcdefghijklmnopqrstuv ${longComment}`,
            },
          ]),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ...restIssue(7),
          title: "leak Authorization: bearer ghp_abcdefghijklmnopqrstuv",
          body: `token=github_pat_abcdefghijkl ${longBody}`,
          labels: [
            { name: "x".repeat(51) },
            ...Array.from({ length: 21 }, (_, index) => ({ name: `label-${index}` })),
          ],
        }),
      };
    });
    const result = await port(command).readIssue(
      { owner: "octant", name: "octant", number: 7 },
      signal(),
    );
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.value.number).toBe(7);
    expect(result.value.createdAt).toBe("2026-08-01T09:00:00Z");
    expect(result.value.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(result.value.body, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(result.value.labels).toHaveLength(20);
    expect(result.value.labels.every((label) => label.length <= 50)).toBe(true);
    expect(result.value.comments).toHaveLength(10);
    expect(result.value.comments[9]).toMatchObject({
      author: "octocat",
      truncated: true,
    });
    expect(JSON.stringify(result.value)).not.toMatch(
      /ghp_|github_pat_|bearer|authorization|token=/i,
    );
    expect(result.value.comments[0]?.body).toBe("comment-3");
  });

  it("refuses to treat a pull request as an issue detail", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ...restIssue(8),
        html_url: "https://github.com/octant/octant/pull/8",
        pull_request: { url: "https://api.github.com/repos/octant/octant/pulls/8" },
      }),
    }));
    expect(
      await port(command).readIssue({ owner: "octant", name: "octant", number: 8 }, signal()),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("surfaces retryAfterSeconds when an issue detail is rate-limited", async () => {
    const command = fakeCommandPort(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 403: API rate limit exceeded retry after: 45",
    }));
    expect(
      await port(command).readIssue({ owner: "octant", name: "octant", number: 7 }, signal()),
    ).toEqual({ kind: "rate-limited", retryAfterSeconds: 45 });
  });
});
