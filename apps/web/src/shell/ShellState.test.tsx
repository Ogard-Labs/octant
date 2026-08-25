import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShellState } from "./ShellState";

describe("ShellState", () => {
  it("renders a compact named status without turning its icon into content", () => {
    const { container } = render(
      <ShellState
        eyebrow="Workspace"
        message="Loading authoritative shell state."
        state="loading"
        title="Loading Octant"
      />,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-state", "loading");
    expect(
      screen.getByRole("status").querySelector('[data-slot="empty-state-title"]'),
    ).toHaveTextContent("Loading Octant");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps failure recovery visible and keyboard operable", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ShellState
        action={{ label: "Retry connection", onClick: onAction }}
        eyebrow="Connection"
        message="The local Octant server is unavailable."
        role="alert"
        state="disconnected"
        title="Octant is disconnected"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The local Octant server is unavailable.");
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
