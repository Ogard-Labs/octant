import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextStatusBar } from "./ContextStatusBar";
import { contextFixture } from "./contextFixtures";

describe("ContextStatusBar", () => {
  it("opens the measured context window before handing off to the full inspector", async () => {
    let activeAtOpen: Element | null = null;
    const onOpen = vi.fn(() => {
      activeAtOpen = document.activeElement;
    });
    const user = userEvent.setup();
    render(
      <ContextStatusBar
        focus={{ kind: "thread" }}
        onOpenInspector={onOpen}
        snapshot={contextFixture({ health: "watch" })}
      />,
    );
    const button = screen.getByRole("button", { name: /Show context window/i });
    expect(button).toHaveTextContent("Fixture thread · model-a");
    expect(button).toHaveTextContent("104 / 1K");
    expect(button).toHaveTextContent("10%");
    expect(screen.getByText(/Last sent context 104 \/ 1K/)).toHaveClass("sr-only");

    await user.click(button);

    const popover = screen.getByRole("dialog", { name: "Context window" });
    expect(popover).toHaveTextContent("Last sent");
    expect(popover).toHaveTextContent("Current request42");
    expect(popover).toHaveTextContent("Octant tools58");
    expect(popover).toHaveTextContent("Observed overhead4");
    expect(popover).toHaveTextContent("Reserved100");
    expect(popover).toHaveTextContent("Free space796");
    expect(popover).toHaveTextContent(/Tools2 loaded· 6 deferred/);
    expect(popover).toHaveTextContent(/MCP0 loaded· 3 deferred/);
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Open full context inspector" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(activeAtOpen).toBe(button);
    expect(screen.queryByRole("dialog", { name: "Context window" })).not.toBeInTheDocument();
  });

  it("shows unknown usage honestly, preserves attention, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <ContextStatusBar
        focus={{ kind: "pane", label: "Terminal" }}
        onOpenInspector={vi.fn()}
        snapshot={contextFixture({ health: "blocked", unknownTokens: true })}
      />,
    );
    expect(screen.getByText("Terminal")).toBeVisible();
    expect(screen.getByText(/Fixture thread: Blocked/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Show context window/i })).toHaveTextContent(
      /unknown/,
    );

    await user.click(screen.getByRole("button", { name: /Show context window/i }));
    expect(screen.getByRole("dialog", { name: "Context window" })).toHaveTextContent(
      "Octant toolsUnknown",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Context window" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show context window/i })).toHaveFocus();
  });
});
