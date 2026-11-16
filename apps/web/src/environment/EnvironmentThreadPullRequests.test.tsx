import {
  decodeProjectId,
  decodeThreadBoardPullRequestSummaries,
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
    expect(screen.getByText("repo #1 · Open")).toBeVisible();
    expect(screen.getByText("repo #2 · Draft")).toBeVisible();
    expect(screen.getByText("repo #3 · Merged")).toBeVisible();
    rerender(
      <EnvironmentThreadPullRequests
        summaries={summaries([summary(4, { state: "closed" }), summary(5, { state: "unknown" })])}
      />,
    );
    expect(screen.getByText("repo #4 · Closed")).toBeVisible();
    expect(screen.getByText("repo #5")).toBeVisible();
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
    expect(screen.getByText("repo #1 · Open · Ready to merge")).toBeVisible();
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
    expect(screen.getByText("repo #5 · Open · Stale snapshot")).toBeVisible();
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
});
