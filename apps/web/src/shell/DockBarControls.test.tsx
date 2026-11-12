import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefreshCw } from "lucide-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockTiles, type DockTileContent } from "./DockTiles";
import { BottomUtilityPanel } from "./BottomUtilityPanel";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { useDockBarControls, useDockBarPlacement, type DockBarItem } from "./dockBarControls";
import type { DockTileLayout } from "./rightUtilityDockSelection";

const dockStylesheet = readFileSync(resolve(import.meta.dirname, "../styles/dock.css"), "utf8");
const rule = (selector: string) =>
  dockStylesheet.match(
    new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
  )?.[1] ?? "";

function Tool(props: { readonly onRefresh: () => void }) {
  const [view, setView] = useState("a");
  const items: DockBarItem[] = [
    {
      kind: "choice",
      id: "view",
      label: "Things view",
      options: [
        { id: "a", label: "View A" },
        { id: "b", label: "View B" },
      ],
      value: view,
      onChange: setView,
    },
    { kind: "text", id: "count", text: "3 things" },
    {
      kind: "button",
      id: "refresh",
      label: "Refresh things",
      icon: RefreshCw,
      onSelect: props.onRefresh,
    },
    {
      kind: "menu",
      id: "more",
      label: "Thing actions",
      icon: RefreshCw,
      items: [{ id: "x", label: "Export things" }],
      onSelect: () => {},
    },
  ];
  const placement = useDockBarControls(items);
  return <p>{`${placement ?? "none"}, view ${view}`}</p>;
}

function Plain() {
  const placement = useDockBarPlacement();
  return <p>{`plain ${placement ?? "none"}`}</p>;
}

function content(tabId: string, child: ReactNode): DockTileContent {
  return {
    key: tabId,
    label: tabId,
    surface: "files",
    barLeading: (
      <>
        <svg aria-hidden="true" />
        <span className="dock-tile__name">{tabId}</span>
      </>
    ),
    moves: { left: false, right: false, up: false, down: false },
    bodyClassName: "right-utility-dock__tool",
    inset: false,
    children: child,
  };
}

