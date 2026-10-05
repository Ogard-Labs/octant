import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("closes when the reader turns to something else", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Elsewhere</button>
        <DockUtilityLauncher onOpen={vi.fn()} surfaces={[{ id: "terminal", label: "Terminal" }]} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Add tool" }));
    expect(await screen.findByRole("menuitem", { name: "Terminal" })).toBeVisible();

    // Left open over whatever comes next, the reader's following click is spent
    // dismissing the menu rather than doing what they clicked.
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Terminal" })).not.toBeInTheDocument(),
    );
  });

  it("offers the pull requests this task is already about, not just tool kinds", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: "Add tool" }));
    expect(await screen.findByText("Relevant to this thread")).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: /#917 Faster issue validation/ }));
    expect(onOpenPullRequest).toHaveBeenCalledOnce();
    // The menu closes on choosing, the same as choosing a tool does.
    await waitFor(() =>
      expect(screen.queryByText("Relevant to this thread")).not.toBeInTheDocument(),
    );
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
    expect(screen.getByRole("button", { name: "Add tool" })).toHaveClass("shell-icon-button");
  });

  it("opens available tools and restores focus to the trigger", async () => {
    const user = userEvent.setup();
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
    await user.click(trigger);
    expect(await screen.findByRole("menuitem", { name: "Browser" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Terminal" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "iOS Simulator" })).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "iOS Simulator" }));
    expect(onOpen).toHaveBeenCalledWith("ios-simulator");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens on its first tool and hands focus back to the plus on Escape", async () => {
    const user = userEvent.setup();
    render(
      <DockUtilityLauncher
        onOpen={vi.fn()}
        surfaces={[
          { id: "browser", label: "Browser" },
          { id: "terminal", label: "Terminal" },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Add tool" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    // Workspace lists Browser before Terminal, so Browser is the first row.
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Browser" })).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Browser" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("hangs the menu outside the dock so the dock's edge cannot clip it", async () => {
    const user = userEvent.setup();
    render(
      <div className="right-utility-dock__toolbar">
        <DockUtilityLauncher onOpen={vi.fn()} surfaces={[{ id: "terminal", label: "Terminal" }]} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Add tool" }));
    const row = await screen.findByRole("menuitem", { name: "Terminal" });
    // The in-flow menu was clipped at the dock's right edge, and pinning it to
    // the toolbar put it far from the plus. A portal anchored to the plus has
    // neither problem, so the menu must not live inside the toolbar.
    expect(row.closest(".right-utility-dock__toolbar")).toBeNull();
  });

  it("groups available tools by thread, workspace, and device in the open menu", async () => {
    const user = userEvent.setup();
    render(
      <DockUtilityLauncher
        onOpen={vi.fn()}
        surfaces={[
          { id: "android-emulator", label: "Android emulator" },
          { id: "browser", label: "Browser" },
          { id: "environment", label: "Environment" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add tool" }));
    expect(
      within(await screen.findByRole("group", { name: "Thread tools" })).getByRole("menuitem", {
        name: "Environment",
      }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("group", { name: "Workspace" })).getByRole("menuitem", {
        name: "Browser",
      }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("group", { name: "Devices" })).getByRole("menuitem", {
        name: "Android emulator",
      }),
    ).toBeVisible();
    expect(screen.getAllByText(/^(Thread tools|Workspace|Devices)$/)).toHaveLength(3);
  });
});
