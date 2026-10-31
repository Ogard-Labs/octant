import {
  decodeCodeProjectPullRequestDetailView,
  decodeCodeProjectPullRequestSwitchesView,
  decodeCodeThreadId,
  decodeUtcTimestamp,
  type CodeProjectPullRequestSwitchOutcome,
  type CodeProjectPullRequestDetailQuery,
  type CodeProjectPullRequestDetailRefreshCommand,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DockProjectPullRequestReviewTool } from "./DockProjectPullRequestReviewTool";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const query: CodeProjectPullRequestDetailQuery = {
  projectId,
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
};

function detailView(
  description = "Adds manual refresh.",
  mergeability?: "mergeable" | "conflicting" | "unknown",
) {
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
      ...(mergeability === undefined ? {} : { mergeability }),
      matchesDeliveryBranch: false,
      description,
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
  it("formats a PR description while refusing embedded HTML and remote image loads", async () => {
    const view = detailView(
      "A **clear change** with [documentation](https://example.com/docs).\n\n<img src='https://example.com/tracker' onerror='alert(1)' />\n\n![Badge](https://example.com/badge.png)",
    );
    const { container } = render(
      <DockProjectPullRequestReviewTool
        query={query}
        load={async () => view}
        refresh={async () => view}
      />,
    );
    expect(await screen.findByRole("link", { name: "documentation" })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    );
    expect(screen.getByText("clear change").tagName).toBe("STRONG");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Original description").closest("details")).not.toHaveAttribute("open");
  });

  it("refreshes detail once when a pull request is selected and renders read-only sections", async () => {
    const refresh = vi.fn(async (_command: CodeProjectPullRequestDetailRefreshCommand) =>
      detailView(),
    );
    const load = vi.fn(async () => detailView());
    render(<DockProjectPullRequestReviewTool load={load} query={query} refresh={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(load).not.toHaveBeenCalled();
    expect(await screen.findByText("Adds manual refresh.", { selector: "p" })).toBeVisible();
    expect(screen.getByText(/Review data is read-only/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
  });

  it("offers to continue the review in a Chat thread", async () => {
    const onOpenChat = vi.fn();
    render(
      <DockProjectPullRequestReviewTool
        onOpenChat={onOpenChat}
        load={async () => detailView()}
        query={query}
        refresh={async () => detailView()}
      />,
    );

    await waitFor(() => expect(onOpenChat).not.toHaveBeenCalled());
    await screen.findByText("Adds manual refresh.", { selector: "p" });
    screen.getByRole("button", { name: "Open chat" }).click();
    expect(onOpenChat).toHaveBeenCalledOnce();
  });

  it("requires confirmation before merging a fresh mergeable pull request", async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn(async (method: "merge" | "squash" | "rebase") => ({
      status: "merged" as const,
      number: 12,
      method,
      mergedAt: decodeUtcTimestamp("2026-08-22T08:00:00.000Z"),
    }));
    render(
      <DockProjectPullRequestReviewTool
        load={async () => detailView("Ready to merge.", "mergeable")}
        onMerge={onMerge}
        query={query}
        refresh={async () => detailView("Ready to merge.", "mergeable")}
      />,
    );

    await screen.findByText("Ready to merge.", { selector: "p" });
    const opener = screen.getByRole("button", { name: "Merge" });
    await user.click(opener);
    const warning = await screen.findByRole("region", { name: "Confirm pull-request merge" });
    expect(warning).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(opener).not.toHaveAttribute("aria-hidden");
    await user.tab();
    expect(screen.getByRole("button", { name: "Confirm merge" })).toHaveFocus();
    await user.tab();
    expect(warning.contains(document.activeElement)).toBe(false);
    await user.tab({ shift: true });
    await user.keyboard("{Escape}");
    expect(onMerge).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Confirm pull-request merge" })).toBeNull();
    expect(opener).toHaveFocus();
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onMerge).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Confirm merge" }));

    expect(onMerge).toHaveBeenCalledWith("squash", "9".repeat(40));
    expect(
      await screen.findByText("Merged pull request #12. Refreshing its review state."),
    ).toBeVisible();
  });
  it("restores Merge after cancelling a failed inline attempt", async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn(async () => {
      throw new Error("Connection unavailable");
    });
    render(
      <DockProjectPullRequestReviewTool
        load={async () => detailView("Ready to merge.", "mergeable")}
        onMerge={onMerge}
        query={query}
        refresh={async () => detailView("Ready to merge.", "mergeable")}
      />,
    );
    const opener = await screen.findByRole("button", { name: "Merge" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Confirm merge" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(opener).toHaveFocus();
    expect(onMerge).toHaveBeenCalledOnce();
  });

  it("turns Merge when ready and Auto-fix on with a click and says why a repository refuses", async () => {
    const user = userEvent.setup();
    const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
    const linked = decodeCodeProjectPullRequestDetailView({
      ...detailView("Body", "mergeable"),
      linkedThreads: [{ threadId, title: "Fix refresh" }],
    });
    const off = decodeCodeProjectPullRequestSwitchesView({
      version: 1,
      target: query,
      mergeWhenReady: { status: "off" },
      autoFix: { status: "off" },
      generatedAt: "2026-08-22T08:00:00.000Z",
    });
    const autoFixOn = decodeCodeProjectPullRequestSwitchesView({
      ...off,
      autoFix: { status: "on", threadId, enabledAt: "2026-08-22T08:01:00.000Z" },
    });
    const setMergeWhenReady = vi.fn(
      async (): Promise<CodeProjectPullRequestSwitchOutcome> => ({
        status: "unsupported",
        reason: "auto-merge-not-allowed",
      }),
    );
    const setAutoFix = vi.fn(
      async (): Promise<CodeProjectPullRequestSwitchOutcome> => ({
        status: "applied",
        view: autoFixOn,
      }),
    );
    render(
      <DockProjectPullRequestReviewTool
        load={async () => linked}
        loadSwitches={async () => off}
        query={query}
        refresh={async () => linked}
        setAutoFix={setAutoFix}
        setMergeWhenReady={setMergeWhenReady}
      />,
    );

    const mergeWhenReady = await screen.findByRole("switch", { name: "Merge when ready" });
    expect(mergeWhenReady).not.toBeChecked();
    await user.click(mergeWhenReady);
    expect(setMergeWhenReady).toHaveBeenCalledWith({
      kind: "enable",
      target: query,
      headSha: "9".repeat(40),
      method: "squash",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Merge when ready is unsupported: this repository does not allow auto-merge.",
    );
    expect(mergeWhenReady).not.toBeChecked();

    const autoFix = screen.getByRole("switch", { name: "Auto-fix" });
    expect(screen.getByText(/let “Fix refresh” fix failed checks/)).toBeVisible();
    await user.click(autoFix);
    expect(setAutoFix).toHaveBeenCalledWith({ kind: "enable", target: query, threadId });
    await waitFor(() => expect(autoFix).toBeChecked());
    expect(screen.getByText(/On\. Watching for failed checks/)).toBeVisible();
  });

  it("keeps Auto-fix off and says why when no Code thread is linked", async () => {
    const off = decodeCodeProjectPullRequestSwitchesView({
      version: 1,
      target: query,
      mergeWhenReady: { status: "off" },
      autoFix: { status: "off" },
      generatedAt: "2026-08-22T08:00:00.000Z",
    });
    render(
      <DockProjectPullRequestReviewTool
        load={async () => detailView()}
        loadSwitches={async () => off}
        query={query}
        refresh={async () => detailView()}
        setAutoFix={vi.fn()}
        setMergeWhenReady={vi.fn()}
      />,
    );
    const autoFix = await screen.findByRole("switch", { name: "Auto-fix" });
    expect(autoFix).toHaveAttribute("aria-disabled", "true");
    expect(autoFix).toHaveAttribute(
      "title",
      "Link a Code thread to this pull request to use Auto-fix.",
    );
  });
});
