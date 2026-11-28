import type { LinearIssueListPage, LinearIssueRow } from "@octant/contracts/linear-issues";
import { describe, expect, it, vi } from "vitest";
import {
  ASSIGNED_LINEAR_MAX_PAGES,
  ASSIGNED_LINEAR_PAGE_SIZE,
  loadAssignedLinearIssues,
  loadAssignedLinearIssuesAcrossAccounts,
} from "./loadAssignedLinearIssues";

const row = (id: string): LinearIssueRow => ({
  id,
  identifier: `ENG-${id}`,
  title: `Issue ${id}`,
  state: { name: "Todo", type: "unstarted" },
  assignee: "Ada",
  url: `https://linear.app/ogard-labs/issue/ENG-${id}`,
});

describe("loadAssignedLinearIssues", () => {
  it("aggregates every page until the host reports no further results", async () => {
    const listIssues = vi
      .fn<(input: { cursor?: string }) => Promise<LinearIssueListPage>>()
      .mockResolvedValueOnce({
        rows: [row("1")],
        hasNextPage: true,
        endCursor: "page-2",
      })
      .mockResolvedValueOnce({
        rows: [row("2")],
        hasNextPage: false,
      });

    const page = await loadAssignedLinearIssues(listIssues);

    expect(page.rows).toEqual([row("1"), row("2")]);
    expect(page.hasNextPage).toBe(false);
    expect(page.truncated).toBe(false);
    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues.mock.calls[0]?.[0]).toEqual({
      filter: { assigneeId: "me" },
      pageSize: ASSIGNED_LINEAR_PAGE_SIZE,
    });
    expect(listIssues.mock.calls[1]?.[0]).toEqual({
      filter: { assigneeId: "me" },
      pageSize: ASSIGNED_LINEAR_PAGE_SIZE,
      cursor: "page-2",
    });
  });

  it("stops at the safety cap and reports truncation when more remain", async () => {
    const listIssues = vi.fn(
      async (): Promise<LinearIssueListPage> => ({
        rows: [row("more")],
        hasNextPage: true,
        endCursor: "next",
      }),
    );

    const page = await loadAssignedLinearIssues(listIssues);

    expect(page.rows).toHaveLength(ASSIGNED_LINEAR_MAX_PAGES);
    expect(page.hasNextPage).toBe(true);
    expect(page.truncated).toBe(true);
    expect(page.endCursor).toBe("next");
    expect(listIssues).toHaveBeenCalledTimes(ASSIGNED_LINEAR_MAX_PAGES);
  });

  it("merges assigned issues across multiple accounts with workspace labels", async () => {
    const listIssues = vi.fn(
      async (
        _input: { readonly cursor?: string },
        accountRef: string,
      ): Promise<LinearIssueListPage> => ({
        rows: [row(accountRef === "acct-a" ? "1" : "2")],
        hasNextPage: false,
      }),
    );
    const merged = await loadAssignedLinearIssuesAcrossAccounts(
      [
        { accountRef: "acct-a", workspaceLabel: "Personal" },
        { accountRef: "acct-b", workspaceLabel: "Company" },
      ],
      listIssues,
    );
    expect(merged.rows).toEqual([
      { ...row("1"), accountRef: "acct-a", workspaceLabel: "Personal" },
      { ...row("2"), accountRef: "acct-b", workspaceLabel: "Company" },
    ]);
  });
});
