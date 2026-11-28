import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { approvalReason } from "./approvalReason";
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

  it("asks a plain question with the thread's reason under it and the command in a well", () => {
    render(
      <ProviderApprovalPrompt
        command="bun test apps/web/src/composer"
        onAnswer={vi.fn()}
        onRememberForProject={vi.fn()}
        reason="This thread asks before it runs commands or changes files."
        summary="Run the composer tests?"
      />,
    );
    const card = screen.getByRole("group", { name: "Provider approval" });
    expect(within(card).getByText("Run the composer tests?")).toBeTruthy();
    expect(
      within(card).getByText("This thread asks before it runs commands or changes files."),
    ).toBeTruthy();
    const well = within(card).getByRole("group", { name: "The call it asks about" });
    expect(well.textContent).toBe("bun test apps/web/src/composer");
    // The command comes before the answers in the document, so a screen reader
    // meets it first; the stylesheet lays the card out in the same order.
    const answers = within(card).getAllByRole("button");
    expect(answers.map((button) => button.textContent)).toEqual([
      "Allow once",
      "Remember for this Project",
      "Deny",
    ]);
    expect(well.compareDocumentPosition(answers[0] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("draws no well when the ask names no call", () => {
    render(
      <ProviderApprovalPrompt
        onAnswer={vi.fn()}
        reason="This thread asks before it runs commands or changes files."
        summary="Let this thread use the iPhone?"
      />,
    );
    expect(screen.queryByRole("group", { name: "The call it asks about" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("says why the thread asks in the words of its mode", () => {
    expect(approvalReason("ask-first")).toBe(
      "This thread asks before it runs commands or changes files.",
    );
    expect(approvalReason("accept-edits")).toBe(
      "This thread edits files on its own and asks before it runs commands.",
    );
    expect(approvalReason("auto")).toBe("This thread's reviewer left this one to you.");
    expect(approvalReason("plan")).toBe("This thread is planning, read-only, so it asks first.");
    expect(approvalReason("full-access")).toBe(
      "This thread runs with Full access, and this one still asks you.",
    );
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
