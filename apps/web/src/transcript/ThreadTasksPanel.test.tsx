import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadTasksPanel } from "./ThreadTasksPanel";
describe("ThreadTasksPanel", () => {
  it("counts the finished tasks and discloses the ordered plan from the keyboard", async () => {
    const user = userEvent.setup();
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
    const toggle = screen.getByRole("button", { name: /1 of 3 tasks completed/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Task list" })).not.toBeInTheDocument();
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    const items = screen.getByRole("list", { name: "Task list" }).children;
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Watch CI on the branch head");
    expect(items[1]).toHaveTextContent("Triage the review findings");
    expect(items[2]).toHaveTextContent("Commit the captured evidence");
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Task list" })).not.toBeInTheDocument();
  });

  it("keeps failed and waiting tasks visible in the collapsed summary after the turn settles", () => {
    render(
      <ThreadTasksPanel
        tasks={{
          running: false,
          tasks: [
            { id: "a", state: "failed", summary: "Run checks" },
            { id: "b", state: "waiting", summary: "Get access" },
            { id: "c", state: "completed", summary: "Read source" },
          ],
        }}
      />,
    );
    const toggle = screen.getByRole("button", { name: /1 of 3 tasks completed/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 failed · 1 waiting");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
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
