import {
  decodeProjectId,
  decodeThreadBoardPullRequestSummaries,
  decodeThreadNavigationPullRequestSummaries,
  type ThreadBoardPullRequestSummaries,
} from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentThreadPullRequests } from "./EnvironmentThreadPullRequests";

const projectId = String(decodeProjectId("00000000-0000-4000-8000-000000000901"));

function summary(
  number: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    identity: { projectId, repositoryOwner: "acme", repositoryName: "repo", number },
    title: `Change ${String(number)}`,
    state: "open",
    checks: "unknown",
    review: "unknown",
    mergeability: "unknown",
    freshness: "fresh",
    readyToMerge: false,
    ...overrides,
  };
}

function summaries(
  items: ReadonlyArray<Readonly<Record<string, unknown>>>,
  hiddenCount = 0,
): ThreadBoardPullRequestSummaries {
  return decodeThreadBoardPullRequestSummaries({ items, hiddenCount });
}

/** Line two of a row, read as one string: its parts are separate boxes so the repository can give way first. */
function meta(text: string): HTMLElement {
  return screen.getByText(
    (_, element) =>
      element?.classList.contains("environment-thread-pr__meta") === true &&
      element.textContent === text,
  );
}

describe("EnvironmentThreadPullRequests", () => {
  it("draws nothing without summaries and with an empty list", () => {
    const { container, rerender } = render(<EnvironmentThreadPullRequests />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EnvironmentThreadPullRequests summaries={summaries([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows each pull request's title, repository, number and state", () => {
    const { rerender } = render(
      <EnvironmentThreadPullRequests
        summaries={summaries([
          summary(1, { state: "open" }),
          summary(2, { state: "draft" }),
          summary(3, { state: "merged" }),
        ])}
      />,
    );
    expect(screen.getByRole("group", { name: "Pull requests" })).toBeVisible();
    expect(screen.getByText("Change 1")).toBeVisible();
    expect(meta("repo #1 · Open")).toBeVisible();
    expect(meta("repo #2 · Draft")).toBeVisible();
    expect(meta("repo #3 · Merged")).toBeVisible();
    rerender(
      <EnvironmentThreadPullRequests
        summaries={summaries([summary(4, { state: "closed" }), summary(5, { state: "unknown" })])}
      />,
    );
    expect(meta("repo #4 · Closed")).toBeVisible();
    expect(meta("repo #5")).toBeVisible();
  });

  it("names checks in words for open and draft pull requests but not merged or closed ones", () => {
    const { rerender } = render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        summaries={summaries([
          summary(1, { state: "open", checks: "passing", readyToMerge: true }),
          summary(2, { state: "draft", checks: "failing" }),
          summary(3, { state: "merged", checks: "passing" }),
        ])}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Pull request 1, Change 1, open, checks passing, ready to merge",
      }),
    ).toBeVisible();
    expect(meta("repo #1 · Open · Ready to merge")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Pull request 2, Change 2, draft, checks failing" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Pull request 3, Change 3, merged" })).toBeVisible();
    rerender(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        summaries={summaries([
          summary(4, { state: "closed", checks: "failing" }),
          summary(5, { state: "open", checks: "unknown", freshness: "stale" }),
        ])}
      />,
    );
    expect(screen.getByRole("button", { name: "Pull request 4, Change 4, closed" })).toBeVisible();
    // A stale reading is said, not hidden.
    expect(meta("repo #5 · Open · Stale snapshot")).toBeVisible();
  });

  it("opens the pull request in the app when its row is pressed", async () => {
    const onOpen = vi.fn();
    render(<EnvironmentThreadPullRequests onOpen={onOpen} summaries={summaries([summary(7)])} />);
    await userEvent.click(screen.getByRole("button", { name: /^Pull request 7/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(summary(7).identity);
  });

  it("offers Open on GitHub and Copy link from the row's menu without also opening it", async () => {
    const onOpen = vi.fn();
    const onOpenOnGithub = vi.fn();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <EnvironmentThreadPullRequests
        onOpen={onOpen}
        onOpenOnGithub={onOpenOnGithub}
        summaries={summaries([summary(7)])}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "More for pull request #7" }));
    const github = await screen.findByRole("menuitem", { name: "Open on GitHub" });
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await userEvent.click(github);
    expect(onOpenOnGithub).toHaveBeenCalledWith(summary(7).identity);

    await userEvent.click(screen.getByRole("button", { name: "More for pull request #7" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://github.com/acme/repo/pull/7");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says how many more pull requests are not shown", () => {
    const { rerender } = render(
      <EnvironmentThreadPullRequests summaries={summaries([summary(1)], 1)} />,
    );
    expect(screen.getByText("1 more not shown")).toBeVisible();
    rerender(<EnvironmentThreadPullRequests summaries={summaries([summary(1)], 4)} />);
    expect(screen.getByText("4 more not shown")).toBeVisible();
    rerender(<EnvironmentThreadPullRequests summaries={summaries([summary(1)])} />);
    expect(screen.queryByText(/more not shown/)).not.toBeInTheDocument();
  });

  it("folds a thread's pull requests past ten behind Show more and back behind Show less", async () => {
    const user = userEvent.setup();
    const many = decodeThreadNavigationPullRequestSummaries({
      items: Array.from({ length: 16 }, (_, index) => summary(index + 1)),
      hiddenCount: 2,
    });
    render(<EnvironmentThreadPullRequests summaries={many} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByText(/more not shown/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show more (6)" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(16);
    expect(screen.getByText("2 more not shown")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("offers each pull request's one next step: Resolve before Fix, Merge only when ready, none once merged", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onOpenExternal = vi.fn();
    render(
      <EnvironmentThreadPullRequests
        onOpen={onOpen}
        onOpenExternal={onOpenExternal}
        summaries={summaries([
          summary(1, { checks: "failing", mergeability: "conflicting" }),
          summary(2, { checks: "failing" }),
          summary(3, {
            checks: "passing",
            review: "approved",
            mergeability: "mergeable",
            readyToMerge: true,
          }),
        ])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Resolve pull request #1 on GitHub" }));
    expect(onOpenExternal).toHaveBeenCalledWith("https://github.com/acme/repo/pull/1/conflicts");
    expect(screen.queryByRole("button", { name: "Fix pull request #1 on GitHub" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Fix pull request #2 on GitHub" }));
    expect(onOpenExternal).toHaveBeenLastCalledWith("https://github.com/acme/repo/pull/2/checks");

    await user.click(screen.getByRole("button", { name: "Merge pull request #3" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ number: 3 }));

    render(
      <EnvironmentThreadPullRequests
        onOpen={onOpen}
        onOpenExternal={onOpenExternal}
        summaries={summaries([summary(4, { state: "merged", checks: "failing" })])}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /pull request #4 on GitHub$|Merge pull request #4/ }),
    ).toBeNull();
  });

  it("says each layer's place in its stack and joins only layers that are really based on each other", () => {
    render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        summaries={summaries([
          summary(1, { stack: { position: 1, size: 4 } }),
          summary(2, { stack: { position: 2, size: 4, parent: 1 } }),
          // The thread never touched layer three.
          summary(4, { stack: { position: 4, size: 4, parent: 3 } }),
        ])}
      />,
    );
    expect(screen.getByText("2 of 4")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Pull request 2, Change 2, open, layer 2 of 4 of a stack, on #1",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Pull request 1, Change 1, open, layer 1 of 4 of a stack, the bottom",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("listitem").map((item) => item.getAttribute("data-stack-join")),
    ).toEqual(["next", "previous", null]);
  });

  it("offers Merge on a stack's bottom layer alone, and Fix on any of them", () => {
    const ready = {
      checks: "passing",
      review: "approved",
      mergeability: "mergeable",
      readyToMerge: true,
    };
    render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        onOpenExternal={vi.fn()}
        summaries={summaries([
          summary(1, { ...ready, stack: { position: 1, size: 3 } }),
          summary(2, { ...ready, stack: { position: 2, size: 3, parent: 1 } }),
          summary(3, { checks: "failing", stack: { position: 3, size: 3, parent: 2 } }),
        ])}
      />,
    );
    expect(screen.getByRole("button", { name: "Merge pull request #1" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Merge pull request #2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fix pull request #3 on GitHub" })).toBeVisible();
  });

  it("offers no Merge for a pull request already in the merge queue", () => {
    render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        onOpenExternal={vi.fn()}
        summaries={summaries([
          summary(5, {
            checks: "passing",
            review: "approved",
            mergeability: "mergeable",
            readyToMerge: true,
            merging: "queued",
          }),
        ])}
      />,
    );
    expect(screen.queryByRole("button", { name: "Merge pull request #5" })).toBeNull();
  });

  it("keeps the row and its menu as sibling controls, never a button inside a button", () => {
    const { container } = render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        onOpenOnGithub={vi.fn()}
        summaries={summaries([summary(1), summary(2)])}
      />,
    );
    expect(container.querySelectorAll("button button")).toHaveLength(0);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getAllByRole("button")).toHaveLength(2);
  });

  it("shows added and removed lines after the state, and none when the host has not read them", () => {
    render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        summaries={summaries([
          summary(1, { additions: 2173, deletions: 296 }),
          summary(2, { additions: 0, deletions: 0, state: "merged" }),
          summary(3),
        ])}
      />,
    );
    expect(meta("repo #1 \u00b7 Open +2,173 \u2212296")).toBeVisible();
    expect(meta("repo #2 \u00b7 Merged +0 \u22120")).toBeVisible();
    // Absent is not zero: nothing is drawn.
    expect(meta("repo #3 \u00b7 Open")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Pull request 1, Change 1, open, 2,173 lines added, 296 removed",
      }),
    ).toBeVisible();
  });

  it("shows passed out of counted only while checks have not all passed", () => {
    const { container } = render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        summaries={summaries([
          summary(1, { checks: "pending", checkCounts: { passed: 19, total: 26 } }),
          summary(2, { checks: "passing", checkCounts: { passed: 26, total: 26 } }),
          summary(3, { state: "merged", checks: "failing", checkCounts: { passed: 1, total: 2 } }),
        ])}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("19/26")).toBeInTheDocument();
    expect(container.querySelectorAll(".environment-thread-pr__check-count")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Pull request 1, Change 1, open, checks pending, checks 19 of 26 passed",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Pull request 2, Change 2, open, checks passing" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Pull request 3, Change 3, merged" })).toBeVisible();
  });

  it("says Merging or Merges when ready instead of Open, in the row and its name", () => {
    render(
      <EnvironmentThreadPullRequests
        onOpen={vi.fn()}
        summaries={summaries([
          summary(1, { merging: "queued" }),
          summary(2, { merging: "auto-merge" }),
          summary(3, { state: "merged", merging: "queued" }),
        ])}
      />,
    );
    expect(meta("repo #1 \u00b7 Merging")).toBeVisible();
    expect(meta("repo #2 \u00b7 Merges when ready")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pull request 1, Change 1, merging" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Pull request 2, Change 2, merges when ready" }),
    ).toBeVisible();
    // A merged pull request is no longer on its way in.
    expect(meta("repo #3 \u00b7 Merged")).toBeVisible();
  });

  it("marks a queued pull request with the merge glyph in the pending tone and leaves auto-merge as open", () => {
    const { container } = render(
      <EnvironmentThreadPullRequests
        summaries={summaries([
          summary(1, { merging: "queued" }),
          summary(2, { merging: "auto-merge" }),
        ])}
      />,
    );
    const marks = container.querySelectorAll(".environment-thread-pr__state");
    expect(marks[0]?.getAttribute("data-pr-state")).toBe("queued");
    expect(marks[1]?.getAttribute("data-pr-state")).toBe("open");
  });

  it("says one line added, not one lines", () => {
    render(
      <EnvironmentThreadPullRequests
        onOpen={() => undefined}
        summaries={summaries([summary(1, { additions: 1, deletions: 0 })])}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Pull request 1, .*, 1 line added, 0 removed/ }),
    ).toBeVisible();
  });

  it("keeps one width at the end of every open row whether or not it holds a count or a dot, and none on a merged one", () => {
    const { container } = render(
      <EnvironmentThreadPullRequests
        summaries={summaries([
          summary(1, { checks: "failing", checkCounts: { passed: 3, total: 9 } }),
          summary(2, { checks: "passing" }),
          summary(3, { state: "merged" }),
        ])}
      />,
    );
    const ends = container.querySelectorAll(".environment-thread-pr__checks-end");
    expect(ends).toHaveLength(3);
    // The width is one CSS rule keyed on this mark: the two open rows carry
    // it, with a count and with a dot alone, so a count arriving moves nothing.
    expect([...ends].map((end) => end.getAttribute("data-reserved"))).toEqual([
      "true",
      "true",
      null,
    ]);
  });
});