function Dock(props: { readonly layout: DockTileLayout; readonly onRefresh?: () => void }) {
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
        content(
          tabId,
          tabId === "one" ? <Tool onRefresh={props.onRefresh ?? (() => {})} /> : <Plain />,
        )
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

/** A bar `width` wide whose switch needs 150px in words and 90px named, beside a 40px name. */
function barOfWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("dock-tile__bar") || this.classList.contains("dock-tile__row")
        ? width
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      const ruler = this.dataset.ruler ?? "";
      return ruler.startsWith("full:") ? 150 : ruler.startsWith("named:") ? 90 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("dock-tile__name") ? 40 : 0;
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("a tool's controls in its tile's bar", () => {
  it("stands the tool's words and status, then its actions, between its name and Arrange and Close, in that order", () => {
    render(<Dock layout={two} />);
    const region = screen.getByRole("region", { name: "one" });
    const names = within(region)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names).toEqual([
      "View A",
      "View B",
      "Refresh things",
      "Thing actions",
      "Arrange one",
      "Close one",
    ]);
    expect(within(region).getByText("3 things")).toBeInTheDocument();
    expect(region.querySelectorAll(".dock-tile__bar")).toHaveLength(1);
    expect(screen.getByText("tiled, view a")).toBeInTheDocument();
  });

  it("draws the views as words in a group, marks the pressed one and switches on a press", async () => {
    render(<Dock layout={two} />);
    const group = screen.getByRole("group", { name: "Things view" });
    expect(within(group).getByRole("button", { name: "View A" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(group).getByRole("button", { name: "View B" }));
    expect(screen.getByText("tiled, view b")).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "View B" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("gives every icon-only action an accessible name and a tooltip, and does what the control did", async () => {
    const onRefresh = vi.fn();
    render(<Dock layout={two} onRefresh={onRefresh} />);
    const refresh = screen.getByRole("button", { name: "Refresh things" });
    expect(refresh).toHaveAttribute("title", "Refresh things");
    await userEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("opens a menu action from its icon button", async () => {
    render(<Dock layout={two} />);
    await userEvent.click(screen.getByRole("button", { name: "Thing actions" }));
    expect(await screen.findByRole("menuitem", { name: "Export things" })).toBeInTheDocument();
  });

  it("keeps everything in the bar when the bar is wide enough", () => {
    barOfWidth(600);
    render(<Dock layout={two} />);
    expect(screen.getByRole("group", { name: "Things view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh things" })).toBeInTheDocument();
  });

  it("folds the words into one control naming the current view first, keeping the actions", async () => {
    barOfWidth(300);
    render(<Dock layout={two} />);
    expect(screen.queryByRole("group", { name: "Things view" })).toBeNull();
    const named = screen.getByRole("button", { name: "View A, Things view" });
    expect(named).toHaveTextContent("View A");
    expect(screen.getByRole("button", { name: "Refresh things" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More one actions" })).toBeNull();
    await userEvent.click(named);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "View B" }));
    expect(screen.getByText("tiled, view b")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View B, Things view" })).toHaveTextContent("View B");
  });

  it("folds the actions into one menu only after the words have folded, and returns focus to the trigger", async () => {
    barOfWidth(260);
    const onRefresh = vi.fn();
    render(<Dock layout={two} onRefresh={onRefresh} />);
    expect(screen.getByRole("button", { name: "View A, Things view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh things" })).toBeNull();
    const more = screen.getByRole("button", { name: "More one actions" });
    await act(async () => {
      await userEvent.click(more);
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Refresh things" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "More one actions" })).toHaveFocus(),
    );
  });

  it("cuts nothing of the name while the controls can still fold", () => {
    barOfWidth(256);
    render(<Dock layout={two} />);
    expect(screen.getByRole("button", { name: "More one actions" })).toBeInTheDocument();
    expect(screen.getByText("one", { selector: ".dock-tile__name" })).toBeInTheDocument();
  });
});

describe("a tool shown alone", () => {
  it("draws no tile bar and one slim row holding only the tool's controls", () => {
    render(<Dock layout={alone} />);
    expect(document.querySelector(".dock-tile__bar")).toBeNull();
    const rows = document.querySelectorAll(".dock-tile__row");
    expect(rows).toHaveLength(1);
    expect(screen.getByText("alone, view a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Arrange one" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close one" })).toBeNull();
    expect(within(rows[0] as HTMLElement).queryByText("one")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh things" })).toBeInTheDocument();
  });

  it("draws no row at all for a tool that hands up no controls", () => {
    render(<Dock layout={aloneWithoutControls} />);
    expect(document.querySelector(".dock-tile__bar")).toBeNull();
    expect(document.querySelector(".dock-tile__row")).toBeNull();
    expect(screen.getByText("plain alone")).toBeInTheDocument();
  });

  it("folds the row's controls by the same steps as a bar's", () => {
    barOfWidth(200);
    render(<Dock layout={alone} />);
    expect(screen.getByRole("button", { name: "View A, Things view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh things" })).toBeInTheDocument();
  });
});

describe("a tool in the bottom panel", () => {
  it("shows its controls in the panel's bar between the tabs and Hide", () => {
    const review = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === "review");
    if (review === undefined) throw new Error("Missing review surface.");
    render(
      <BottomUtilityPanel
        activeSurface={review}
        content={<Tool onRefresh={() => {}} />}
        height={260}
        launchableSurfaces={[]}
        onClose={() => {}}
        onCommitHeight={() => {}}
        onOpenTool={() => {}}
        onPreviewHeight={() => {}}
        tabs={[review]}
      />,
    );
    const toolbar = document.querySelector(".bottom-utility-panel__toolbar") as HTMLElement;
    expect(within(toolbar).getByRole("group", { name: "Things view" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Refresh things" })).toBeInTheDocument();
    expect(screen.getByText("bottom, view a")).toBeInTheDocument();
    const labels = within(toolbar)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(labels.at(-1)).toBe("Hide bottom panel");
  });
});

describe("the bar's sizes", () => {
  it("holds the bar and the single row to 32px on the bar's insets, with 4px between controls", () => {
    for (const selector of [".dock-tile__bar", ".dock-tile__row"]) {
      expect(rule(selector)).toMatch(/height:\s*32px/);
    }
    expect(rule(".dock-tile__bar")).toMatch(
      /padding:\s*0 var\(--oct-space-2\) 0 var\(--oct-space-3\)/,
    );
    expect(rule(".dock-tile__row")).toMatch(
      /padding:\s*0 var\(--oct-space-2\) 0 var\(--oct-space-3\)/,
    );
    expect(rule(".dock-tile__tool-actions")).toMatch(/gap:\s*var\(--oct-space-1\)/);
  });

  it("draws every bar control at 24px with a 14px glyph and the word switch as a 28px tray of 24px segments", () => {
    expect(rule(".dock-tile__control")).toMatch(/width:\s*24px/);
    expect(rule(".dock-tile__control")).toMatch(/height:\s*24px/);
    expect(rule(".dock-tile__control > svg")).toMatch(/width:\s*var\(--oct-icon-sm\)/);
    expect(rule(".dock-bar-switch")).toMatch(/height:\s*28px/);
    expect(rule(".dock-bar-switch__option")).toMatch(/height:\s*24px/);
  });
});
