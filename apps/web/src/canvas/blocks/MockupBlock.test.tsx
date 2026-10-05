import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, within } from "@testing-library/react";
import { settingsScreenExampleBlock } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";

const devices = ["desktop", "tablet", "phone"] as const;

describe("mockup wireframe", () => {
  it("exposes a settings screen as a labelled tree and keeps its controls inert", () => {
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [settingsScreenExampleBlock] }} />,
    );

    const mockup = screen.getByRole("region", { name: "Settings, Desktop mockup" });
    expect(mockup).toHaveAttribute("aria-roledescription", "mockup");
    const tree = within(mockup).getByRole("tree", { name: "Settings" });
    expect(within(tree).getByRole("treeitem", { name: "Window, Settings" })).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Form field, Display name" })).toBeVisible();
    expect(
      within(tree).getByRole("treeitem", { name: "Toggle, Email notifications, on" }),
    ).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Button, Save" })).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Image placeholder, Avatar" })).toBeVisible();

    expect(mockup.querySelector("button, input, select, textarea, a, form")).toBeNull();
    expect(mockup.querySelector("[tabindex]")).toBeNull();
    expect(within(mockup).queryByRole("button")).toBeNull();
    expect(within(mockup).queryByRole("switch")).toBeNull();
    expect(within(mockup).queryByRole("textbox")).toBeNull();
  });

  it("shows one tab panel, not every tab's content", () => {
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [settingsScreenExampleBlock] }} />,
    );
    const tree = within(screen.getByRole("region", { name: "Settings, Desktop mockup" })).getByRole(
      "tree",
      { name: "Settings" },
    );
    expect(within(tree).getByRole("treeitem", { name: "Tabs, Account" })).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Card, Profile" })).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Form field, Display name" })).toBeVisible();
    expect(within(tree).queryByRole("treeitem", { name: "Card, Security" })).toBeNull();
    expect(within(tree).queryByRole("treeitem", { name: "Text, Sign-in" })).toBeNull();
  });

  it.each(devices)("names the %s preset without offering a live control", (device) => {
    const block = { ...settingsScreenExampleBlock, device };
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [block] }} />);
    const mockup = screen.getByRole("region", {
      name: `Settings, ${device[0]?.toUpperCase()}${device.slice(1)} mockup`,
    });
    expect(mockup).toHaveAttribute("data-device", device);
    expect(mockup.querySelector(`[data-device="${device}"]`)).not.toBeNull();
    expect(mockup.querySelector("button, input, form")).toBeNull();
  });

  it("keeps the wireframe on neutral tokens", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../styles/canvas.css"),
      "utf8",
    );
    const section = css.slice(css.indexOf(".canvas-mockup {"));
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/--oct-(?:accent|series|success|warn|danger|stage)/);
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
