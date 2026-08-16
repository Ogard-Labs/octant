import type { WorkspaceTabGroup } from "@octant/contracts/shell";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./WorkspaceTabs";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function cssRule(selector: string): string {
  const match = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gs)].find((candidate) =>
    candidate[1]
      ?.split(",")
      .map((value) => value.trim())
      .includes(selector),
  );
  expect(match, `missing CSS rule for ${selector}`).toBeDefined();
  return match?.[2] ?? "";
}

function group(): WorkspaceTabGroup {
  return {
    kind: "group",
    nodeId: "00000000-0000-4000-8000-000000000911" as never,
    groupId: "00000000-0000-4000-8000-000000000912" as never,
    activeTabId: "00000000-0000-4000-8000-000000000914" as never,
    tabs: [
      {
        kind: "welcome",
        id: "00000000-0000-4000-8000-000000000913" as never,
        mode: "code",
        title: "First",
      },
      {
        kind: "welcome",
        id: "00000000-0000-4000-8000-000000000914" as never,
        mode: "code",
        title: "Second",
      },
    ],
  };
}

describe("WorkspaceTabs", () => {
  it("renders separate rounded tabs without a continuous bar or vertical dividers", () => {
    const header = cssRule(".workspace-group__header");
    const tabs = cssRule(".workspace-tabs");
    const item = cssRule(".workspace-tab-item");
    const paneActions = cssRule(".workspace-pane-actions");
    const selected = cssRule('.workspace-tab-item:has(.workspace-tab[aria-selected="true"])');

    expect(header).not.toMatch(/background:|border-bottom:/);
    expect(tabs).toContain("gap: 4px;");
    expect(item).toContain("border-radius: 8px;");
    expect(item).not.toMatch(/border-right:/);
    expect(paneActions).not.toMatch(/border-left:/);
    expect(selected).toContain("background: var(--octant-selection);");
    expect(selected).not.toMatch(/accent|border-bottom|border-color|box-shadow/i);
    expect(cssRule('.workspace-group[data-focused="true"]')).toContain("box-shadow: none;");
  });

  it("keeps content-sized rounded tabs inside the native titlebar rhythm", () => {
    const header = cssRule(".workspace-group__header");
    const item = cssRule(".workspace-tab-item");
    const slot = cssRule(".workspace-tab-slot");
    const tab = cssRule(".workspace-tab");

    expect(header).toContain("min-height: 34px;");
    expect(header).toContain(
      "padding: 2px var(--octant-window-chrome-reserved-width, 148px) 2px 4px;",
    );
    expect(item).toContain("max-width: min(184px, 24vw);");
    expect(slot).toContain("max-width: min(184px, 24vw);");
    expect(tab).toContain("width: auto;");
    expect(tab).toContain("min-width: 96px;");
  });

  it("uses the empty tab rail as native drag space while keeping controls interactive", () => {
    render(
      <WorkspaceTabs
        group={group()}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSplit={vi.fn()}
      />,
    );

    const rail = screen.getByRole("tablist", { name: "Workspace tabs" });
    expect(rail).toHaveClass("window-drag-region");
    expect(rail).not.toHaveClass("window-no-drag");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveClass("window-no-drag");
    expect(screen.getByRole("button", { name: "Close Second" })).toHaveClass("window-no-drag");
  });

  it("keeps close visible and moves reorder/split controls into an explicit disclosure", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onReorder = vi.fn();
    const onSplit = vi.fn();
    render(
      <WorkspaceTabs
        group={group()}
        onActivate={vi.fn()}
        onClose={onClose}
        onReorder={onReorder}
        onSplit={onSplit}
      />,
    );

    expect(screen.getByRole("button", { name: "Close Second" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Move Second left" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split Second above" })).not.toBeInTheDocument();

    const actions = screen.getByRole("button", { name: "Tab actions for Second" });
    expect(actions).toHaveAttribute("aria-expanded", "false");
    await user.click(actions);
    expect(actions).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Move Second left" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Split Second above" }));
    expect(onSplit).toHaveBeenCalledWith(group().tabs[1]!.id, "vertical", "before");
    expect(actions).toHaveAttribute("aria-expanded", "false");
    expect(actions).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Close Second" }));
    expect(onClose).toHaveBeenCalledWith(group().tabs[1]!.id);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("keeps a Project health accessory visible on an inactive tab", () => {
    render(
      <WorkspaceTabs
        group={group()}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSplit={vi.fn()}
        renderAccessory={(tab) =>
          tab.title === "First" ? <button type="button">First needs attention</button> : null
        }
      />,
    );

    expect(screen.getByRole("button", { name: "First needs attention" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "false");
  });

  it("links tabs to their panels and supports roving keyboard navigation", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <WorkspaceTabs
        group={group()}
        onActivate={onActivate}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSplit={vi.fn()}
      />,
    );

    const first = screen.getByRole("tab", { name: "First" });
    const second = screen.getByRole("tab", { name: "Second" });
    expect(first).toHaveAttribute("tabindex", "-1");
    expect(second).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("aria-controls", `workspace-panel-${group().tabs[1]!.id}`);
    second.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onActivate).toHaveBeenCalledWith(group().tabs[0]!.id);
    expect(first).toHaveFocus();
  });

  it("closes with Escape and omits unavailable movement directions", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceTabs
        group={group()}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSplit={vi.fn()}
      />,
    );

    const firstActions = screen.getByRole("button", { name: "Tab actions for First" });
    await user.click(firstActions);
    expect(screen.queryByRole("button", { name: "Move First left" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move First right" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(firstActions).toHaveAttribute("aria-expanded", "false");
    expect(firstActions).toHaveFocus();
  });
});
