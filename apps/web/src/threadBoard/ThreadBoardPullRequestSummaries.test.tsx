import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadBoardPullRequestSummaries } from "./ThreadBoardPullRequestSummaries";

describe("ThreadBoardPullRequestSummaries", () => {
  it("renders bounded pull-request summaries and overflow", () => {
    render(
      <ThreadBoardPullRequestSummaries
        summaries={{
          items: [
            {
              identity: {
                projectId: "10000000-0000-4000-8000-000000000001",
                repositoryOwner: "octant",
                repositoryName: "octant",
                number: 12,
              },
              title: "Board pull request",
              state: "open",
              checks: "passing",
              review: "approved",
              freshness: "fresh",
              readyToMerge: true,
            },
          ],
          hiddenCount: 2,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /Board pull request/i })).toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
    expect(screen.getByText(/Ready to merge/i)).toBeInTheDocument();
  });

  it("selects a pull request through the board identity path", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ThreadBoardPullRequestSummaries
        onSelect={onSelect}
        summaries={{
          items: [
            {
              identity: {
                projectId: "10000000-0000-4000-8000-000000000001",
                repositoryOwner: "octant",
                repositoryName: "octant",
                number: 12,
              },
              title: "Board pull request",
              state: "open",
              checks: "passing",
              review: "approved",
              freshness: "fresh",
              readyToMerge: true,
              relationship: "promoted",
            },
          ],
          hiddenCount: 0,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Board pull request/i }));
    expect(onSelect).toHaveBeenCalledWith({
      projectId: "10000000-0000-4000-8000-000000000001",
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 12,
    });
  });
});
