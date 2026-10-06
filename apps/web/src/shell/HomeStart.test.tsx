import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeStart, type HomeAction } from "./HomeStart";

function action(id: HomeAction["id"], title: string, onSelect: () => void): HomeAction {
  return { id, title, detail: `${title} detail`, onSelect };
}

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

  it("draws nothing when there are no actions and no dashboard", () => {
    const { container } = render(<HomeStart actions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the start screen card area", () => {
  it("places the dashboard under the tiles", () => {
    render(
      <HomeStart
        actions={[action("review", "Review 2 changes", vi.fn())]}
        dashboard={<div data-testid="dashboard" />}
      />,
    );
    const tiles = screen.getByRole("group", { name: "Quick actions" });
    const dashboard = screen.getByTestId("dashboard");
    expect(
      tiles.compareDocumentPosition(dashboard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the dashboard alone when no tile has a way to run", () => {
    render(<HomeStart actions={[]} dashboard={<div data-testid="dashboard" />} />);
    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Quick actions" })).toBeNull();
  });
});
