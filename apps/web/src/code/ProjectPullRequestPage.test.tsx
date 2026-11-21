import {
  decodeCodeProjectPullRequestDetailView,
  decodeCodeThreadId,
  decodeUtcTimestamp,
  type CodeProjectPullRequestActionCommand,
  type CodeProjectPullRequestDetailQuery,
  type CodeProjectPullRequestLinkedThread,
  type CodePullRequestLineNotesSource,
  type CodeThreadId,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DockProjectPullRequestReviewTool } from "../shell/DockProjectPullRequestReviewTool";

const query: CodeProjectPullRequestDetailQuery = {
  projectId: decodeProjectId("10000000-0000-4000-8000-000000000001"),
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
};

const sampleDiff = [
  "diff --git a/src/refresh.ts b/src/refresh.ts",
  "--- a/src/refresh.ts",
  "+++ b/src/refresh.ts",
  "@@ -10,2 +10,3 @@ export function refresh() {",
  " const before = 1;",
  "-const oldValue = 2;",
  "+const nextValue = 3;",
  "+const answer = 42;",
].join("\n");

const linkedThreadOne: CodeProjectPullRequestLinkedThread = {
  threadId: decodeCodeThreadId("20000000-0000-4000-8000-000000000001"),
  title: "Fix refresh loop",
};

const linkedThreadTwo: CodeProjectPullRequestLinkedThread = {
  threadId: decodeCodeThreadId("20000000-0000-4000-8000-000000000002"),
  title: "Follow-up polish",
};

