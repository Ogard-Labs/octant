import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeWorkspaceSelector } from "./CodeWorkspaceSelector";

describe("CodeWorkspaceSelector", () => {
  it("offers current checkout and managed worktree as titled choices", () => {
    const onChange = vi.fn();
    render(<CodeWorkspaceSelector onChange={onChange} value="current-checkout" />);

    const trigger = screen.getByRole("button", { name: "Workspace" });
    expect(trigger).toHaveTextContent("Current checkout");
    fireEvent.click(trigger);
    // The shared menu names a choice by its label and describes it with its
    // sentence, so the two are never read as one run-together string.
    const managed = screen.getByRole("menuitemradio", { name: "Managed worktree" });
    expect(managed).toHaveAccessibleDescription("Create an isolated worktree for this thread.");
    expect(screen.getByRole("menuitemradio", { name: "Current checkout" })).toBeChecked();
    fireEvent.click(managed);

    expect(onChange).toHaveBeenCalledWith("managed-worktree");
  });

  it("does not open while the composer is already creating a thread", () => {
    render(<CodeWorkspaceSelector disabled onChange={vi.fn()} value="current-checkout" />);

    expect(screen.getByRole("button", { name: "Workspace" })).toBeDisabled();
  });
});
