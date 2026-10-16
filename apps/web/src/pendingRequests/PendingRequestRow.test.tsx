import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  codeChildQuestion,
  codeDecision,
  workChildApproval,
  workLeadApproval,
} from "../palette/pendingRequests.test-fixtures";
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

describe("a waiting subagent row", () => {
  it("names the parent thread and the subagent and offers only Review request", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onOpenThread = vi.fn();
    const request = workChildApproval();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
        request={request}
      />,
    );
    const row = screen.getByRole("group", {
      name: "Quarterly report has a subagent waiting for you",
    });
    expect(within(row).getByText("Research subagent needs your approval")).toBeInTheDocument();
    expect(within(row).getByText(/Collect last quarter's figures\./)).toBeInTheDocument();
    expect(within(row).getByText("shell: bun run collect")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
    expect(
      within(row)
        .getAllByRole("button")
        .slice(1)
        .map((button) => button.textContent),
    ).toEqual(["Review request"]);
    await user.click(screen.getByRole("button", { name: "Review request" }));
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("says a subagent asked a question and answers nothing from a number key", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={vi.fn()}
        request={codeChildQuestion()}
      />,
    );
    expect(screen.getByText("Review subagent asked a question")).toBeInTheDocument();
    await user.tab();
    await user.keyboard("1");
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("an agent approval row", () => {
  it("says the agent needs approval and offers only Review request, never Approve or Deny", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onOpenThread = vi.fn();
    const request = workLeadApproval();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
        request={request}
      />,
    );
    const row = screen.getByRole("group", { name: "Quarterly report needs your approval" });
    expect(within(row).getByText("edit: summary.md")).toBeInTheDocument();
    expect(within(row).getByText("Waiting 3m")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
    expect(
      within(row)
        .getAllByRole("button")
        .slice(1)
        .map((button) => button.textContent),
    ).toEqual(["Review request"]);
    await user.click(screen.getByRole("button", { name: "Review request" }));
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("says an approval a restart left behind did not run", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={workLeadApproval(true)}
      />,
    );
    expect(
      screen.getByText("Octant restarted while this was waiting, so it did not run."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review request" })).toBeInTheDocument();
  });

  it("answers nothing from a number key", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={vi.fn()}
        request={workLeadApproval()}
      />,
    );
    await user.tab();
    await user.keyboard("1");
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
