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
  it("keeps tabs out of the space reserved for window controls", () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testCluster === "true" ? 340 : 0;
      });
    const siblingWidth = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("aria-label") === "Add tool" ? 32 : 0;
      });
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return DOMRect.fromRect({
          width: this.classList.contains("dock-tool-strip__tab") ? 104 : 0,
          height: 30,
        });
      });
    try {
      render(
        <div data-test-cluster="true" style={{ paddingLeft: 8, paddingRight: 76, gap: 8 }}>
          <DockToolStrip
            active="terminal"
            onClose={vi.fn()}
            onSelect={vi.fn()}
            tabs={[browser, files, terminal, tests, canvas]}
          />
          <button aria-label="Add tool" />
        </div>,
      );
      expect(screen.getAllByRole("tab")).toHaveLength(1);
      expect(screen.getByRole("tab", { name: "Terminal" })).toBeVisible();
      expect(screen.getByRole("button", { name: "More tools" })).toBeVisible();
    } finally {
      width.mockRestore();
      siblingWidth.mockRestore();
      bounds.mockRestore();
    }
  });

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
