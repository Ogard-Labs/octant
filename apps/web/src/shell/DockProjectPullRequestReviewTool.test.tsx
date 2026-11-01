import {
  decodeCodeProjectPullRequestDetailView,
  decodeCodeProjectPullRequestSwitchesView,
  decodeCodeThreadId,
  decodeUtcTimestamp,
  type CodeProjectPullRequestActionCommand,
  type CodeProjectPullRequestActionContext,
  type CodeProjectPullRequestActionOutcome,
  type CodeProjectPullRequestMergeOutcome,
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
  it("says plainly why the host refused a merge whose required checks have not passed", async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn(
      async (): Promise<CodeProjectPullRequestMergeOutcome> => ({
        status: "refused",
        reason: "checks-not-passing",
      }),
    );
    render(
      <DockProjectPullRequestReviewTool
        load={async () => detailView("Ready to merge.", "mergeable")}
        onMerge={onMerge}
        query={query}
        refresh={async () => detailView("Ready to merge.", "mergeable")}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    await user.click(screen.getByRole("button", { name: "Confirm merge" }));

    expect(
      await screen.findByText("Merge refused: the required checks have not all passed."),
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
    expect(setMergeWhenReady).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("region", { name: "Confirm Merge when ready" }),
    ).toHaveTextContent("9999999");
    await user.click(screen.getByRole("button", { name: "Confirm Merge when ready" }));
    expect(setMergeWhenReady).toHaveBeenCalledWith({
      kind: "enable",
      target: query,
      headSha: "9".repeat(40),
      method: "squash",
      confirmed: true,
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

  it("turns Merge when ready on only after the person confirms, and cancelling sends nothing", async () => {
    const user = userEvent.setup();
    const off = decodeCodeProjectPullRequestSwitchesView({
      version: 1,
      target: query,
      mergeWhenReady: { status: "off" },
      autoFix: { status: "off" },
      generatedAt: "2026-08-22T08:00:00.000Z",
    });
    const setMergeWhenReady = vi.fn();
    render(
      <DockProjectPullRequestReviewTool
        load={async () => detailView()}
        loadSwitches={async () => off}
        query={query}
        refresh={async () => detailView()}
        setAutoFix={vi.fn()}
        setMergeWhenReady={setMergeWhenReady}
      />,
    );
    await user.click(await screen.findByRole("switch", { name: "Merge when ready" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Confirm Merge when ready" })).toBeNull();
    expect(setMergeWhenReady).not.toHaveBeenCalled();
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

  describe("the person's own pull-request actions", () => {
    const readContext = (
      overrides: Partial<Extract<CodeProjectPullRequestActionContext, { status: "read" }>> = {},
    ): CodeProjectPullRequestActionContext => ({
      status: "read",
      labels: ["bug"],
      repositoryLabels: ["bug", "p1"],
      reviewThreads: [
        {
          id: "PRRT_1",
          resolved: false,
          outdated: false,
          path: "src/a.ts",
          author: "reviewer",
          excerpt: "Please rename this.",
        },
        {
          id: "PRRT_2",
          resolved: true,
          outdated: false,
          path: "src/b.ts",
          author: "reviewer",
          excerpt: "Already handled.",
        },
      ],
      ...overrides,
    });
    const done = async (): Promise<CodeProjectPullRequestActionOutcome> => ({ status: "done" });
    const renderActions = (
      act: (
        command: CodeProjectPullRequestActionCommand,
      ) => Promise<CodeProjectPullRequestActionOutcome>,
      context: CodeProjectPullRequestActionContext = readContext(),
      view = detailView(),
    ) =>
      render(
        <DockProjectPullRequestReviewTool
          act={act}
          load={async () => view}
          loadActionContext={async () => context}
          query={query}
          refresh={async () => view}
        />,
      );

    it("adds and removes only labels the repository already has, naming the pull request", async () => {
      const user = userEvent.setup();
      const act = vi.fn(done);
      renderActions(act);
      await user.click(await screen.findByRole("button", { name: "Add label p1" }));
      expect(act).toHaveBeenLastCalledWith({ kind: "labels", ...query, add: ["p1"], remove: [] });
      await user.click(await screen.findByRole("button", { name: "Remove label bug" }));
      expect(act).toHaveBeenLastCalledWith({ kind: "labels", ...query, add: [], remove: ["bug"] });
      expect(screen.queryByRole("textbox", { name: /label/i })).toBeNull();
    });

    it("reads the labels and review threads once, however often the dock re-renders", async () => {
      const loadActionContext = vi.fn(async () => readContext());
      const view = detailView();
      const props = {
        act: vi.fn(done),
        load: async () => view,
        query,
        refresh: async () => view,
      };
      const { rerender } = render(
        <DockProjectPullRequestReviewTool
          {...props}
          loadActionContext={() => loadActionContext()}
        />,
      );
      await screen.findByRole("button", { name: "Add label p1" });
      rerender(
        <DockProjectPullRequestReviewTool
          {...props}
          loadActionContext={() => loadActionContext()}
        />,
      );
      rerender(
        <DockProjectPullRequestReviewTool
          {...props}
          loadActionContext={() => loadActionContext()}
        />,
      );
      expect(loadActionContext).toHaveBeenCalledTimes(1);
    });

    it("posts a comment under the person's name and clears the box", async () => {
      const user = userEvent.setup();
      const act = vi.fn(done);
      renderActions(act);
      const box = await screen.findByRole("textbox", { name: "Comment" });
      expect(screen.getByRole("button", { name: "Post comment" })).toBeDisabled();
      await user.type(box, "Looks good.");
      await user.click(screen.getByRole("button", { name: "Post comment" }));
      expect(act).toHaveBeenCalledWith({ kind: "comment", ...query, body: "Looks good." });
      await waitFor(() => expect(box).toHaveValue(""));
      expect(await screen.findByText("Posted your comment.")).toBeVisible();
    });

    it("replies in an open review thread only, naming that thread", async () => {
      const user = userEvent.setup();
      const act = vi.fn(done);
      renderActions(act);
      expect(await screen.findByText("Please rename this.")).toBeVisible();
      expect(screen.queryByText("Already handled.")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Reply" }));
      await user.type(screen.getByRole("textbox", { name: "Your reply" }), "Renamed.");
      await user.click(screen.getByRole("button", { name: "Post reply" }));
      expect(act).toHaveBeenCalledWith({
        kind: "reply",
        ...query,
        reviewThreadId: "PRRT_1",
        body: "Renamed.",
      });
    });

    it("closes an open pull request and reopens a closed one, never offering either once merged", async () => {
      const user = userEvent.setup();
      const act = vi.fn(done);
      const first = renderActions(act);
      await user.click(await screen.findByRole("button", { name: "Close pull request" }));
      expect(act).toHaveBeenCalledWith({ kind: "close", ...query });
      first.unmount();

      const closed = decodeCodeProjectPullRequestDetailView({
        ...detailView(),
        detail: { ...detailView().detail, pullRequestState: "closed" },
      });
      const second = renderActions(act, readContext(), closed);
      await user.click(await screen.findByRole("button", { name: "Reopen pull request" }));
      expect(act).toHaveBeenLastCalledWith({ kind: "reopen", ...query });
      second.unmount();

      const merged = decodeCodeProjectPullRequestDetailView({
        ...detailView(),
        detail: { ...detailView().detail, pullRequestState: "merged" },
      });
      renderActions(act, readContext(), merged);
      await screen.findByRole("textbox", { name: "Comment" });
      expect(screen.queryByRole("button", { name: /close pull request|reopen/i })).toBeNull();
    });

    it("says plainly when the host refuses, and when a paired device may not do it", async () => {
      const user = userEvent.setup();
      const act = vi
        .fn<
          (
            command: CodeProjectPullRequestActionCommand,
          ) => Promise<CodeProjectPullRequestActionOutcome>
        >()
        .mockResolvedValueOnce({ status: "refused", reason: "label-not-found" })
        .mockRejectedValueOnce({ category: "unauthorized" });
      renderActions(act);
      await user.click(await screen.findByRole("button", { name: "Add label p1" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "the repository does not have that label",
      );
      await user.click(screen.getByRole("button", { name: "Add label p1" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("Only the desktop window can do this."),
      );
    });

    it("shows the actions as off, with the reason, when the Project is not connected to the repository", async () => {
      renderActions(vi.fn(done), { status: "refused", reason: "not-authorized" });
      expect(
        await screen.findByText(/not connected to that repository, so these actions are off/),
      ).toBeVisible();
    });
  });
});
