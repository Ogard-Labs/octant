import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalCard } from "./GoalCard";
import type { ThreadGoal } from "@octant/contracts";

const goal = {
  id: "00000000-0000-4000-8000-000000000206",
  threadId: "00000000-0000-4000-8000-000000000208",
  revisionId: "00000000-0000-4000-8000-000000000207",
  objective: "Finish Goal card",
  status: "active",
  budget: {},
  usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
  evidence: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  version: 1,
} as unknown as ThreadGoal;

const ledgerCriteria = [
  {
    id: "c1",
    text: "The parser tests pass",
    check: "bun run test --filter parser",
    status: "met",
    evidence: {
      kind: "test",
      referenceId: "goal-check:c1",
      summary: "Exited 0 after 41 passing tests",
      observedAt: "2026-08-01T10:00:00.000Z",
    },
  },
  {
    id: "c2",
    text: "The changelog names the change",
    status: "unmet",
  },
  {
    id: "c3",
    text: "The build is clean",
    check: "bun run build",
    status: "unmet",
    evidence: {
      kind: "test",
      referenceId: "goal-check:c3",
      summary: "Exited 1: type error in lexer.ts",
      observedAt: "2026-08-01T10:05:00.000Z",
    },
  },
];

describe("GoalCard", () => {
  it("renders objective/status and exposes pause/complete actions", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    const onComplete = vi.fn();
    render(
      <GoalCard
        goal={goal}
        onPause={onPause}
        onResume={vi.fn()}
        onComplete={onComplete}
        onRevise={vi.fn()}
      />,
    );
    expect(screen.getByTestId("goal-objective")).toHaveTextContent("Finish Goal card");
    expect(screen.getByTestId("goal-status")).toHaveTextContent("active");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(screen.getByRole("button", { name: "Complete" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("lists each criterion with its state, check and latest evidence", () => {
    render(
      <GoalCard
        goal={{ ...goal, criteria: ledgerCriteria } as unknown as ThreadGoal}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onComplete={vi.fn()}
        onRevise={vi.fn()}
      />,
    );
    const ledger = screen.getByRole("region", { name: "Acceptance criteria" });
    expect(within(ledger).getByTestId("goal-criteria-summary")).toHaveTextContent("1 of 3 met");
    const rows = within(ledger).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveTextContent("Met");
    expect(rows[0]).toHaveTextContent("The parser tests pass");
    expect(rows[0]).toHaveTextContent("Command bun run test --filter parser");
    expect(rows[0]).toHaveTextContent("Check result: Exited 0 after 41 passing tests");

    // A criterion without a command is confirmed by a person and has no evidence yet.
    expect(rows[1]).toHaveTextContent("Not met");
    expect(rows[1]).toHaveTextContent("Confirmed by a person");
    expect(rows[1]).toHaveTextContent("No evidence yet");

    // The last check's outcome shows even when it failed.
    expect(rows[2]).toHaveTextContent("Not met");
    expect(rows[2]).toHaveTextContent("Exited 1: type error in lexer.ts");
  });

  it("shows no ledger for a goal set without criteria", () => {
    render(
      <GoalCard
        goal={goal}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onComplete={vi.fn()}
        onRevise={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "Acceptance criteria" })).not.toBeInTheDocument();
  });

  it("offers no controls when read only", () => {
    render(
      <GoalCard goal={{ ...goal, criteria: ledgerCriteria } as unknown as ThreadGoal} readOnly />,
    );
    expect(screen.getByTestId("goal-objective")).toHaveTextContent("Finish Goal card");
    expect(screen.getByRole("region", { name: "Acceptance criteria" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Goal actions" })).not.toBeInTheDocument();
  });
});
