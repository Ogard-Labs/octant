import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeStart, type HomeAction } from "./HomeStart";
import type { RunningNowCard } from "./runningNow";

function action(id: HomeAction["id"], title: string, onSelect: () => void): HomeAction {
  return { id, title, detail: `${title} detail`, onSelect };
}

const runningCard: RunningNowCard = {
  threadId: "thread-1",
  projectId: "project-1",
  title: "Wire the board",
  projectName: "octant",
  branch: "feature/board",
  provider: { displayName: "Claude", driverKind: "claude" },
  latestActivity: "Reading apps/web/src/App.tsx",
  activeAt: new Date(Date.now() - 4 * 60_000).toISOString(),
};

describe("the start screen action tiles", () => {
  it("runs the action each tile names when it is chosen", async () => {
    const user = userEvent.setup();
    const addFolder = vi.fn();
    const openTerminal = vi.fn();
    const review = vi.fn();
    render(
      <HomeStart
        actions={[
          action("add-folder", "Add a folder", addFolder),
          action("open-terminal", "Open terminal", openTerminal),
          action("review", "Review 3 changes", review),
        ]}
        running={[]}
      />,
    );

    const tiles = within(screen.getByRole("group", { name: "Quick actions" }));
    await user.click(tiles.getByRole("button", { name: /Open terminal/ }));
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(addFolder).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();

    await user.click(tiles.getByRole("button", { name: /Review 3 changes/ }));
    await user.click(tiles.getByRole("button", { name: /Add a folder/ }));
    expect(review).toHaveBeenCalledTimes(1);
    expect(addFolder).toHaveBeenCalledTimes(1);
  });

  it("draws nothing when there are no actions and nothing is running", () => {
    const { container } = render(<HomeStart actions={[]} running={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Running now", () => {
  it("lists the running threads with where they work and opens the one chosen", async () => {
    const user = userEvent.setup();
    const onOpenRunning = vi.fn();
    const onOpenBoard = vi.fn();
    render(
      <HomeStart
        actions={[]}
        onOpenBoard={onOpenBoard}
        onOpenRunning={onOpenRunning}
        running={[runningCard, { threadId: "thread-2", title: "Fix the flaky test" }]}
      />,
    );

    const section = within(screen.getByRole("region", { name: "Running now" }));
    expect(section.getAllByRole("listitem")).toHaveLength(2);
    expect(section.getByText("octant")).toBeInTheDocument();
    expect(section.getByText("feature/board")).toBeInTheDocument();
    expect(section.getByText("Reading apps/web/src/App.tsx")).toBeInTheDocument();
    expect(section.getByText("Active 4m ago")).toBeInTheDocument();

    await user.click(section.getByRole("button", { name: /Wire the board/ }));
    expect(onOpenRunning).toHaveBeenCalledWith(runningCard);

    await user.click(section.getByRole("button", { name: "Open board" }));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
  });

  it("states only what the host reported for a thread", () => {
    render(
      <HomeStart
        actions={[]}
        onOpenRunning={vi.fn()}
        running={[{ threadId: "thread-2", title: "Fix the flaky test" }]}
      />,
    );

    const card = screen.getByRole("button", { name: /Fix the flaky test/ });
    expect(card).not.toHaveTextContent("Active");
    expect(card.querySelector(".running-card__chips")).toBeNull();
    expect(card.querySelector(".running-card__well")).toBeNull();
  });
});
