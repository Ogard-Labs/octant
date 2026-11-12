import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockTiles, type DockTileContent } from "./DockTiles";
import { useDockBarControls } from "./dockBarControls";
import type { DockTileLayout } from "./rightUtilityDockSelection";

function Tool(props: { readonly onRefresh: () => void; readonly alone?: boolean }) {
  const [view, setView] = useState("a");
  const hosted = useDockBarControls([
    {
      kind: "button",
      id: "refresh",
      label: "Refresh things",
      icon: RefreshCw,
      onSelect: props.onRefresh,
    },
    {
      kind: "choice",
      id: "view",
      label: "Things view",
      options: [
        { id: "a", label: "View A", icon: RefreshCw },
        { id: "b", label: "View B", icon: RefreshCw },
      ],
      value: view,
      onChange: setView,
    },
  ]);
  return <p>{hosted ? `hosted, view ${view}` : "not hosted"}</p>;
}

function Plain() {
  return <p>no controls</p>;
}

function content(tabId: string, child: React.ReactNode): DockTileContent {
  return {
    key: tabId,
    label: tabId,
    surface: "files",
    barLeading: <span className="dock-tile__name">{tabId}</span>,
    moves: { left: false, right: false, up: false, down: false },
    bodyClassName: "right-utility-dock__tool",
    inset: false,
    children: child,
  };
}

function Dock(props: { readonly layout: DockTileLayout; readonly onRefresh: () => void }) {
  return (
    <DockTiles
      focusedTabId="one"
      layout={props.layout}
      onCloseTile={() => {}}
      onFocusTile={() => {}}
      onHideTile={() => {}}
      onMoveTile={() => {}}
      onResizeColumn={() => {}}
      onResizeColumns={() => {}}
      onShowTileAlone={() => {}}
      renderTile={(tabId) =>
        content(tabId, tabId === "one" ? <Tool onRefresh={props.onRefresh} /> : <Plain />)
      }
    />
  );
}

const two: DockTileLayout = {
  columns: [
    { share: 0.5, tiles: [{ tabId: "one", share: 1 }] },
    { share: 0.5, tiles: [{ tabId: "two", share: 1 }] },
  ],
};
const alone: DockTileLayout = { columns: [{ share: 1, tiles: [{ tabId: "one", share: 1 }] }] };
const aloneWithoutControls: DockTileLayout = {
  columns: [{ share: 1, tiles: [{ tabId: "two", share: 1 }] }],
};

afterEach(() => vi.restoreAllMocks());

describe("a tool's controls in its tile's bar", () => {
  it("stands the tool's controls between its name and the tile's Arrange and Close, in that order", () => {
    render(<Dock layout={two} onRefresh={() => {}} />);
    const region = screen.getByRole("region", { name: "one" });
    const names = within(region)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Refresh things", "View A", "View B", "Arrange one", "Close one"]);
    expect(region.querySelectorAll(".dock-tile__bar")).toHaveLength(1);
  });

  it("names every icon-only control and keeps the pressed view in aria-pressed", async () => {
    render(<Dock layout={two} onRefresh={() => {}} />);
    const first = screen.getByRole("button", { name: "View A" });
    const second = screen.getByRole("button", { name: "View B" });
    expect(screen.getByRole("button", { name: "Refresh things" })).toHaveAttribute(
      "title",
      "Refresh things",
    );
    expect(first).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(second);
    expect(screen.getByText("hosted, view b")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View B" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does what the control did when it stood in the tool's own header", async () => {
    const onRefresh = vi.fn();
    render(<Dock layout={two} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh things" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("gives a tool alone a bar for its controls, with no Arrange or Close", () => {
    render(<Dock layout={alone} onRefresh={() => {}} />);
    expect(document.querySelectorAll(".dock-tile__bar")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Refresh things" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Arrange one" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close one" })).toBeNull();
  });

  it("leaves a tool alone that hands up no controls with no bar, as before", () => {
    render(<Dock layout={aloneWithoutControls} onRefresh={() => {}} />);
    expect(document.querySelector(".dock-tile__bar")).toBeNull();
  });

  it("folds the controls into one menu, keeping each reachable, when the bar cannot hold them", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
    const onRefresh = vi.fn();
    render(<Dock layout={two} onRefresh={onRefresh} />);
    expect(screen.queryByRole("button", { name: "Refresh things" })).toBeNull();
    const more = screen.getByRole("button", { name: "More one actions" });
    await act(async () => {
      await userEvent.click(more);
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Refresh things" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "More one actions" }));
    });
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "View B" }));
    expect(screen.getByText("hosted, view b")).toBeInTheDocument();
  });

  it("keeps the controls in the bar when the bar is wide enough", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    render(<Dock layout={two} onRefresh={() => {}} />);
    expect(screen.getByRole("button", { name: "Refresh things" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More one actions" })).toBeNull();
  });
});
