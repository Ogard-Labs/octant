import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockUtilityLauncher } from "./DockUtilityLauncher";

describe("right sidebar tool launcher", () => {
  it("starts every menu row's icon and label at the same two edges", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const rule = styles.match(/\.workspace-disclosure__action \{([^}]*)\}/)?.[1];

    // Each row is an OctantButton, and the button recipe centres its contents.
    // `text-align: left` does not undo that for a flex box, so every row
    // centred its own icon-and-label pair and the width of the label decided
    // where its icon sat.
    expect(rule).toContain("justify-content: flex-start");
    expect(styles).toMatch(/\.workspace-disclosure__action > svg \{[^}]*flex: 0 0 16px;/);
  });

  it("offers nothing rather than a dead control when every tool is already open", () => {
    render(<DockUtilityLauncher onOpen={vi.fn()} surfaces={[]} />);
    expect(screen.queryByRole("button", { name: "Add tool" })).not.toBeInTheDocument();
  });

  it("opens available tools and restores focus to the trigger", () => {
    const onOpen = vi.fn();
    render(
      <DockUtilityLauncher
        onOpen={onOpen}
        surfaces={[
          { id: "browser", label: "Browser" },
          { id: "terminal", label: "Terminal" },
          { id: "ios-simulator", label: "iOS Simulator" },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Add tool" });
    fireEvent.click(trigger);
    expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "",
      "Browser",
      "Terminal",
      "iOS Simulator",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "iOS Simulator" }));
    expect(onOpen).toHaveBeenCalledWith("ios-simulator");
    expect(trigger).toHaveFocus();
  });
});
