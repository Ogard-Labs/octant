import {
  decodeCodeProjectPullRequestDetailView,
  type CodeProjectPullRequestDetailQuery,
  type CodeProjectPullRequestDetailRefreshCommand,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockProjectPullRequestReviewTool } from "./DockProjectPullRequestReviewTool";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const query: CodeProjectPullRequestDetailQuery = {
  projectId,
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
      author: "octocat",
      matchesDeliveryBranch: false,
      description: "Adds manual refresh.",
      diff: "diff --git a/README.md b/README.md",
      diffTruncated: false,
      commits: [],
      files: [],
      checks: [],
      reviews: [],
      comments: [],
    },
    freshness: { status: "fresh", lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z" },
    linkedThreads: [],
    generatedAt: "2026-08-22T08:00:00.000Z",
  });
}

describe("DockProjectPullRequestReviewTool", () => {
  it("refreshes detail once when a pull request is selected and renders read-only sections", async () => {
    const refresh = vi.fn(async (_command: CodeProjectPullRequestDetailRefreshCommand) =>
      detailView(),
    );
    const load = vi.fn(async () => detailView());
    render(
      <DockProjectPullRequestReviewTool load={load} query={query} refresh={refresh} />,
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(load).not.toHaveBeenCalled();
    expect(await screen.findByText("Adds manual refresh.")).toBeVisible();
    expect(screen.getByText(/Read-only review/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
  });
});
