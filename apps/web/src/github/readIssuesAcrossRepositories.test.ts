import { describe, expect, it, vi } from "vitest";
import type { GithubCatalogueReadRequest, GithubCatalogueReadResponse } from "@octant/contracts";
import { readIssuesAcrossRepositories, sortIssueRows } from "./readIssuesAcrossRepositories";

function issuesPage(
  numbers: ReadonlyArray<number>,
  options: { readonly hasNextPage?: boolean; readonly stale?: boolean } = {},
): GithubCatalogueReadResponse {
  return {
    kind: "issues",
    page: {
      rows: numbers.map((number) => ({
        number,
        title: `Issue ${number}`,
        state: "open",
        author: "octocat",
        updatedAt: `2026-08-${String(number).padStart(2, "0")}T09:00:00.000Z`,
        url: `https://github.com/octant/repo/issues/${number}`,
      })),
      sort: "updated-desc",
      hasNextPage: options.hasNextPage === true,
      freshness: options.stale === true ? { status: "stale" } : { status: "fresh" },
    },
  };
}

describe("readIssuesAcrossRepositories", () => {
  it("merges one page per repository, names refusals in words, and bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind !== "issues") throw new Error("unexpected read");
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (request.name === "locked") {
        return {
          kind: "unavailable",
          capability: "issues-read",
          reason: "scope-limited",
          remediation: "repository-access-or-scope-required",
        } satisfies GithubCatalogueReadResponse;
      }
      if (request.name === "busy") return issuesPage([9], { hasNextPage: true, stale: true });
      return issuesPage([1, 2]);
    });

    const result = await readIssuesAcrossRepositories(
      { readCatalogue },
      [
        { owner: "octant", name: "app" },
        { owner: "octant", name: "locked" },
        { owner: "octant", name: "busy" },
        { owner: "octant", name: "docs" },
        { owner: "octant", name: "site" },
      ],
      { state: "open", pageSize: 20, concurrency: 2 },
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(result.rows.map((row) => `${row.name}#${row.number}`)).toEqual([
      "app#1",
      "app#2",
      "busy#9",
      "docs#1",
      "docs#2",
      "site#1",
      "site#2",
    ]);
    expect(result.refused).toEqual([
      {
        owner: "octant",
        name: "locked",
        message: "GitHub needs access to this repository, or the token is missing a scope.",
      },
    ]);
    expect(result.truncated).toEqual(["octant/busy"]);
    expect(result.stale).toBe(true);
    expect(readCatalogue).not.toHaveBeenCalledWith(expect.objectContaining({ search: "" }));
  });
});

describe("sortIssueRows", () => {
  const rows = [
    { ...issueRow(3, "2026-08-03"), owner: "octant", name: "zeta" },
    { ...issueRow(7, "2026-08-01"), owner: "octant", name: "alpha" },
    { ...issueRow(5, "2026-08-05"), owner: "octant", name: "alpha" },
  ];

  it("orders by update time, number, or repository without mutating the input", () => {
    const original = [...rows];
    expect(sortIssueRows(rows, "updated-desc").map((row) => row.number)).toEqual([5, 3, 7]);
    expect(sortIssueRows(rows, "updated-asc").map((row) => row.number)).toEqual([7, 3, 5]);
    expect(sortIssueRows(rows, "number-desc").map((row) => row.number)).toEqual([7, 5, 3]);
    expect(sortIssueRows(rows, "repository").map((row) => `${row.name}#${row.number}`)).toEqual([
      "alpha#5",
      "alpha#7",
      "zeta#3",
    ]);
    expect(rows).toEqual(original);
  });
});

function issueRow(number: number, day: string) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open" as const,
    author: "octocat",
    updatedAt: `${day}T09:00:00.000Z`,
    url: `https://github.com/octant/repo/issues/${number}`,
  };
}