function detailView(
  description = "Adds manual refresh.",
  overrides: {
    readonly diff?: string;
    readonly diffTruncated?: boolean;
    readonly linkedThreads?: ReadonlyArray<CodeProjectPullRequestLinkedThread>;
  } = {},
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
      mergeability: "mergeable",
      matchesDeliveryBranch: false,
      description,
      diff: overrides.diff ?? "diff --git a/README.md b/README.md",
      diffTruncated: overrides.diffTruncated ?? false,
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
    linkedThreads: [...(overrides.linkedThreads ?? [])],
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

  it("renders the description as markdown with headings, bullets and code", async () => {
    const view = detailView("## Risks\n\n- One risk module\n- Six graded `actions`\n");
    renderPage({ load: async () => view, refresh: async () => view });

    expect(await screen.findByRole("heading", { level: 2, name: "Risks" })).toBeVisible();
    const bullets = screen
      .getAllByRole("listitem")
      .filter((item) => item.parentElement?.closest(".pr-detail__prose") !== null);
    expect(bullets.map((item) => item.textContent)).toEqual([
      "One risk module",
      "Six graded actions",
    ]);
    expect(screen.getByText("actions").tagName).toBe("CODE");
  });

  it("keeps Merge and its method menu in one split button", async () => {
    renderPage({
      onMerge: async (method) => ({
        status: "merged" as const,
        number: 12,
        method,
        mergedAt: decodeUtcTimestamp("2026-08-22T08:00:00.000Z"),
      }),
    });

    const merge = await screen.findByRole("button", { name: "Merge" });
    const method = screen.getByRole("button", { name: "Merge method" });
    expect(merge.parentElement).toBe(method.parentElement);
    expect(merge.parentElement).toHaveClass("pr-detail__split");
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

  it("keeps a half-written comment when the person looks at another tab and comes back", async () => {
    const user = userEvent.setup();
    const act = vi.fn(async (_command: CodeProjectPullRequestActionCommand) => ({
      status: "done" as const,
    }));
    renderPage({ act, loadActionContext: actionContext });
    await user.click(await screen.findByRole("tab", { name: "Timeline" }));
    await user.type(await screen.findByRole("textbox", { name: "Comment" }), "Half a thought");
    await user.click(screen.getByRole("tab", { name: "Summary" }));
    await user.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Half a thought");
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

  it("a pull request's diff opens a line note from a line-number button", async () => {
    const user = userEvent.setup();
    const view = detailView("Adds manual refresh.", {
      diff: sampleDiff,
      diffTruncated: true,
      linkedThreads: [linkedThreadOne],
    });
    renderPage({
      load: async () => view,
      refresh: async () => view,
      onSendLineNotes: async () => ({ status: "sent" as const }),
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    expect(screen.getByText("This diff is truncated and is not complete.")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 12" }),
    );
    const notes = screen.getByRole("region", { name: "Line notes" });
    expect(within(notes).getByText("src/refresh.ts, new line 12")).toBeVisible();
    expect(within(notes).getByText("const answer = 42;")).toBeVisible();
    expect(within(notes).getByLabelText("Note")).toBeVisible();
  });

  it("Send notes delivers one follow-up to the linked thread and clears the notes once accepted", async () => {
    const user = userEvent.setup();
    const view = detailView("Adds manual refresh.", {
      diff: sampleDiff,
      linkedThreads: [linkedThreadOne],
    });
    const onSendLineNotes = vi.fn(
      async (
        _threadId: CodeThreadId,
        _message: string,
        _source: CodePullRequestLineNotesSource,
      ) => ({ status: "sent" as const }),
    );
    renderPage({
      load: async () => view,
      refresh: async () => view,
      onSendLineNotes,
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 12" }),
    );
    const notes = screen.getByRole("region", { name: "Line notes" });
    await user.type(within(notes).getByLabelText("Note"), "Why 42?");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts original line 11" }),
    );
    await user.type(within(notes).getByLabelText("Note"), "Keep oldValue named.");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.click(within(notes).getByRole("button", { name: "Send 2 notes" }));

    expect(onSendLineNotes).toHaveBeenCalledTimes(1);
    expect(onSendLineNotes.mock.calls[0]?.[0]).toBe(linkedThreadOne.threadId);
    const message = onSendLineNotes.mock.calls[0]?.[1] ?? "";
    expect(message).toContain(
      "1. src/refresh.ts, new line 12\n   > const answer = 42;\n   Why 42?",
    );
    expect(message).toContain(
      "2. src/refresh.ts, old line 11\n   > const oldValue = 2;\n   Keep oldValue named.",
    );
    expect(onSendLineNotes.mock.calls[0]?.[2]).toEqual({
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 12,
    });
    await waitFor(() =>
      expect(within(notes).queryByRole("button", { name: /^Send/ })).not.toBeInTheDocument(),
    );
  });

  it("with no linked thread the notes stay and Send notes says to link a thread", async () => {
    const user = userEvent.setup();
    const view = detailView("Adds manual refresh.", {
      diff: sampleDiff,
      linkedThreads: [],
    });
    const onSendLineNotes = vi.fn(async () => ({ status: "sent" as const }));
    renderPage({
      load: async () => view,
      refresh: async () => view,
      onSendLineNotes,
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 12" }),
    );
    const notes = screen.getByRole("region", { name: "Line notes" });
    await user.type(within(notes).getByLabelText("Note"), "Check edge case");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));

    expect(within(notes).getByText("Check edge case")).toBeVisible();
    expect(within(notes).getByRole("button", { name: "Send 1 note" })).toBeDisabled();
    expect(within(notes).getByText("Link a Code thread to send notes")).toBeVisible();
    expect(onSendLineNotes).not.toHaveBeenCalled();
  });

  it("a refused send keeps the notes", async () => {
    const user = userEvent.setup();
    const view = detailView("Adds manual refresh.", {
      diff: sampleDiff,
      linkedThreads: [linkedThreadOne],
    });
    const onSendLineNotes = vi.fn(async () => ({
      status: "refused" as const,
      message: "A turn is already running on this thread.",
    }));
    renderPage({
      load: async () => view,
      refresh: async () => view,
      onSendLineNotes,
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 12" }),
    );
    const notes = screen.getByRole("region", { name: "Line notes" });
    await user.type(within(notes).getByLabelText("Note"), "Keep this note");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.click(within(notes).getByRole("button", { name: "Send 1 note" }));

    expect(
      await within(notes).findByText(
        "A turn is already running on this thread. Your notes are kept.",
      ),
    ).toBeVisible();
    expect(within(notes).getByText("Keep this note")).toBeVisible();
    expect(within(notes).getByRole("button", { name: "Send 1 note" })).toBeEnabled();
  });

  it("posts nothing to GitHub when notes are sent", async () => {
    const user = userEvent.setup();
    const view = detailView("Adds manual refresh.", {
      diff: sampleDiff,
      linkedThreads: [linkedThreadOne],
    });
    const act = vi.fn(async (_command: CodeProjectPullRequestActionCommand) => ({
      status: "done" as const,
    }));
    const onSendLineNotes = vi.fn(async () => ({ status: "sent" as const }));
    renderPage({
      load: async () => view,
      refresh: async () => view,
      act,
      loadActionContext: actionContext,
      onSendLineNotes,
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 12" }),
    );
    const notes = screen.getByRole("region", { name: "Line notes" });
    await user.type(within(notes).getByLabelText("Note"), "Local thread only");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.click(within(notes).getByRole("button", { name: "Send 1 note" }));

    await waitFor(() => expect(onSendLineNotes).toHaveBeenCalledTimes(1));
    expect(act).not.toHaveBeenCalled();
  });

  it("notes go to the first linked thread unless the person picks another", async () => {
    const user = userEvent.setup();
    const view = detailView("Adds manual refresh.", {
      diff: sampleDiff,
      linkedThreads: [linkedThreadOne, linkedThreadTwo],
    });
    const onSendLineNotes = vi.fn(
      async (
        _threadId: CodeThreadId,
        _message: string,
        _source: CodePullRequestLineNotesSource,
      ) => ({ status: "sent" as const }),
    );
    renderPage({
      load: async () => view,
      refresh: async () => view,
      onSendLineNotes,
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 12" }),
    );
    const notes = screen.getByRole("region", { name: "Line notes" });
    await user.type(within(notes).getByLabelText("Note"), "First thread note");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.click(within(notes).getByRole("button", { name: "Send 1 note" }));
    await waitFor(() => expect(onSendLineNotes).toHaveBeenCalledTimes(1));
    expect(onSendLineNotes.mock.calls[0]?.[0]).toBe(linkedThreadOne.threadId);

    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 11" }),
    );
    await user.type(within(notes).getByLabelText("Note"), "Second thread note");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.click(within(notes).getByRole("combobox", { name: "Send notes to thread" }));
    await user.click(await screen.findByRole("option", { name: "Follow-up polish" }));
    await user.click(within(notes).getByRole("button", { name: "Send 1 note" }));

    await waitFor(() => expect(onSendLineNotes).toHaveBeenCalledTimes(2));
    expect(onSendLineNotes.mock.calls[1]?.[0]).toBe(linkedThreadTwo.threadId);
  });

  it("preserves mode-change metadata in the pull request diff for mode-only and mixed changes", async () => {
    const user = userEvent.setup();
    const modeDiff = [
      "diff --git a/scripts/check.sh b/scripts/check.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100755",
      "new mode 100644",
      "--- a/scripts/run.sh",
      "+++ b/scripts/run.sh",
      "@@ -1 +1 @@",
      "-echo old",
      "+echo new",
    ].join("\n");
    const view = detailView("Adds executable script.", {
      diff: modeDiff,
      linkedThreads: [linkedThreadOne],
    });
    renderPage({
      load: async () => view,
      refresh: async () => view,
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    expect(screen.getByText("mode 100644 → 100755")).toBeVisible();
    expect(
      screen.getByText("File mode changed from 100644 to 100755 with no content changes."),
    ).toBeVisible();
    expect(screen.getByText("mode 100755 → 100644")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Comment on scripts/run.sh modified line 1" }),
    ).toBeVisible();
  });

  it("keeps pending line notes when refreshing returns an empty diff", async () => {
    const user = userEvent.setup();
    let current = detailView("Adds manual refresh.", {
      diff: sampleDiff,
      linkedThreads: [linkedThreadOne],
    });
    renderPage({
      load: async () => current,
      refresh: async () => current,
      onSendLineNotes: async () => ({ status: "sent" as const }),
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    await user.click(
      screen.getByRole("button", { name: "Comment on src/refresh.ts modified line 12" }),
    );
    const notes = screen.getByRole("region", { name: "Line notes" });
    await user.type(within(notes).getByLabelText("Note"), "Survives empty refresh");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    expect(within(notes).getByText("Survives empty refresh")).toBeVisible();

    current = detailView("Adds manual refresh.", {
      diff: "",
      linkedThreads: [linkedThreadOne],
    });
    await user.click(screen.getByRole("button", { name: "Refresh detail" }));

    expect(await screen.findByText("No diff observed.")).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Line notes" })).getByText(
        "Survives empty refresh",
      ),
    ).toBeVisible();
  });
});
