import { describe, expect, it } from "vitest";
import {
  browserPageToShow,
  buildDockToolButtons,
  type DockToolButtonsInput,
} from "./dockToolButtonsModel";

const tool = (id: DockToolButtonsInput["surfaces"][number]["id"]) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
});

function input(overrides: Partial<DockToolButtonsInput> = {}): DockToolButtonsInput {
  return {
    surfaces: [
      tool("environment"),
      tool("files"),
      tool("browser"),
      tool("review"),
      tool("terminal"),
      tool("plan"),
      tool("tests"),
    ],
    tabs: [],
    shownTabIds: [],
    dockOpen: true,
    dockPresentedOpen: true,
    bottomHeld: [],
    bottomPresentedOpen: false,
    capsFull: false,
    ...overrides,
  };
}

const byId = (model: ReturnType<typeof buildDockToolButtons>, id: string) =>
  [...model.buttons, ...model.more].find((button) => button.id === id);

describe("the title band's tool buttons", () => {
  it("lists the dedicated tools in band order and leaves the rest to More", () => {
    const model = buildDockToolButtons(input());
    expect(model.buttons.map((button) => button.id)).toEqual([
      "environment",
      "terminal",
      "review",
      "browser",
      "files",
    ]);
    expect(model.more.map((button) => button.id)).toEqual(["plan", "tests"]);
  });

  it("leaves out a tool the thread cannot use", () => {
    const model = buildDockToolButtons(
      input({ surfaces: [tool("environment"), tool("files"), tool("side-chat")] }),
    );
    expect(model.buttons.map((button) => button.id)).toEqual(["environment", "files"]);
    expect(model.more.map((button) => button.id)).toEqual(["side-chat"]);
  });

  it("offers nothing when no tool is available", () => {
    expect(buildDockToolButtons(input({ surfaces: [] }))).toEqual({ buttons: [], more: [] });
  });

  it("opens an unopened tool beside the focused tile", () => {
    const files = byId(buildDockToolButtons(input()), "files");
    expect(files).toMatchObject({ pressed: false, open: false, press: { kind: "open-beside" } });
  });

  it("reads a shown tool in an open dock as pressed and closes it on a press", () => {
    const model = buildDockToolButtons(
      input({ tabs: [{ id: "files", surface: "files" }], shownTabIds: ["files"] }),
    );
    expect(byId(model, "files")).toMatchObject({
      pressed: true,
      press: { kind: "close", tabIds: ["files"] },
    });
  });

  it("brings a closed dock back instead of closing a tool it still shows", () => {
    const model = buildDockToolButtons(
      input({
        tabs: [{ id: "files", surface: "files" }],
        shownTabIds: ["files"],
        dockOpen: false,
        dockPresentedOpen: false,
      }),
    );
    expect(byId(model, "files")).toMatchObject({ pressed: false, press: { kind: "open-dock" } });
  });

  it("marks a tool that is open but not on screen and shows it beside the focused tile", () => {
    const model = buildDockToolButtons(
      input({
        tabs: [
          { id: "environment", surface: "environment" },
          { id: "files", surface: "files" },
        ],
        shownTabIds: ["environment"],
      }),
    );
    expect(byId(model, "files")).toMatchObject({
      pressed: false,
      open: true,
      press: { kind: "show-beside", tabId: "files" },
    });
  });

  it("closes every Browser page on a press but only one shell", () => {
    const model = buildDockToolButtons(
      input({
        tabs: [
          { id: "b1", surface: "browser" },
          { id: "b2", surface: "browser" },
          { id: "t1", surface: "terminal" },
          { id: "t2", surface: "terminal" },
        ],
        shownTabIds: ["b2", "t1", "t2"],
      }),
    );
    expect(byId(model, "browser")?.press).toEqual({ kind: "close", tabIds: ["b1", "b2"] });
    expect(byId(model, "terminal")?.press).toEqual({ kind: "close", tabIds: ["t1"] });
  });

  it("reads a tool the open bottom panel holds as pressed and closes it there", () => {
    const model = buildDockToolButtons(
      input({ bottomHeld: ["terminal"], bottomPresentedOpen: true }),
    );
    expect(byId(model, "terminal")).toMatchObject({
      pressed: true,
      press: { kind: "close-bottom" },
    });
  });

  it("reads only the bottom panel's active tool as pressed and brings a tool behind it forward", () => {
    const model = buildDockToolButtons(
      input({
        bottomHeld: ["terminal", "files"],
        bottomActive: "files",
        bottomPresentedOpen: true,
      }),
    );
    expect(byId(model, "files")).toMatchObject({ pressed: true, press: { kind: "close-bottom" } });
    expect(byId(model, "terminal")).toMatchObject({
      pressed: false,
      open: true,
      press: { kind: "select-bottom" },
    });
  });

  it("still reveals a bottom panel that a reader hides or that is closed, from its active tool", () => {
    const model = buildDockToolButtons(
      input({ bottomHeld: ["terminal"], bottomActive: "terminal", bottomPresentedOpen: false }),
    );
    expect(byId(model, "terminal")).toMatchObject({ pressed: false, press: { kind: "reveal" } });
  });

  it("replaces the tool in front, rather than tiling, when the dock is the one-tool drawer", () => {
    const model = buildDockToolButtons(
      input({
        narrow: true,
        capsFull: true,
        tabs: [{ id: "files", surface: "files" }],
        shownTabIds: [],
      }),
    );
    expect(byId(model, "files")?.press).toEqual({ kind: "select", tabId: "files" });
    expect(byId(model, "review")?.press).toEqual({ kind: "open" });
    expect(byId(model, "review")?.disabledReason).toBeUndefined();
  });

  it("offers arranging only for tiles, a new shell or page on the repeatable tools, and Close for an open tool", () => {
    const tiled = {
      tabs: [
        { id: "files", surface: "files" as const },
        { id: "review", surface: "review" as const },
        { id: "environment", surface: "environment" as const },
      ],
      shownTabIds: ["files", "review"],
      activeTabId: "review",
      layout: {
        columns: [
          { share: 0.5, tiles: [{ tabId: "files", share: 1 }] },
          { share: 0.5, tiles: [{ tabId: "review", share: 1 }] },
        ],
      },
    };
    const model = buildDockToolButtons(input(tiled));
    const items = (id: string) => byId(model, id)?.menu.map((item) => item.label);
    expect(items("files")).toEqual(["Show alone", "Hide from view", "Move right", "Close Files"]);
    expect(items("review")).toEqual(["Show alone", "Hide from view", "Move left", "Close Review"]);
    expect(items("environment")).toEqual(["Show below", "Close Environment"]);
    expect(items("terminal")).toEqual(["New Terminal"]);
    expect(items("browser")).toEqual(["New Browser page"]);
    expect(byId(model, "files")?.tabId).toBe("files");
    const drawer = buildDockToolButtons(input({ ...tiled, narrow: true }));
    expect(byId(drawer, "files")?.menu.map((item) => item.label)).toEqual(["Close Files"]);
  });

  it("shows a tool that is not shown in the focused tile's place once the tile caps are reached", () => {
    const model = buildDockToolButtons(
      input({
        capsFull: true,
        tabs: [
          { id: "files", surface: "files" },
          { id: "environment", surface: "environment" },
        ],
        shownTabIds: ["environment"],
        activeTabId: "environment",
      }),
    );
    expect(byId(model, "review")).toMatchObject({
      note: "Shows in place of Environment",
      press: { kind: "open" },
    });
    expect(byId(model, "review")?.disabledReason).toBeUndefined();
    expect(byId(model, "files")).toMatchObject({
      open: true,
      note: "Shows in place of Environment",
      press: { kind: "select", tabId: "files" },
    });
    expect(byId(model, "plan")?.note).toBe("Shows in place of Environment");
  });

  it("keeps a shown tool pressable at the tile caps so it can be closed", () => {
    const model = buildDockToolButtons(
      input({ capsFull: true, tabs: [{ id: "files", surface: "files" }], shownTabIds: ["files"] }),
    );
    expect(byId(model, "files")).toMatchObject({ pressed: true, press: { kind: "close" } });
  });

  it("disables every tool a draft task is waiting to offer", () => {
    const model = buildDockToolButtons(
      input({ surfaces: [], awaitingThread: [tool("environment"), tool("files"), tool("plan")] }),
    );
    for (const button of [...model.buttons, ...model.more]) {
      expect(button).toMatchObject({
        disabledReason: "Available once the task starts",
        pressed: false,
        press: { kind: "refused" },
      });
    }
    expect(model.buttons.map((button) => button.id)).toEqual(["environment", "files"]);
  });

  it("shows the Browser page that is on screen, else the focused one, else the last shown", () => {
    const browserTabIds = ["b1", "b2", "b3"];
    expect(
      browserPageToShow({ browserTabIds, shownTabIds: ["x", "b3"], lastBrowserTabId: "b2" }),
    ).toBe("b3");
    expect(
      browserPageToShow({
        browserTabIds,
        shownTabIds: [],
        activeTabId: "b2",
        lastBrowserTabId: "b3",
      }),
    ).toBe("b2");
    expect(
      browserPageToShow({
        browserTabIds,
        shownTabIds: [],
        activeTabId: "x",
        lastBrowserTabId: "b3",
      }),
    ).toBe("b3");
    expect(browserPageToShow({ browserTabIds, shownTabIds: [], lastBrowserTabId: "gone" })).toBe(
      "b1",
    );
    expect(browserPageToShow({ browserTabIds: [], shownTabIds: [] })).toBeUndefined();
  });

  it("returns a hidden Browser to the page it last showed", () => {
    const model = buildDockToolButtons(
      input({
        tabs: [
          { id: "environment", surface: "environment" },
          { id: "b1", surface: "browser" },
          { id: "b2", surface: "browser" },
        ],
        shownTabIds: ["environment"],
        lastBrowserTabId: "b2",
      }),
    );
    expect(byId(model, "browser")?.press).toEqual({ kind: "show-beside", tabId: "b2" });
  });
});

