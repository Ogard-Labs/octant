import { describe, expect, it } from "vitest";
import {
  decodeLinearIssueDetail,
  decodeLinearIssueFilterOptions,
  decodeLinearIssueGetInput,
  decodeLinearIssueListInput,
  decodeLinearIssueListPage,
  linearIssueBrowseAvailable,
} from "./linearIssues";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-12",
  title: "Browse issues in the workspace",
  state: { name: "In Progress", type: "started" },
  assignee: "Ada",
  url: "https://linear.app/ogard-labs/issue/ENG-12",
} as const;

describe("Linear issue contracts", () => {
  it("accepts a bounded issue list page with identifier, title, state, and assignee", () => {
    const decoded = decodeLinearIssueListPage({
      rows: [row],
      hasNextPage: true,
      endCursor: "eyJwYWdlIjoyfQ==",
    });
    expect(decoded.rows).toHaveLength(1);
    expect(decoded.rows[0]?.identifier).toBe("ENG-12");
    expect(decoded.hasNextPage).toBe(true);
  });

  it("accepts search and basic filters on a list request", () => {
    expect(
      decodeLinearIssueListInput({
        search: "browse",
        filter: {
          teamId: "22222222-2222-4222-8222-222222222222",
          stateId: "33333333-3333-4333-8333-333333333333",
          assigneeId: "unassigned",
          projectId: "44444444-4444-4444-8444-444444444444",
        },
        pageSize: 25,
      }),
    ).toMatchObject({ search: "browse", pageSize: 25 });
  });

  it("bounds page size between 1 and 50", () => {
    expect(decodeLinearIssueListInput({ pageSize: 50 }).pageSize).toBe(50);
    expect(() => decodeLinearIssueListInput({ pageSize: 0 })).toThrow();
    expect(() => decodeLinearIssueListInput({ pageSize: 51 })).toThrow();
  });

  it("rejects token-like text and Linear URLs that could smuggle credentials", () => {
    expect(() => decodeLinearIssueListInput({ search: "lin_api_abcdefghijklmnop" })).toThrow();
    expect(() =>
      decodeLinearIssueListPage({
        rows: [
          {
            ...row,
            url: "https://user:lin_api_secret@linear.app/ogard-labs/issue/ENG-12",
          },
        ],
        hasNextPage: false,
      }),
    ).toThrow();
    expect(() =>
      decodeLinearIssueDetail({
        ...row,
        description: "bearer abcdef",
        descriptionTruncated: false,
      }),
    ).toThrow();
  });

  it("accepts a bounded issue detail and filter options", () => {
    expect(
      decodeLinearIssueDetail({
        ...row,
        description: "Read-only browse.",
        descriptionTruncated: false,
      }).descriptionTruncated,
    ).toBe(false);
    expect(decodeLinearIssueGetInput({ id: row.id }).id).toBe(row.id);
    expect(linearIssueBrowseAvailable([])).toBe(false);
    expect(linearIssueBrowseAvailable([{ operationId: "list-issues", available: false }])).toBe(
      false,
    );
    expect(linearIssueBrowseAvailable([{ operationId: "list-issues", available: true }])).toBe(
      true,
    );
    expect(
      decodeLinearIssueFilterOptions({
        teams: [{ id: "22222222-2222-4222-8222-222222222222", label: "Engineering" }],
        states: [{ id: "33333333-3333-4333-8333-333333333333", label: "In Progress" }],
        assignees: [{ id: "unassigned", label: "Unassigned" }],
        projects: [{ id: "44444444-4444-4444-8444-444444444444", label: "Octant" }],
      }).assignees[0]?.id,
    ).toBe("unassigned");
  });
});
