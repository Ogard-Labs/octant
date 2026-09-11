import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadTasksPanel } from "./ThreadTasksPanel";
describe("ThreadTasksPanel", () => {
  it("counts the finished tasks out loud and keeps the rest in order", () => {
    render(
      <ThreadTasksPanel
        tasks={{
          running: true,
          tasks: [
            { id: "t1", state: "completed", summary: "Watch CI on the branch head" },
            { id: "t2", state: "running", summary: "Triage the review findings" },
            { id: "t3", state: "pending", summary: "Commit the captured evidence" },
          ],
        }}
      />,
    );

    expect(screen.getByText("1 of 3 tasks completed")).toBeVisible();
    const items = screen.getByRole("list", { name: "Task list" }).children;
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Watch CI on the branch head");
    expect(items[1]).toHaveTextContent("Triage the review findings");
    expect(items[2]).toHaveTextContent("Commit the captured evidence");
  });

  it("marks the turn as running so the header spins while it writes", () => {
    const { container } = render(
      <ThreadTasksPanel
        tasks={{
          running: true,
          tasks: [{ id: "t1", state: "waiting", summary: "Apply the edit" }],
        }}
      />,
    );
    expect(container.querySelector(".thread-tasks[data-running='true']")).not.toBeNull();
  });

  it("does not claim a running turn once the host settled it", () => {
    const { container } = render(
      <ThreadTasksPanel
        tasks={{
          running: false,
          tasks: [{ id: "t1", state: "pending", summary: "Update the body" }],
        }}
      />,
    );
    expect(container.querySelector(".thread-tasks[data-running]")).toBeNull();
  });
});
