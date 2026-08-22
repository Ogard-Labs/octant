import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DockToolStrip } from "./DockToolStrip";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";

function surface(id: (typeof RIGHT_UTILITY_DOCK_SURFACES)[number]["id"]) {
  const found = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
  return found;
}

const browser = surface("browser");
const files = surface("files");
const terminal = surface("terminal");
const tests = surface("tests");
const canvas = surface("canvas");

describe("the dock tool strip", () => {
  it("marks the active tool and closes it without stopping other tools", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <DockToolStrip
        active="browser"
        onClose={onClose}
        onSelect={onSelect}
        tabs={[browser, terminal]}
      />,
    );

    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("button", { name: "Hide Browser" }));
    expect(onClose).toHaveBeenCalledWith("browser");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("moves among open tools with arrow keys and reaches the last tool with End", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DockToolStrip
        active="browser"
        onClose={vi.fn()}
        onSelect={onSelect}
        tabs={[browser, files, terminal]}
      />,
    );

    screen.getByRole("tab", { name: "Browser" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith("files");
    await user.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("terminal");
    await user.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith("browser");
  });

  it("moves overflowed tools into a More tools menu instead of dropping them", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DockToolStrip
        active="browser"
        capacity={4}
        onClose={vi.fn()}
        onSelect={onSelect}
        tabs={[browser, files, terminal, tests, canvas]}
      />,
    );

    expect(screen.getByRole("tab", { name: "Browser" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Canvas" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More tools" }));
    await user.click(screen.getByRole("button", { name: "Canvas" }));
    expect(onSelect).toHaveBeenCalledWith("canvas");
  });
});
