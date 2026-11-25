import {
  decodeCodeProjectPullRequestDetailView,
  decodeCodeProjectPullRequestView,
  decodeCodeThreadId,
  decodeUtcTimestamp,
  type CodeProjectPullRequestActionCommand,
  type CodeProjectPullRequestDetailQuery,
  type CodeProjectPullRequestLinkedThread,
  type CodeProjectPullRequestStackMergeCommand,
  type CodeProjectPullRequestStackMergeOutcome,
  type CodePullRequestLineNotesSource,
  type CodeThreadId,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

  it("offers Unlink from this thread first in More actions when the pull request is open in a thread", async () => {
    const user = userEvent.setup();
    const onUnlinkFromThread = vi.fn(async () => ({ status: "ok" }) as const);
    renderPage({ onUnlinkFromThread });
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveAccessibleName("Unlink from this thread");
    await user.click(items[0] as HTMLElement);
    expect(onUnlinkFromThread).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Unlinked from this thread.")).toBeVisible();
  });

  it("says why an unlink was refused", async () => {
    const user = userEvent.setup();
    const message = "This thread changed in another window. Try again.";
    renderPage({ onUnlinkFromThread: async () => ({ status: "refused", message }) as const });
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Unlink from this thread" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
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

  it("preserves mode-change metadata in the pull request diff without claiming a changed binary has no content changes", async () => {
    const user = userEvent.setup();
    const modeDiff = [
      "diff --git a/scripts/check.sh b/scripts/check.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/assets/logo.png b/assets/logo.png",
      "old mode 100644",
      "new mode 100755",
      "index 1111111..2222222",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
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
    const modeOnlyFile = screen.getByRole("region", { name: "scripts/check.sh" });
    expect(within(modeOnlyFile).getByText("mode 100644 → 100755")).toBeVisible();
    expect(
      within(modeOnlyFile).getByText(
        "File mode changed from 100644 to 100755 with no content changes.",
      ),
    ).toBeVisible();

    const binaryModeFile = screen.getByRole("region", { name: "assets/logo.png" });
    expect(within(binaryModeFile).getByText("mode 100644 → 100755")).toBeVisible();
    expect(
      within(binaryModeFile).getByText(
        "This file changed without a textual diff, so there is nothing to compare.",
      ),
    ).toBeVisible();
    expect(within(binaryModeFile).queryByText(/no content changes/i)).toBeNull();

    const textModeFile = screen.getByRole("region", { name: "scripts/run.sh" });
    expect(within(textModeFile).getByText("mode 100755 → 100644")).toBeVisible();
    expect(
      within(textModeFile).getByRole("button", {
        name: "Comment on scripts/run.sh modified line 1",
      }),
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

  it("anchors pull request line notes to decoded UTF-8 paths when git quotes the diff header", async () => {
    const user = userEvent.setup();
    const sendNotes = vi.fn(async (_threadId: string, _message: string) => ({
      status: "sent" as const,
    }));
    const quotedDiff = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n");
    const view = detailView("Updates café copy.", {
      diff: quotedDiff,
      linkedThreads: [linkedThreadOne],
    });
    renderPage({
      load: async () => view,
      refresh: async () => view,
      onSendLineNotes: sendNotes,
    });

    await user.click(await screen.findByRole("tab", { name: /Changes/ }));
    await user.click(screen.getByRole("button", { name: "Comment on café.txt modified line 1" }));
    const notes = screen.getByRole("region", { name: "Line notes" });
    await user.type(within(notes).getByLabelText("Note"), "Check accent");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.click(within(notes).getByRole("button", { name: "Send 1 note" }));

    expect(sendNotes).toHaveBeenCalledTimes(1);
    expect(sendNotes.mock.calls[0]?.[1]).toContain("café.txt, new line 1");
  });
});

describe("a pull request that is a layer of a stack", () => {
  const layer = (number: number, headBranch: string, baseBranch: string) => ({
    projectId: query.projectId,
    projectName: "Octant",
    repositoryOwner: "octant",
    repositoryName: "octant",
    number,
    title: `Layer ${String(number)}`,
    draft: false,
    state: "open",
    mergeability: "mergeable",
    author: "octocat",
    headBranch,
    baseBranch,
    updatedAt: "2026-08-22T07:00:00.000Z",
    checks: "passing",
    review: "approved",
    linkedThreads: [],
  });
  const snapshot = () =>
    decodeCodeProjectPullRequestView({
      version: 1,
      query: { version: 1 },
      projects: [],
      rows: [layer(13, "c", "b"), layer(12, "b", "a"), layer(11, "a", "main")],
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      freshness: { status: "fresh", lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z" },
      generatedAt: "2026-08-22T08:00:00.000Z",
    });
  const branches: Readonly<Record<number, readonly [string, string]>> = {
    11: ["a", "main"],
    12: ["b", "a"],
    13: ["c", "b"],
  };
  function layerDetail(number: number, overrides: Readonly<Record<string, unknown>> = {}) {
    const view = detailView();
    const [headBranch, baseBranch] = branches[number] ?? ["x", "main"];
    return decodeCodeProjectPullRequestDetailView({
      ...view,
      query: { ...query, number },
      detail: {
        ...view.detail,
        number,
        title: `Layer ${String(number)}`,
        url: `https://github.com/octant/octant/pull/${String(number)}`,
        headBranch,
        baseBranch,
        headSha: String(number).repeat(20),
        ...overrides,
      },
    });
  }

  function renderLayer(
    number: number,
    options: {
      readonly outcome?: CodeProjectPullRequestStackMergeOutcome;
      readonly details?: Readonly<Record<number, Readonly<Record<string, unknown>>>>;
      readonly layout?: "dock" | "page";
    } = {},
  ) {
    const details = options.details ?? {};
    const refresh = vi.fn(async (command: { readonly number: number }) =>
      layerDetail(command.number, details[command.number]),
    );
    const mergeStack = vi.fn(async (_command: CodeProjectPullRequestStackMergeCommand) => {
      return options.outcome ?? { status: "merged" as const, merged: [11, 12, 13] };
    });
    const loadPullRequests = vi.fn(async () => snapshot());
    render(
      <DockProjectPullRequestReviewTool
        layout={options.layout ?? "page"}
        load={async () => layerDetail(number)}
        loadPullRequests={loadPullRequests}
        mergeStack={mergeStack}
        onMerge={async () => ({ status: "unavailable", reason: "unavailable" })}
        query={{ ...query, number }}
        refresh={refresh}
      />,
    );
    return { loadPullRequests, mergeStack };
  }

  it("lists the layers bottom first, marks this one, and points to the bottom to merge them", async () => {
    renderLayer(12);
    const stack = await screen.findByRole("region", { name: "Stack" });
    const layers = within(stack).getAllByRole("listitem");
    expect(layers.map((item) => item.textContent)).toEqual([
      "#11Layer 11",
      "#12Layer 12",
      "#13Layer 13",
    ]);
    expect(layers.map((item) => item.getAttribute("aria-current"))).toEqual([null, "true", null]);
    expect(within(stack).getByText("Merge the stack from its bottom, #11.")).toBeVisible();
    expect(within(stack).queryByRole("button", { name: "Merge stack" })).toBeNull();
  });

  it.each(["page", "dock"] as const)(
    "merges the stack only after its heads and branch are confirmed (%s)",
    async (layout) => {
      const user = userEvent.setup();
      const { mergeStack } = renderLayer(11, { layout });
      await user.click(await screen.findByRole("button", { name: "Merge stack" }));

      const confirmation = await screen.findByRole("region", { name: "Confirm stack merge" });
      expect(confirmation).toHaveTextContent("Merge 3 pull requests into main?");
      expect(confirmation).toHaveTextContent("#12 1212121");
      expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
      expect(mergeStack).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Confirm stack merge" }));
      expect(mergeStack).toHaveBeenCalledWith({
        projectId: query.projectId,
        repositoryOwner: "octant",
        repositoryName: "octant",
        method: "squash",
        confirmed: true,
        items: [11, 12, 13].map((number) => ({ number, headSha: String(number).repeat(20) })),
      });
      expect(await screen.findByText(/^Merged #11, #12 and #13\./)).toHaveFocus();
    },
  );

  it("merges nothing when the person cancels", async () => {
    const user = userEvent.setup();
    const { mergeStack } = renderLayer(11);
    await user.click(await screen.findByRole("button", { name: "Merge stack" }));
    await screen.findByRole("region", { name: "Confirm stack merge" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Confirm stack merge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Merge stack" })).toHaveFocus();
    expect(mergeStack).not.toHaveBeenCalled();
  });

  it.each([
    ["a draft", { 13: { pullRequestState: "draft" } }, "#13 is a draft."],
    ["a conflict", { 12: { mergeability: "conflicting" } }, "#12 has merge conflicts."],
    ["a closed layer", { 12: { pullRequestState: "closed" } }, "#12 is no longer open."],
    ["a stale reading", { 12: { freshness: "stale" } }, "#12 has no fresh GitHub observation."],
    ["a layer that moved", { 13: { baseBranch: "main" } }, "#13 is no longer based on #12."],
  ])("refuses to merge a stack with %s and says which layer", async (_name, details, reason) => {
    const user = userEvent.setup();
    const { mergeStack } = renderLayer(11, { details });
    await user.click(await screen.findByRole("button", { name: "Merge stack" }));
    expect(await screen.findByText(reason)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm stack merge" })).toBeNull();
    expect(mergeStack).not.toHaveBeenCalled();
  });

  it("says what merged and why it stopped, even once the stack is no longer there", async () => {
    const user = userEvent.setup();
    const details: Record<number, Readonly<Record<string, unknown>>> = {};
    renderLayer(11, {
      details,
      outcome: {
        status: "stopped",
        merged: [11],
        stoppedAt: 12,
        outcome: { status: "refused", reason: "conflict" },
      },
    });
    await user.click(await screen.findByRole("button", { name: "Merge stack" }));
    const confirm = await screen.findByRole("button", { name: "Confirm stack merge" });
    details[11] = { pullRequestState: "merged" };
    await user.click(confirm);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Merged #11, then stopped at #12. Merge refused: GitHub reported a merge conflict.",
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Stack" })).toBeNull());
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it.each(["page", "dock"] as const)(
    "says which branch a higher layer merges into before it is merged alone (%s)",
    async (layout) => {
      const user = userEvent.setup();
      renderLayer(12, { layout });
      await screen.findByRole("region", { name: "Stack" });
      await user.click(screen.getByRole("button", { name: "Merge" }));
      expect(screen.getByRole("region", { name: "Confirm pull-request merge" })).toHaveTextContent(
        "This merges into a, the branch of #11, and reaches main when that one does.",
      );
    },
  );

  it("shows no stack once a fresh reading says the layer is based on another branch", async () => {
    const { loadPullRequests } = renderLayer(12, { details: { 12: { baseBranch: "main" } } });
    await screen.findByRole("heading", { level: 1, name: "Layer 12" });
    await act(async () => void (await loadPullRequests.mock.results[0]?.value));
    expect(loadPullRequests).toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Stack" })).toBeNull();
  });
});
