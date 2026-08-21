import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextStatusBar } from "./ContextStatusBar";
import { contextFixture } from "./contextFixtures";

describe("ContextStatusBar", () => {
  it("identifies thread/model, headroom, capabilities, and health", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextStatusBar
        focus={{ kind: "thread" }}
        onOpenInspector={onOpen}
        snapshot={contextFixture({ health: "watch" })}
      />,
    );
    const button = screen.getByRole("button", { name: /Open context inspector/i });
    expect(button).toHaveTextContent("Fixture thread · model-a");
    expect(button).toHaveTextContent("Headroom 800");
    expect(button).toHaveTextContent("Tools 2/8");
    expect(button).toHaveTextContent("Watch");
    await user.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows unknown usage honestly and preserves attention under pane focus", () => {
    render(
      <ContextStatusBar
        focus={{ kind: "pane", label: "Terminal" }}
        onOpenInspector={vi.fn()}
        snapshot={contextFixture({ health: "blocked", unknownTokens: true })}
      />,
    );
    expect(screen.getByText("Terminal")).toBeVisible();
    expect(screen.getByText(/Fixture thread: Blocked/)).toBeVisible();
    expect(screen.getByText(/unknown/)).toBeVisible();
  });
});
