import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { codeDecision } from "../palette/pendingRequests.test-fixtures";
import { PendingRequestRow } from "./PendingRequestRow";

const NOW = Date.parse("2026-10-06T08:10:00.000Z");

describe("a decision row", () => {
  it("shows the ask clamped to two lines, the recommended option first and marked, and Reply…", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={codeDecision()}
      />,
    );
    const row = screen.getByRole("group", { name: "Fix the parser asks you to decide" });
    const ask = within(row).getByText("The fix is ready. Should I open the pull request now?");
    expect(ask).toHaveClass("pending-request__text");
    expect(within(row).getByText("Waiting 6m")).toBeInTheDocument();
    const actions = within(row)
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent);
    expect(actions).toEqual(["1Open itRecommended", "2Wait for review", "Reply…"]);
  });

  it("puts the recommended option first in focus order and sends an option by its number", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn(async () => ({ status: "answered" as const }));
    const request = codeDecision();
    render(
      <PendingRequestRow
        embedded
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={vi.fn()}
        request={request}
      />,
    );
    await user.tab();
    expect(document.activeElement).toHaveTextContent("Open it");
    await user.keyboard("2");
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(request, {
      kind: "choice",
      label: "Wait for review",
    });
  });

  it("opens the thread from Reply… and sends nothing", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onOpenThread = vi.fn();
    const request = codeDecision();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
        request={request}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reply…" }));
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