describe("the tool buttons beside a shelf of minimised cards", () => {
  const shelf = { shelfDrawn: true } as const;

  it("minimises a pressed Browser or Terminal on a press and closes every other tool", () => {
    const model = buildDockToolButtons(
      input({
        ...shelf,
        tabs: [
          { id: "b1", surface: "browser" },
          { id: "b2", surface: "browser" },
          { id: "t1", surface: "terminal" },
          { id: "f1", surface: "files" },
        ],
        shownTabIds: ["b2", "t1", "f1"],
      }),
    );
    expect(byId(model, "browser")?.press).toEqual({ kind: "minimise", tabId: "b2" });
    expect(byId(model, "terminal")?.press).toEqual({ kind: "minimise", tabId: "t1" });
    expect(byId(model, "files")?.press).toEqual({ kind: "close", tabIds: ["f1"] });
  });

  it("offers Minimise to card on the Browser and Terminal buttons' menus and no other", () => {
    const model = buildDockToolButtons(
      input({
        ...shelf,
        tabs: [
          { id: "b1", surface: "browser" },
          { id: "t1", surface: "terminal" },
          { id: "f1", surface: "files" },
        ],
        shownTabIds: ["b1", "t1", "f1"],
        layout: {
          columns: [
            {
              share: 1,
              tiles: [
                { tabId: "b1", share: 1 / 3 },
                { tabId: "t1", share: 1 / 3 },
                { tabId: "f1", share: 1 / 3 },
              ],
            },
          ],
        },
      }),
    );
    const labels = (id: string) => byId(model, id)?.menu.map((item) => item.label);
    expect(labels("browser")).toContain("Minimise to card");
    expect(labels("terminal")).toContain("Minimise to card");
    expect(labels("files")).not.toContain("Minimise to card");
    expect(labels("terminal")?.at(-1)).toBe("Close Terminal");
  });

  it("reads a minimised tool as open and not pressed, and a press restores it", () => {
    const model = buildDockToolButtons(
      input({
        ...shelf,
        tabs: [
          { id: "t1", surface: "terminal" },
          { id: "f1", surface: "files" },
        ],
        shownTabIds: ["f1"],
        minimised: ["t1"],
      }),
    );
    expect(byId(model, "terminal")).toMatchObject({
      pressed: false,
      open: true,
      minimised: true,
      press: { kind: "restore", tabId: "t1" },
    });
    expect(byId(model, "files")).toMatchObject({ pressed: true });
  });

  it("restores a minimised tool even while the dock is closed", () => {
    const model = buildDockToolButtons(
      input({
        ...shelf,
        tabs: [{ id: "t1", surface: "terminal" }],
        minimised: ["t1"],
        dockOpen: false,
        dockPresentedOpen: false,
      }),
    );
    expect(byId(model, "terminal")?.press).toEqual({ kind: "restore", tabId: "t1" });
  });

  it("restores a minimised Browser to the page it last showed", () => {
    const model = buildDockToolButtons(
      input({
        ...shelf,
        tabs: [
          { id: "b1", surface: "browser" },
          { id: "b2", surface: "browser" },
        ],
        minimised: ["b1", "b2"],
        lastBrowserTabId: "b2",
      }),
    );
    expect(byId(model, "browser")?.press).toEqual({ kind: "restore", tabId: "b2" });
  });

  it("offers a minimised tool no placement in its menu, only a new page or shell and Close", () => {
    const model = buildDockToolButtons(
      input({
        ...shelf,
        tabs: [{ id: "t1", surface: "terminal" }],
        minimised: ["t1"],
        layout: { columns: [{ share: 1, tiles: [{ tabId: "f1", share: 1 }] }] },
      }),
    );
    expect(byId(model, "terminal")?.menu.map((item) => item.label)).toEqual([
      "New Terminal",
      "Close Terminal",
    ]);
  });

  it("never minimises in the one-tool drawer, where a press replaces the tool shown", () => {
    const model = buildDockToolButtons(
      input({
        shelfDrawn: false,
        narrow: true,
        tabs: [
          { id: "t1", surface: "terminal" },
          { id: "f1", surface: "files" },
        ],
        shownTabIds: ["f1"],
        minimised: [],
      }),
    );
    expect(byId(model, "terminal")).toMatchObject({
      open: true,
      press: { kind: "select", tabId: "t1" },
    });
    expect(byId(model, "terminal")?.minimised).toBeUndefined();
    const shown = buildDockToolButtons(
      input({
        shelfDrawn: false,
        narrow: true,
        tabs: [{ id: "t1", surface: "terminal" }],
        shownTabIds: ["t1"],
      }),
    );
    expect(byId(shown, "terminal")?.press).toEqual({ kind: "close", tabIds: ["t1"] });
  });

  it("closes a pressed Browser or Terminal where the thread has no shelf", () => {
    const model = buildDockToolButtons(
      input({ tabs: [{ id: "b1", surface: "browser" }], shownTabIds: ["b1"] }),
    );
    expect(byId(model, "browser")?.press).toEqual({ kind: "close", tabIds: ["b1"] });
  });
});
