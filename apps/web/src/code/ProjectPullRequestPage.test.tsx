import {
  decodeCodeProjectPullRequestDetailView,
  decodeUtcTimestamp,
  type CodeProjectPullRequestActionCommand,
  type CodeProjectPullRequestDetailQuery,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DockProjectPullRequestReviewTool } from "../shell/DockProjectPullRequestReviewTool";

const query: CodeProjectPullRequestDetailQuery = {
  projectId: decodeProjectId("10000000-0000-4000-8000-000000000001"),
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
};

function detailView() {
  return decodeCodeProjectPullRequestDetailView({
    version: 1,
    query,
    detail: {
      state: "observed",
      freshness: "fresh",
      ambiguous: false,
      staleSections: [],
      number: 12,
      url: "https://github.com/octant/octant/pull/12",
      title: "List active pull requests",
      pullRequestState: "open",
      baseRepository: "octant/octant",
      baseBranch: "development",
      headRepository: "octant/octant",
      headBranch: "feature/manual-refresh",
      headSha: "9".repeat(40),
      author: "octocat",
      mergeability: "mergeable",
      matchesDeliveryBranch: false,
      description: "Adds manual refresh.",
      diff: "diff --git a/README.md b/README.md",
      diffTruncated: false,
      commits: [{ oid: "a".repeat(40), messageHeadline: "Refresh by hand", author: "octocat" }],
      files: [{ path: "src/refresh.ts", additions: 12, deletions: 3 }],
      checks: [
        { name: "lint", state: "success" },
        { name: "unit tests", state: "failure" },
      ],
      reviews: [{ author: "reviewer", state: "approved", body: "" }],
      comments: [{ author: "octocat", body: "Ready when you are." }],
    },
    freshness: { status: "fresh", lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z" },
    linkedThreads: [],
    generatedAt: "2026-08-22T08:00:00.000Z",
  });
}

function renderPage(extra: Partial<Parameters<typeof DockProjectPullRequestReviewTool>[0]> = {}) {
  const view = detailView();
  return render(
    <DockProjectPullRequestReviewTool
      layout="page"
      load={async () => view}
      query={query}
      refresh={async () => view}
      {...extra}
    />,
  );
}

const actionContext = async () =>
  ({
    status: "read",
    labels: [],
    repositoryLabels: ["bug"],
    reviewThreads: [],
  }) as const;

describe("the pull-request reading pane", () => {
  it("opens on the summary with the title, the description and the status column, and no forms", async () => {
    renderPage({ act: async () => ({ status: "done" }), loadActionContext: actionContext });

    expect(
      await screen.findByRole("heading", { level: 1, name: "List active pull requests" }),
    ).toBeVisible();
    expect(screen.getByText("Adds manual refresh.")).toBeVisible();
    const status = screen.getByRole("complementary", { name: "Pull request status" });
    expect(within(status).getByText("Can merge without conflicts")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("lists the failing check first in the status column", async () => {
    renderPage();
    const checks = await screen.findByRole("region", { name: "Checks" });
    const names = within(checks)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(names[0]).toContain("unit tests");
    expect(names[1]).toContain("lint");
  });

  it("shows added and removed lines on the Changes tab and switches to it", async () => {
    const user = userEvent.setup();
    renderPage();
    const tab = await screen.findByRole("tab", { name: /Changes/ });
    expect(tab).toHaveTextContent("+12");
    expect(tab).toHaveTextContent("−3");
    await user.click(tab);
    expect(screen.getByText("src/refresh.ts")).toBeVisible();
    expect(screen.queryByText("Adds manual refresh.")).toBeNull();
  });

  it("keeps the comment and review forms in the Timeline tab, after the conversation", async () => {
    const user = userEvent.setup();
    const act = vi.fn(async (_command: CodeProjectPullRequestActionCommand) => ({
      status: "done" as const,
    }));
    renderPage({ act, loadActionContext: actionContext });
    await user.click(await screen.findByRole("tab", { name: "Timeline" }));

    expect(screen.getByText("Ready when you are.")).toBeVisible();
    await user.type(await screen.findByRole("textbox", { name: "Comment" }), "Looks good");
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(act).toHaveBeenCalledWith({ kind: "comment", ...query, body: "Looks good" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
  });

  it("asks before merging and merges the reviewed head with the chosen method", async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn(async (method: "merge" | "squash" | "rebase") => ({
      status: "merged" as const,
      number: 12,
      method,
      mergedAt: decodeUtcTimestamp("2026-08-22T08:00:00.000Z"),
    }));
    renderPage({ onMerge });

    await user.click(await screen.findByRole("button", { name: "Merge" }));
    expect(onMerge).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Confirm pull-request merge" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect(onMerge).toHaveBeenCalledWith("squash", "9".repeat(40));
  });

  it("puts closing the pull request in the overflow menu", async () => {
    const user = userEvent.setup();
    const act = vi.fn(async (_command: CodeProjectPullRequestActionCommand) => ({
      status: "done" as const,
    }));
    renderPage({ act, loadActionContext: actionContext });
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Close pull request" }));
    expect(act).toHaveBeenCalledWith({ kind: "close", ...query });
  });
});
