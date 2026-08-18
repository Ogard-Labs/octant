import type { ParallelRunComparison } from "@octant/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ParallelRunComparisonPanel } from "./ParallelRunComparisonPanel";

const comparison: ParallelRunComparison = {
  entries: [
    {
      threadId: "thread-a",
      label: "Attempt A",
      state: "ready",
      commits: 3,
      changedPaths: 2,
      overlappingPaths: ["src/app.ts"],
    },
    {
      threadId: "thread-b",
      label: "Attempt B",
      state: "conflicts",
      commits: 1,
      changedPaths: 2,
      overlappingPaths: ["src/app.ts"],
    },
    {
      threadId: "thread-c",
      label: "Attempt C",
      state: "no-outcome",
      commits: 0,
      changedPaths: 0,
      overlappingPaths: [],
    },
  ],
  contestedPaths: ["src/app.ts"],
};

function panel(overrides: Partial<Parameters<typeof ParallelRunComparisonPanel>[0]> = {}) {
  const onBringHome = vi.fn();
  const onRefresh = vi.fn();
  render(
    <ParallelRunComparisonPanel
      busy={false}
      comparison={comparison}
      onBringHome={onBringHome}
      onRefresh={onRefresh}
      {...overrides}
    />,
  );
  return { onBringHome, onRefresh };
}

describe("comparing what parallel attempts produced", () => {
  it("says where the attempts collide", () => {
    panel();

    expect(
      screen.getByText(/1 file was changed by more than one attempt: src\/app\.ts/),
    ).toBeInTheDocument();
  });

  it("offers to bring home only the attempt that can be brought home", () => {
    panel();

    expect(screen.getAllByRole("button", { name: "Bring it home" })).toHaveLength(1);
    expect(screen.getByText("Conflicts with the base branch")).toBeInTheDocument();
    expect(screen.getByText("Not reviewed yet")).toBeInTheDocument();
  });

  it("asks before merging into the Project's checkout", async () => {
    const user = userEvent.setup();
    const { onBringHome } = panel();

    await user.click(screen.getByRole("button", { name: "Bring it home" }));
    expect(onBringHome).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Merge it" }));
    expect(onBringHome).toHaveBeenCalledWith("thread-a");
  });

  it("lets the user back out of a merge they opened", async () => {
    const user = userEvent.setup();
    const { onBringHome } = panel();

    await user.click(screen.getByRole("button", { name: "Bring it home" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onBringHome).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Bring it home" })).toBeInTheDocument();
  });

  it("shows the host's refusal in the words the host used", () => {
    panel({ message: "The Project's checkout has uncommitted changes." });

    expect(screen.getByRole("status")).toHaveTextContent("uncommitted changes");
  });

  it("states each attempt's facts without ranking them", () => {
    panel();

    expect(screen.getByText(/3 commits · 2 files · 1 also changed elsewhere/)).toBeInTheDocument();
  });
});
