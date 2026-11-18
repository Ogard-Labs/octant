import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { GhCommandPort, GhCommandResult } from "../code/ghPullRequestPort";
import { GhHomeActivityPort } from "./ghHomeActivityPort";

const signal = new AbortController().signal;

function fixture(results: ReadonlyArray<GhCommandResult>) {
  const queue = [...results];
  const command: GhCommandPort = {
    run: vi.fn(async () => queue.shift() ?? { exitCode: 1, stdout: "" }),
  };
  return { command, port: new GhHomeActivityPort({ command }) };
}

const searchPage = (
  nodes: ReadonlyArray<unknown>,
  overrides: { readonly issueCount?: number; readonly pageInfo?: Record<string, unknown> } = {},
): GhCommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({
    data: {
      search: {
        issueCount: overrides.issueCount ?? nodes.length,
        pageInfo: overrides.pageInfo ?? { hasNextPage: false, endCursor: null },
        nodes,
      },
    },
  }),
});

const releasesPage = (
  nodes: ReadonlyArray<unknown>,
  pageInfo: Record<string, unknown> = { hasNextPage: false, endCursor: null },
): GhCommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({
    data: { repository: { releases: { pageInfo, nodes } } },
  }),
});

const mergedNode = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: "Ship it",
  mergedAt: "2026-08-20T10:00:00Z",
  mergedBy: { login: "henrik" },
  ...overrides,
});

const closedIssueNode = (overrides: Record<string, unknown> = {}) => ({
  number: 11,
  title: "Real issue",
  closedAt: "2026-08-20T09:05:00Z",
  timelineItems: {
    nodes: [{ createdAt: "2026-08-20T09:05:00Z", actor: { login: "closer" } }],
  },
  ...overrides,
});

const releaseNode = (overrides: Record<string, unknown> = {}) => ({
  databaseId: 77,
  tagName: "v1.2.3",
  name: "One two three",
  url: "https://github.com/octant-dev/octant/releases/tag/v1.2.3",
  publishedAt: "2026-08-19T12:00:00Z",
  createdAt: "2026-08-10T12:00:00Z",
  isDraft: false,
  author: { login: "publisher" },
  ...overrides,
});

const observe = (
  port: GhHomeActivityPort,
  card: "prs-merged" | "issues-closed" | "releases-published",
  since?: string,
) => port.observe({ owner: "octant-dev", name: "octant", card, since, signal });

