import { describe, expect, it, vi } from "vitest";
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

const mergedPage = (
  nodes: ReadonlyArray<unknown>,
  pageInfo: Record<string, unknown> = { hasNextPage: false, endCursor: null },
): GhCommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({
    data: { repository: { pullRequests: { pageInfo, nodes } } },
  }),
});

const mergedNode = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: "Ship it",
  mergedAt: "2026-08-20T10:00:00Z",
  mergedBy: { login: "henrik" },
  ...overrides,
});

describe("GhHomeActivityPort", () => {
  it("reads merged pull requests with the audited merger, not the account", async () => {
    const { command, port } = fixture([
      mergedPage([
        mergedNode({ number: 42, mergedBy: { login: "someone-else" } }),
        // Unconfirmed merge rows carry neither timestamp nor merger and
        // must count nothing.
        mergedNode({ number: 7, mergedAt: null }),
        mergedNode({ number: 8, mergedBy: null }),
      ]),
    ]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "prs-merged",
      signal,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "prs-merged",
      number: 42,
      mergedAt: "2026-08-20T10:00:00Z",
      mergedBy: "someone-else",
    });
    expect(command.run).toHaveBeenCalledOnce();
  });

  it("pages on pageInfo only, never stopping on an old merge time", async () => {
    const { command, port } = fixture([
      mergedPage([mergedNode({ number: 2, mergedAt: "2020-01-01T00:00:00Z" })], {
        hasNextPage: true,
        endCursor: "cursor-2",
      }),
      mergedPage([mergedNode({ number: 1 })]),
    ]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "prs-merged",
      signal,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.rows.map((row) => row.kind === "prs-merged" && row.number)).toEqual([2, 1]);
    expect(command.run).toHaveBeenCalledTimes(2);
  });

  it("answers partial at the page bound instead of fabricating coverage", async () => {
    const { port } = fixture(
      Array.from({ length: 4 }, () =>
        mergedPage([mergedNode()], { hasNextPage: true, endCursor: "next" }),
      ),
    );
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "prs-merged",
      signal,
    });
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.reason).toBe("incomplete");
    expect(result.rows).toHaveLength(4);
  });

  it("accepts a closed issue event's actor and skips pull requests in the feed", async () => {
    const { port } = fixture([
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            event: "closed",
            created_at: "2026-08-20T09:00:00Z",
            actor: { login: "closer" },
            issue: { number: 10, title: "Bug", pull_request: {} },
          },
          {
            event: "closed",
            created_at: "2026-08-20T09:05:00Z",
            actor: { login: "closer" },
            issue: { number: 11, title: "Real issue" },
          },
          {
            event: "reopened",
            created_at: "2026-08-20T09:10:00Z",
            actor: { login: "closer" },
            issue: { number: 12, title: "Reopened" },
          },
        ]),
      },
    ]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "issues-closed",
      signal,
    });
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

  it("names the release event's actor as publisher, never the release author", async () => {
    const { port } = fixture([
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            type: "ReleaseEvent",
            created_at: "2026-08-19T12:00:00Z",
            actor: { login: "publisher" },
            payload: {
              action: "published",
              release: {
                id: 77,
                tag_name: "v1.2.3",
                name: "One two three",
                html_url: "https://github.com/octant-dev/octant/releases/tag/v1.2.3",
                author: { login: "release-author" },
              },
            },
          },
          {
            type: "ReleaseEvent",
            created_at: "2026-08-19T12:05:00Z",
            actor: { login: "publisher" },
            payload: {
              action: "created",
              release: { id: 78, tag_name: "v1.2.4" },
            },
          },
          {
            type: "PushEvent",
            created_at: "2026-08-19T12:10:00Z",
            actor: { login: "publisher" },
            payload: {},
          },
        ]),
      },
    ]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "releases-published",
      signal,
    });
    // The event feed is retention-bounded: even a natural end reports
    // partial, never a fabricated complete history.
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
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

  it("drops releases whose links are not canonical tag pages for this repository", async () => {
    const { port } = fixture([
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            type: "ReleaseEvent",
            created_at: "2026-08-19T12:00:00Z",
            actor: { login: "publisher" },
            payload: {
              action: "published",
              release: {
                id: 77,
                tag_name: "v1",
                html_url: "https://example.com/releases/v1",
              },
            },
          },
          {
            type: "ReleaseEvent",
            created_at: "2026-08-19T12:05:00Z",
            actor: { login: "publisher" },
            payload: {
              action: "published",
              release: {
                id: 78,
                tag_name: "v2",
                html_url: "https://github.com/octant-dev/other/releases/tag/v2",
              },
            },
          },
          {
            type: "ReleaseEvent",
            created_at: "2026-08-19T12:10:00Z",
            actor: { login: "publisher" },
            payload: {
              action: "published",
              release: {
                id: 79,
                tag_name: "v3",
                html_url: "https://github.com/octant-dev/octant/releases/tag/v3",
              },
            },
          },
        ]),
      },
    ]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "releases-published",
      signal,
    });
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ releaseId: 79 });
  });

  it("keeps paging while a full raw page produced few matching rows", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      event: "labeled",
      created_at: "2026-08-20T09:00:00Z",
      actor: { login: "labeler" },
      issue: { number: index + 1, title: "Noise" },
    }));
    const { command, port } = fixture([
      { exitCode: 0, stdout: JSON.stringify(fullPage) },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            event: "closed",
            created_at: "2026-08-20T09:05:00Z",
            actor: { login: "closer" },
            issue: { number: 11, title: "Real issue" },
          },
        ]),
      },
    ]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "issues-closed",
      signal,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(command.run).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ number: 11 });
  });

  it("answers partial when GitHub promises another page but hands back no cursor", async () => {
    const { port } = fixture([mergedPage([mergedNode()], { hasNextPage: true, endCursor: null })]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "prs-merged",
      signal,
    });
    expect(result).toMatchObject({ status: "partial", reason: "incomplete" });
  });

  it("answers rate-limited instead of a truncated ready", async () => {
    const { port } = fixture([{ exitCode: 1, stdout: "", stderr: "API rate limit exceeded" }]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "prs-merged",
      signal,
    });
    expect(result).toEqual({ status: "unavailable", reason: "rate-limited" });
  });

  it("answers a missing repository as partial with no rows", async () => {
    const { port } = fixture([{ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }]);
    const result = await port.observe({
      owner: "octant-dev",
      name: "octant",
      card: "issues-closed",
      signal,
    });
    expect(result).toEqual({ status: "partial", rows: [], reason: "repository-missing" });
  });

  it("refuses a malformed repository identity without calling gh", async () => {
    const { command, port } = fixture([]);
    const result = await port.observe({
      owner: "not a repo",
      name: "octant",
      card: "prs-merged",
      signal,
    });
    expect(result).toEqual({ status: "unavailable", reason: "read-failed" });
    expect(command.run).not.toHaveBeenCalled();
  });
});
