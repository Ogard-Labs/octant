import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefreshCw } from "lucide-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ReactNode } from "react";
import { DockBarTestHost } from "./dockBarHost.test-support";
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

let textWidth = 0;

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
      return ruler.startsWith("full:")
        ? 150
        : ruler.startsWith("named:")
          ? 90
          : ruler.startsWith("text:")
            ? textWidth
            : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("dock-tile__name") ? 40 : 0;
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  textWidth = 0;
});

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
    expect(within(region).getAllByText("3 things").length).toBeGreaterThan(0);
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

function Registrant(props: {
  readonly id: string;
  readonly label: string;
  readonly onSelect?: () => void;
}) {
  useDockBarControls([
    {
      kind: "button",
      id: props.id,
      label: props.label,
      icon: RefreshCw,
      onSelect: props.onSelect ?? (() => {}),
    },
  ]);
  return null;
}

describe("the slot a host keeps", () => {
  it("draws each registrant's controls in the order they registered and clears only an unmounted one's own", () => {
    function Two(props: { readonly second: boolean }) {
      return (
        <DockBarTestHost placement="tiled">
          <Registrant id="a" label="Refresh a" />
          {props.second ? <Registrant id="b" label="Refresh b" /> : null}
        </DockBarTestHost>
      );
    }
    const { rerender } = render(<Two second />);
    const labels = () =>
      within(screen.getByTestId("bar"))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
    expect(labels()).toEqual(["Refresh a", "Refresh b"]);
    rerender(<Two second={false} />);
    expect(labels()).toEqual(["Refresh a"]);
  });

  it("redraws a control when its tool registers it again with a new name, and clears it on unmount", () => {
    const { rerender } = render(
      <DockBarTestHost placement="alone">
        <Registrant id="a" label="Refresh a" />
      </DockBarTestHost>,
    );
    rerender(
      <DockBarTestHost placement="alone">
        <Registrant id="a" label="Refresh again" />
      </DockBarTestHost>,
    );
    expect(screen.getByRole("button", { name: "Refresh again" })).toBeInTheDocument();
    rerender(<DockBarTestHost placement="alone">{null}</DockBarTestHost>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("refuses a second registrant's control with an id already taken and says so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    render(
      <DockBarTestHost placement="tiled">
        <Registrant id="clash" label="Refresh first" onSelect={first} />
        <Registrant id="clash" label="Refresh second" onSelect={second} />
      </DockBarTestHost>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Refresh first" }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"clash"'));
  });
});

describe("a bar that holds status text and a tool's name", () => {
  const textTool = (
    <DockTiles
      focusedTabId="one"
      layout={two}
      onCloseTile={() => {}}
      onFocusTile={() => {}}
      onHideTile={() => {}}
      onMoveTile={() => {}}
      onResizeColumn={() => {}}
      onResizeColumns={() => {}}
      onShowTileAlone={() => {}}
      renderTile={(tabId) => content(tabId, tabId === "one" ? <StatusTool /> : <Plain />)}
    />
  );

  function StatusTool() {
    useDockBarControls([
      { kind: "text", id: "state", text: "iOS 27 · Running", live: true, dot: "running" },
      { kind: "button", id: "back", label: "Back", icon: RefreshCw, onSelect: () => {} },
      { kind: "button", id: "home", label: "Home", icon: RefreshCw, onSelect: () => {} },
      { kind: "button", id: "shot", label: "Screenshot", icon: RefreshCw, onSelect: () => {} },
    ]);
    return null;
  }

  it("folds the actions into More before the status text is cut, and keeps the name whole", () => {
    textWidth = 120;
    barOfWidth(300);
    render(textTool);
    expect(screen.getByRole("button", { name: "More one actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    const text = screen
      .getAllByText("iOS 27 · Running")
      .find((element) => element.closest("[inert]") === null);
    if (text === undefined) throw new Error("The status text is not drawn.");
    expect(text).toBeVisible();
    // Counted at its measured width: the bar's room (300 less insets, the name
    // and Arrange and Close) holds it and the one More button.
    expect(120 + 4 + 28).toBeLessThanOrEqual(300 - 20 - (14 + 4 + 40) - 60);
    expect(screen.getByText("one", { selector: ".dock-tile__name" })).toBeInTheDocument();
  });

  it("keeps the actions as icons while the bar holds them all beside the status text", () => {
    textWidth = 120;
    barOfWidth(420);
    render(textTool);
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More one actions" })).toBeNull();
  });
});

describe("a bar's measurement", () => {
  it("measures again when the words' widths change and the bar's does not", () => {
    const callbacks: ResizeObserverCallback[] = [];
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    barOfWidth(400);
    render(<Dock layout={two} />);
    expect(screen.getByRole("group", { name: "Things view" })).toBeInTheDocument();
    expect(observed.some((element) => (element as HTMLElement).dataset.ruler !== undefined)).toBe(
      true,
    );
    // The interface size grew: the same words now need 300px, the bar the same.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        const ruler = this.dataset.ruler ?? "";
        return ruler.startsWith("full:") ? 300 : ruler.startsWith("named:") ? 90 : 0;
      },
    );
    act(() => {
      for (const callback of callbacks) callback([], {} as ResizeObserver);
    });
    expect(screen.queryByRole("group", { name: "Things view" })).toBeNull();
    expect(screen.getByRole("button", { name: "View A, Things view" })).toBeInTheDocument();
  });
});

describe("a bar's toolbar", () => {
  it("names the tool's controls as one toolbar and moves along them with the arrow keys", async () => {
    render(<Dock layout={two} />);
    const toolbar = screen.getByRole("toolbar", { name: "one controls" });
    const buttons = within(toolbar).getAllByRole("button");
    buttons[0]?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(buttons.at(-1)).toHaveFocus();
  });

  it("labels the alone row's controls the same way", () => {
    render(<Dock layout={alone} />);
    expect(screen.getByRole("toolbar", { name: "one controls" })).toBeInTheDocument();
  });
});

describe("a tile that changes between tiled and alone", () => {
  it("keeps the tool mounted, with what was typed in it and its focus", async () => {
    function Draft() {
      useDockBarControls([
        { kind: "button", id: "r", label: "Refresh draft", icon: RefreshCw, onSelect: () => {} },
      ]);
      return <input aria-label="Draft" />;
    }
    const layoutOf = (layout: DockTileLayout) => (
      <DockTiles
        focusedTabId="one"
        layout={layout}
        onCloseTile={() => {}}
        onFocusTile={() => {}}
        onHideTile={() => {}}
        onMoveTile={() => {}}
        onResizeColumn={() => {}}
        onResizeColumns={() => {}}
        onShowTileAlone={() => {}}
        renderTile={(tabId) => content(tabId, tabId === "one" ? <Draft /> : <Plain />)}
      />
    );
    const { rerender } = render(layoutOf(two));
    const input = screen.getByLabelText("Draft");
    await userEvent.type(input, "keep me");
    rerender(layoutOf(alone));
    expect(screen.getByLabelText("Draft")).toBe(input);
    expect(input).toHaveValue("keep me");
    expect(input).toHaveFocus();
    expect(document.querySelector(".dock-tile__bar")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh draft" })).toBeInTheDocument();
    rerender(layoutOf(two));
    expect(screen.getByLabelText("Draft")).toBe(input);
    expect(input).toHaveValue("keep me");
  });
});

describe("controls a tool draws itself", () => {
  it("moves under the bar as the one secondary row when the bar cannot hold them, and stays in the bar when it can", () => {
    function Drawn() {
      useDockBarControls([
        { kind: "node", id: "own", width: 232, node: <button type="button">Versions</button> },
      ]);
      return null;
    }
    const dock = (
      <DockTiles
        focusedTabId="one"
        layout={two}
        onCloseTile={() => {}}
        onFocusTile={() => {}}
        onHideTile={() => {}}
        onMoveTile={() => {}}
        onResizeColumn={() => {}}
        onResizeColumns={() => {}}
        onShowTileAlone={() => {}}
        renderTile={(tabId) => content(tabId, tabId === "one" ? <Drawn /> : <Plain />)}
      />
    );
    barOfWidth(500);
    const { unmount } = render(dock);
    expect(document.querySelector(".dock-tile__bar .dock-tile__tool-node")).not.toBeNull();
    expect(document.querySelector(".dock-tile__row--nodes")).toBeNull();
    unmount();
    vi.restoreAllMocks();
    barOfWidth(280);
    render(dock);
    expect(document.querySelector(".dock-tile__bar .dock-tile__tool-node")).toBeNull();
    const row = document.querySelector(".dock-tile__row--nodes");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByRole("button", { name: "Versions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Arrange one" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close one" })).toBeInTheDocument();
  });
});