describe("GhHomeActivityPort", () => {
  it("asks the search for merged pull requests inside the window", async () => {
    const { command, port } = fixture([searchPage([mergedNode()])]);
    const result = await observe(port, "prs-merged", "2026-08-18T00:00:00Z");
    expect(result.status).toBe("ready");
    expect(command.run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "api",
        "graphql",
        "-f",
        "q=repo:octant-dev/octant is:pr is:merged merged:>=2026-08-18T00:00:00Z",
      ]),
      expect.anything(),
      signal,
    );
    expect(command.run).not.toHaveBeenCalledWith(
      expect.arrayContaining(["-f", expect.stringContaining("after=")]),
      expect.anything(),
      signal,
    );
  });

  it("reads merged pull requests with the audited merger, not the account", async () => {
    const { port } = fixture([
      searchPage([
        mergedNode({ number: 42, mergedBy: { login: "someone-else" } }),
        // Unconfirmed merge rows carry neither timestamp nor merger and
        // must count nothing.
        mergedNode({ number: 7, mergedAt: null }),
        mergedNode({ number: 8, mergedBy: null }),
      ]),
    ]);
    const result = await observe(port, "prs-merged");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "prs-merged",
      number: 42,
      mergedAt: "2026-08-20T10:00:00Z",
      mergedBy: "someone-else",
    });
  });

  it("pages a bounded search to its natural end as ready", async () => {
    const { command, port } = fixture([
      searchPage([mergedNode({ number: 2 })], {
        pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      }),
      searchPage([mergedNode({ number: 1 })]),
    ]);
    const result = await observe(port, "prs-merged");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.rows.map((row) => row.kind === "prs-merged" && row.number)).toEqual([2, 1]);
    expect(command.run).toHaveBeenCalledTimes(2);
    expect(command.run).toHaveBeenLastCalledWith(
      expect.arrayContaining(["-f", "after=cursor-2"]),
      expect.anything(),
      signal,
    );
  });

  it("answers partial at the page bound instead of fabricating coverage", async () => {
    const { port } = fixture(
      Array.from({ length: 4 }, () =>
        searchPage([mergedNode()], { pageInfo: { hasNextPage: true, endCursor: "next" } }),
      ),
    );
    const result = await observe(port, "prs-merged");
    expect(result).toMatchObject({ status: "partial", reason: "incomplete" });
    if (result.status !== "partial") return;
    expect(result.rows).toHaveLength(4);
  });

  it("answers partial when the window's matches exceed the search limit", async () => {
    const { port } = fixture([searchPage([mergedNode()], { issueCount: 1024 })]);
    const result = await observe(port, "prs-merged");
    expect(result).toMatchObject({ status: "partial", reason: "incomplete" });
  });

  it("asks the search for closed issues inside the window", async () => {
    const { command, port } = fixture([searchPage([closedIssueNode()])]);
    const result = await observe(port, "issues-closed", "2026-08-18T00:00:00Z");
    expect(result.status).toBe("ready");
    expect(command.run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "-f",
        "q=repo:octant-dev/octant is:issue is:closed closed:>=2026-08-18T00:00:00Z",
      ]),
      expect.anything(),
      signal,
    );
  });

  it("names the last close event's actor as the closer", async () => {
    const { port } = fixture([
      searchPage([
        closedIssueNode({ number: 11 }),
        // No close event: the closure is unconfirmed and counts nothing.
        closedIssueNode({ number: 12, timelineItems: { nodes: [] } }),
        // A close event without an actor cannot name who closed.
        closedIssueNode({
          number: 13,
          timelineItems: { nodes: [{ createdAt: "2026-08-20T09:05:00Z", actor: null }] },
        }),
        // Search can hand back a non-issue node; it counts nothing.
        { number: 14, mergedAt: "2026-08-20T09:05:00Z" },
      ]),
    ]);
    const result = await observe(port, "issues-closed");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "issues-closed",
      number: 11,
      closedAt: "2026-08-20T09:05:00Z",
      closedBy: "closer",
    });
  });

  it("names the release's author as publisher and skips drafts", async () => {
    const { port } = fixture([
      releasesPage([
        releaseNode({ databaseId: 77 }),
        releaseNode({ databaseId: 78, isDraft: true }),
        releaseNode({ databaseId: 79, publishedAt: null }),
        releaseNode({ databaseId: 80, author: null }),
      ]),
    ]);
    const result = await observe(port, "releases-published");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "releases-published",
      releaseId: 77,
      tag: "v1.2.3",
      publishedAt: "2026-08-19T12:00:00Z",
      publishedBy: "publisher",
      url: "https://github.com/octant-dev/octant/releases/tag/v1.2.3",
    });
  });

  it("stops the release walk once a page's oldest creation cannot reach the window", async () => {
    const { command, port } = fixture([
      releasesPage([releaseNode({ createdAt: "2026-05-01T00:00:00Z" })], {
        hasNextPage: true,
        endCursor: "old",
      }),
    ]);
    const result = await observe(port, "releases-published", "2026-08-01T00:00:00Z");
    expect(result.status).toBe("ready");
    expect(command.run).toHaveBeenCalledTimes(1);
  });

  it("keeps walking while a release's creation can still hide a windowed publish", async () => {
    const { command, port } = fixture([
      releasesPage([releaseNode({ createdAt: "2026-07-10T00:00:00Z" })], {
        hasNextPage: true,
        endCursor: "next",
      }),
      releasesPage([releaseNode({ databaseId: 99, createdAt: "2026-06-01T00:00:00Z" })]),
    ]);
    const result = await observe(port, "releases-published", "2026-08-01T00:00:00Z");
    expect(result.status).toBe("ready");
    expect(command.run).toHaveBeenCalledTimes(2);
  });

  it("drops releases whose links are not canonical tag pages for this repository", async () => {
    const { port } = fixture([
      releasesPage([
        releaseNode({ databaseId: 77, url: "https://example.com/releases/v1" }),
        releaseNode({
          databaseId: 78,
          url: "https://github.com/octant-dev/other/releases/tag/v2",
        }),
        releaseNode({ databaseId: 79 }),
      ]),
    ]);
    const result = await observe(port, "releases-published");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.rows.map((row) => row.kind === "releases-published" && row.releaseId)).toEqual([
      79,
    ]);
  });

  it("answers partial when GitHub promises another page but hands back no cursor", async () => {
    const { port } = fixture([
      searchPage([mergedNode()], { pageInfo: { hasNextPage: true, endCursor: null } }),
    ]);
    const result = await observe(port, "prs-merged");
    expect(result).toMatchObject({ status: "partial", reason: "incomplete" });
  });

  it("answers rate-limited instead of a truncated ready", async () => {
    const { port } = fixture([{ exitCode: 1, stdout: "", stderr: "API rate limit exceeded" }]);
    const result = await observe(port, "prs-merged");
    expect(result).toEqual({ status: "unavailable", reason: "rate-limited" });
  });

  it("answers a missing repository as partial with no rows", async () => {
    const { port } = fixture([
      {
        exitCode: 1,
        stdout: "",
        stderr: "Could not resolve to a Repository with the name 'octant-dev/octant'.",
      },
    ]);
    const result = await observe(port, "issues-closed");
    expect(result).toEqual({ status: "partial", rows: [], reason: "repository-missing" });
  });

  it("answers a GraphQL errors array that exits 0 as a read failure", async () => {
    const { port } = fixture([
      {
        exitCode: 0,
        stdout: JSON.stringify({ data: { search: null }, errors: [{ message: "timed out" }] }),
      },
    ]);
    const result = await observe(port, "prs-merged");
    expect(result).toEqual({ status: "unavailable", reason: "read-failed" });
  });

  it("refuses a malformed repository identity without calling gh", async () => {
    const { command, port } = fixture([]);
    const result = await port.observe({
      owner: "not a repo",
      name: "octant",
      card: "prs-merged",
      since: undefined,
      signal,
    });
    expect(result).toEqual({ status: "unavailable", reason: "read-failed" });
    expect(command.run).not.toHaveBeenCalled();
  });

  it("keeps every query constant's braces balanced", () => {
    const source = readFileSync(new URL("./ghHomeActivityPort.ts", import.meta.url), "utf8");
    const queries = [...source.matchAll(/const \w+_QUERY\s*=\s*\n?\s*"([^"]+)";/g)].map(
      (match) => match[1] ?? "",
    );
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.split("{").length).toBe(query.split("}").length);
    }
  });
});
