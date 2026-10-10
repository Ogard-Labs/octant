import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeCanvasBlock } from "@octant/contracts/canvas";
import { notificationStatesExampleBlock, settingsScreenExampleBlock } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";

const devices = [
  ["desktop", "Desktop"],
  ["browser", "Browser"],
  ["tablet", "Tablet"],
  ["phone", "Phone"],
  ["dock-panel", "Dock panel"],
] as const;

function draw(block: unknown) {
  return render(
    <CanvasDocument definition={{ ...canvasFixture, blocks: [decodeCanvasBlock(block)] }} />,
  );
}

function expectInert(mockup: HTMLElement) {
  expect(mockup.querySelector("button, input, select, textarea, a, form, summary")).toBeNull();
  expect(mockup.querySelector("[tabindex]")).toBeNull();
  expect(within(mockup).queryByRole("button")).toBeNull();
  expect(within(mockup).queryByRole("switch")).toBeNull();
  expect(within(mockup).queryByRole("checkbox")).toBeNull();
  expect(within(mockup).queryByRole("textbox")).toBeNull();
  expect(within(mockup).queryByRole("combobox")).toBeNull();
  expect(within(mockup).queryByRole("dialog")).toBeNull();
}

describe("mockup wireframe", () => {
  it("exposes a settings screen as a labelled tree and keeps its controls inert", () => {
    draw(settingsScreenExampleBlock);

    const mockup = screen.getByRole("region", { name: "Settings, Desktop mockup" });
    expect(mockup).toHaveAttribute("aria-roledescription", "mockup");
    expect(mockup).toHaveAttribute("data-fidelity", "wireframe");
    const tree = within(mockup).getByRole("tree", { name: "Settings" });
    expect(within(tree).getByRole("treeitem", { name: "Window, Settings" })).toBeVisible();
    expect(
      within(tree).getByRole("treeitem", { name: "Form field, Display name, Ada Lovelace" }),
    ).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Select, Language, English" })).toBeVisible();
    expect(
      within(tree).getByRole("treeitem", { name: "Toggle, Email notifications, on" }),
    ).toBeVisible();
    expect(
      within(tree).getByRole("treeitem", { name: "Checkbox, Weekly digest, not checked" }),
    ).toBeVisible();
    expect(
      within(tree).getByRole("treeitem", { name: "List row, Profile, current" }),
    ).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Avatar, Ada Lovelace" })).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Icon, Search settings" })).toBeVisible();
    for (const item of within(tree).getAllByRole("treeitem")) {
      expect(item).toHaveAttribute("aria-disabled", "true");
    }
    expectInert(mockup);
  });

  it("shows one tab panel, not every tab's content", () => {
    draw(settingsScreenExampleBlock);
    const tree = within(screen.getByRole("region", { name: "Settings, Desktop mockup" })).getByRole(
      "tree",
      { name: "Settings" },
    );
    expect(within(tree).getByRole("treeitem", { name: "Tabs, Account" })).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Card, Profile" })).toBeVisible();
    expect(within(tree).queryByRole("treeitem", { name: "Card, Security" })).toBeNull();
    expect(within(tree).queryByRole("treeitem", { name: "Text, Sign-in" })).toBeNull();
  });

  it("numbers each callout on its node and lists the notes beside the frame", () => {
    draw(settingsScreenExampleBlock);
    const mockup = screen.getByRole("region", { name: "Settings, Desktop mockup" });
    expect(
      within(mockup).getByRole("treeitem", { name: "Button, Save, accent, callout 2" }),
    ).toBeVisible();
    expect(within(mockup).getByRole("treeitem", { name: "Navigation, Sections, callout 1" }));
    const notes = screen.getByRole("list", { name: "Callouts on Settings" });
    const items = within(notes).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "1Sections — The current section stays highlighted while the page scrolls.",
      "2Save — Save stays disabled until a field changes.",
    ]);
  });

  it("pins a callout on the window itself inside the frame", () => {
    draw({
      ...settingsScreenExampleBlock,
      annotations: [{ nodeId: "screen", note: "Opens from the app menu." }],
    });
    const mockup = screen.getByRole("region", { name: "Settings, Desktop mockup" });
    const window = within(mockup).getByRole("treeitem", { name: "Window, Settings, callout 1" });
    expect(window.querySelector(".canvas-mockup__callout-mark")?.textContent).toBe("1");
  });

  it("offers the component tree as an outline list", async () => {
    draw(settingsScreenExampleBlock);
    await userEvent.click(screen.getByText("Outline"));
    const outline = screen.getByText("Outline").closest("details");
    if (outline === null) throw new Error("Outline disclosure is missing.");
    expect(outline).toHaveAttribute("open");
    expect(within(outline).getByText(/^Window, Settings/)).toBeVisible();
    expect(within(outline).getByText(/^Button, Save, accent, callout 2/)).toBeVisible();
    // The outline nests as the tree does: Save sits under Actions, under Profile.
    const save = within(outline).getByText(/^Button, Save/);
    expect(save.closest("ul")?.closest("li")?.firstChild?.textContent).toBe("Row, Actions");
  });

  it("draws every state of a styled screen side by side, each a labelled tree", () => {
    draw(notificationStatesExampleBlock);
    const mockup = screen.getByRole("region", { name: "Notifications, Phone mockup" });
    expect(mockup).toHaveAttribute("data-fidelity", "styled");
    for (const state of ["Loaded", "Empty", "Error"]) {
      expect(within(mockup).getByText(state)).toBeVisible();
      expect(
        within(mockup).getByRole("tree", { name: `${state}: Notifications` }),
      ).toBeInTheDocument();
    }
    const error = within(mockup).getByRole("tree", { name: "Error: Notifications" });
    expect(within(error).getByRole("treeitem", { name: "Toast, You're offline, danger" }));
    expect(within(error).getByRole("treeitem", { name: "Button, Try again, accent, callout 1" }));
    expect(within(error).queryByRole("treeitem", { name: /Empty inbox/ })).toBeNull();
    expectInert(mockup);
  });

  it("names a table's columns and rows and draws a modal without opening a dialog", () => {
    draw({
      blockId: "members",
      schemaVersion: 12,
      kind: "mockup",
      device: "browser",
      title: "Members",
      nodes: [
        { nodeId: "page", component: "stack", label: "Members" },
        {
          nodeId: "people",
          component: "table",
          label: "People",
          columns: ["Name", "Role"],
          rows: [
            ["Ada", "Owner"],
            ["Grace", "Member"],
          ],
          parentId: "page",
        },
        { nodeId: "remove", component: "modal", label: "Remove Grace?", parentId: "page" },
        {
          nodeId: "confirm",
          component: "button",
          label: "Remove",
          tone: "danger",
          parentId: "remove",
        },
      ],
    });
    const mockup = screen.getByRole("region", { name: "Members, Browser mockup" });
    expect(
      within(mockup).getByRole("treeitem", {
        name: "Table, People, 2 columns: Name, Role, 2 rows",
      }),
    ).toBeVisible();
    expect(within(mockup).getByRole("treeitem", { name: "Modal, Remove Grace?" })).toBeVisible();
    // The drawn table is a picture: it is hidden from assistive technology,
    // which reads the item's name instead.
    expect(within(mockup).queryByRole("table")).toBeNull();
    expectInert(mockup);
  });

  it.each(devices)("names the %s preset without offering a live control", (device, name) => {
    draw({ ...settingsScreenExampleBlock, device });
    const mockup = screen.getByRole("region", { name: `Settings, ${name} mockup` });
    expect(mockup).toHaveAttribute("data-device", device);
    expect(mockup.querySelector(`.canvas-mockup__frame[data-device="${device}"]`)).not.toBeNull();
    expectInert(mockup);
  });

  it("draws a custom frame at its own size", () => {
    draw({ ...settingsScreenExampleBlock, device: "custom", size: { width: 600, height: 400 } });
    const mockup = screen.getByRole("region", { name: "Settings, Custom mockup" });
    const frame = mockup.querySelector<HTMLElement>(".canvas-mockup__frame");
    expect(frame?.style.getPropertyValue("--canvas-mockup-frame-w")).toBe("600px");
    expect(frame?.style.getPropertyValue("--canvas-mockup-frame-ratio")).toBe("600 / 400");
    expect(within(mockup).getByText("600 × 400")).toBeInTheDocument();
  });

  it("keeps the wireframe on neutral tokens and gives styled, dark, and forced colours their own rules", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../styles/canvas.css"),
      "utf8",
    );
    const start = css.indexOf(".canvas-mockup-block {");
    const styled = css.indexOf("/* mockup: styled fidelity.");
    const end = css.indexOf("/* A design: real screens");
    expect(start).toBeGreaterThan(0);
    expect(styled).toBeGreaterThan(start);
    const wireframe = css.slice(start, styled);
    expect(wireframe).not.toMatch(/--oct-(?:accent|series|success|warn|danger|stage)/);
    expect(css.slice(start, end)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const themed = css.slice(styled, end);
    expect(themed).toMatch(/var\(--oct-accent\)/);
    expect(themed).toMatch(/@media \(forced-colors: active\)/);
  });
});
