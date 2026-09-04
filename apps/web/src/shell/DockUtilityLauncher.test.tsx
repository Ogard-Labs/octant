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

  it("offers the pull requests this task is already about, not just tool kinds", () => {
    const onOpenPullRequest = vi.fn();
    render(
      <DockUtilityLauncher
        onOpen={vi.fn()}
        references={[
          {
            id: "https://github.com/acme/widget/pull/917",
            label: "#917 Faster issue validation",
            detail: "acme/widget",
            onOpen: onOpenPullRequest,
          },
        ]}
        surfaces={[{ id: "terminal", label: "Terminal" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add tool" }));
    expect(screen.getByText("Relevant to this task")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /#917 Faster issue validation/ }));
    expect(onOpenPullRequest).toHaveBeenCalledOnce();
    // The menu closes on choosing, the same as choosing a tool does.
    expect(screen.queryByText("Relevant to this task")).not.toBeInTheDocument();
  });

  it("still offers references when every tool kind is already open", () => {
    render(
      <DockUtilityLauncher
        onOpen={vi.fn()}
        references={[{ id: "pr-1", label: "#1 A change", onOpen: vi.fn() }]}
        surfaces={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Add tool" })).toBeVisible();
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
    expect(trigger).toHaveTextContent("");
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Browser" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeVisible();
    expect(screen.getByRole("button", { name: "iOS Simulator" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "iOS Simulator" }));
    expect(onOpen).toHaveBeenCalledWith("ios-simulator");
    expect(trigger).toHaveFocus();
  });
});
