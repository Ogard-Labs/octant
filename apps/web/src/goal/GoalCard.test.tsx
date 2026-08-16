import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
