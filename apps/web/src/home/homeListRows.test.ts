import { describe, expect, it } from "vitest";
import { homeListMetaLine } from "./homeListModel";
import { assignedGithubListRow, pullRequestListRow } from "./homeListRows";
import type { PullRequestCardRow } from "./pullRequests";

const NOW = Date.parse("2026-11-14T12:00:00Z");

function pullRequest(overrides: Partial<PullRequestCardRow> = {}): PullRequestCardRow {
  return {
    key: "k",
    group: "yours",
    projectId: "p" as PullRequestCardRow["projectId"],
    repositoryOwner: "acme" as PullRequestCardRow["repositoryOwner"],
    repositoryName: "app" as PullRequestCardRow["repositoryName"],
    number: 12,
    title: "Make the list calm",
    reference: "app#12",
    ci: "passed",
    review: "in review",
    author: "henrik",
    updatedAt: "2026-11-14T11:55:00Z",
    ...overrides,
  };
}

describe("a row of the start screen's list", () => {
  it("says repository, number and age for the person's own pull request, and not who wrote it", () => {
    const row = pullRequestListRow(pullRequest(), "your-pull-requests", NOW, () => undefined);
    expect(homeListMetaLine(row.meta)).toBe("app · #12 · 5m");
    expect(row.title).toBe("Make the list calm");
    expect(JSON.stringify(row)).not.toContain("Your pull request");
  });

  it("names the author of a pull request that waits on the person's review", () => {
    const row = pullRequestListRow(
      pullRequest({ group: "waiting", author: "rista" }),
      "needs-you",
      NOW,
      () => undefined,
    );
    expect(homeListMetaLine(row.meta)).toBe("app · #12 · rista · 5m");
  });

  it("puts a failing check at the title's edge and says nothing for a plain row in review", () => {
    const failing = pullRequestListRow(
      pullRequest({ ci: "failed" }),
      "your-pull-requests",
      NOW,
      () => undefined,
    );
    expect(failing.trailing).toBe("Failing");
    expect(failing.tone).toBe("negative");
    const plain = pullRequestListRow(
      pullRequest({ ci: "none" }),
      "your-pull-requests",
      NOW,
      () => undefined,
    );
    expect(plain.trailing).toBeUndefined();
  });

  it("gives an assigned pull request the id the Pull requests read gives it", () => {
    const fromRead = pullRequestListRow(pullRequest(), "your-pull-requests", NOW, () => undefined);
    const assigned = assignedGithubListRow(
      {
        category: "pull-request",
        owner: "Acme",
        name: "App",
        number: 12,
        title: "Make the list calm",
        author: "henrik",
        updatedAt: "2026-11-14T11:55:00Z",
        url: "https://github.com/Acme/App/pull/12",
      } as Parameters<typeof assignedGithubListRow>[0],
      NOW,
      () => undefined,
    );
    expect(assigned.id).toBe(fromRead.id);
    expect(assigned.section).toBe("your-pull-requests");
    expect(homeListMetaLine(assigned.meta)).toBe("App · #12 · 5m");
  });
});
