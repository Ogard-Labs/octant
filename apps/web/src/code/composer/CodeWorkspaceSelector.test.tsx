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
    expect(screen.getByRole("option", { name: /Managed worktree/ })).toHaveTextContent(
      "Create an isolated worktree for this thread.",
    );
    fireEvent.click(screen.getByRole("option", { name: /Managed worktree/ }));

    expect(onChange).toHaveBeenCalledWith("managed-worktree");
  });
});
