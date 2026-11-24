import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderApprovalPrompt } from "./ProviderApprovalPrompt";

describe("provider approval prompt", () => {
  it("offers Allow once and Remember for this Project on an ask that can be remembered", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onRememberForProject = vi.fn();
    render(
      <ProviderApprovalPrompt
        onAnswer={onAnswer}
        onRememberForProject={onRememberForProject}
        summary="Send dist/notes-app into this thread's disposable desktop?"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remember for this Project" }));
    expect(onRememberForProject).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onAnswer).toHaveBeenCalledWith("approved");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("offers only Approve and Deny on an ask that cannot be remembered", () => {
    render(<ProviderApprovalPrompt onAnswer={vi.fn()} summary="Run the build?" />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remember for this Project" })).toBeNull();
  });

  it("asks to plan first and says the next turn runs in Plan, read-only", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <ProviderApprovalPrompt
        levelChange={{ to: "plan" }}
        onAnswer={onAnswer}
        summary="Claude asks to plan first."
      />,
    );
    expect(screen.getByRole("group", { name: "Plan first" })).toBeTruthy();
    expect(screen.getByText("This turn ends; the next one runs in Plan, read-only.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Switch to Plan" }));
    expect(onAnswer).toHaveBeenCalledWith("approved");
  });

  it("shows the plan and the level an approval returns the thread to", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <ProviderApprovalPrompt
        levelChange={{ to: "auto-accept-edits", plan: "1. Read the test.\n2. Fix the race." }}
        onAnswer={onAnswer}
        summary="Claude finished planning."
      />,
    );
    expect(screen.getByLabelText("Proposed plan").textContent).toBe(
      "1. Read the test.\n2. Fix the race.",
    );
    await user.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onAnswer).toHaveBeenCalledWith("denied");
    expect(screen.getByRole("button", { name: "Approve plan · Auto-accept edits" })).toBeTruthy();
  });
});
