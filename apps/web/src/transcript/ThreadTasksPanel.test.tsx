import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadTasksPanel } from "./ThreadTasksPanel";
import { ReplyDetailContext } from "./replyDetail";
import { RevealHiddenStepsContext } from "./revealHiddenSteps";
describe("ThreadTasksPanel", () => {
  it("shows the ordered plan while the turn runs and folds it from the keyboard", async () => {
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
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const items = screen.getByRole("list", { name: "Task list" }).children;
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Watch CI on the branch head");
    expect(items[1]).toHaveTextContent("Triage the review findings");
    expect(items[2]).toHaveTextContent("Commit the captured evidence");
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Task list" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Task list" }).children).toHaveLength(3);
  });

  it("tells a screen reader each task's own state, not only the count", () => {
    render(
      <ThreadTasksPanel
        tasks={{
          running: true,
          tasks: [
            { id: "t1", state: "completed", summary: "Update parser" },
            { id: "t2", state: "pending", summary: "Run tests" },
          ],
        }}
      />,
    );
    const items = screen.getByRole("list", { name: "Task list" }).children;
    expect(items[0]).toHaveTextContent(/Update parser, done$/);
    expect(items[1]).toHaveTextContent(/Run tests, not started$/);
  });

  it("does not read or draw a stopped turn's task in hand as still in progress", () => {
    render(
      <ThreadTasksPanel
        alwaysOpen
        tasks={{
          running: false,
          tasks: [{ id: "t1", state: "running", summary: "Run tests" }],
        }}
      />,
    );
    const row = screen.getByRole("list", { name: "Task list" }).children[0];
    expect(row).toHaveTextContent(/Run tests, not finished$/);
    // No spinner: the row is not drawn as running once its turn stopped.
    expect(row).not.toHaveAttribute("data-task-state", "running");
  });

  it("names the task in its running wording only while the turn is running", () => {
    const tasks = [
      {
        id: "a",
        state: "running",
        summary: "Run the test suite",
        runningSummary: "Running the test suite",
      },
      { id: "b", state: "pending", summary: "Commit", runningSummary: "Committing" },
    ] as const;
    const { rerender } = render(<ThreadTasksPanel tasks={{ running: true, tasks }} />);
    const items = screen.getByRole("list", { name: "Task list" }).children;
    expect(items[0]).toHaveTextContent("Running the test suite");
    expect(items[1]).toHaveTextContent("Commit");
    expect(items[1]).not.toHaveTextContent("Committing");
    expect(screen.getByRole("button", { name: /Running the test suite/ })).toBeVisible();

    rerender(<ThreadTasksPanel tasks={{ running: false, tasks }} />);
    fireEvent.click(screen.getByRole("button", { name: /0 of 2 tasks completed/ }));
    expect(screen.getByRole("list", { name: "Task list" }).children[0]).toHaveTextContent(
      "Run the test suite",
    );
    expect(screen.queryByText("Running the test suite")).not.toBeInTheDocument();
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

  describe("at Answers only", () => {
    const tasks = [
      { id: "t1", state: "completed" as const, summary: "Watch CI on the branch head" },
      { id: "t2", state: "waiting" as const, summary: "Choose a branch" },
      { id: "t3", state: "completed" as const, summary: "Commit the evidence" },
    ];

    it("keeps a task waiting on the person and puts the others behind one line", async () => {
      const user = userEvent.setup();
      render(
        <ReplyDetailContext.Provider value="answers">
          <ThreadTasksPanel tasks={{ running: false, tasks }} />
        </ReplyDetailContext.Provider>,
      );
      expect(screen.getByText("Choose a branch")).toBeVisible();
      expect(screen.queryByText("Watch CI on the branch head")).toBeNull();
      await user.click(screen.getByRole("button", { name: "2 tasks hidden" }));
      expect(screen.getByText("Watch CI on the branch head")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Hide tasks" }));
      expect(screen.queryByText("Watch CI on the branch head")).toBeNull();
    });

    it("keeps the task in hand in sight while the turn runs, and nothing routine", () => {
      const running = [
        { id: "t1", state: "completed" as const, summary: "Read the failing test" },
        { id: "t2", state: "running" as const, summary: "Run the tests" },
      ];
      render(
        <ReplyDetailContext.Provider value="answers">
          <ThreadTasksPanel tasks={{ running: true, tasks: running }} />
        </ReplyDetailContext.Provider>,
      );
      expect(screen.getByText("Run the tests")).toBeVisible();
      expect(screen.queryByText("Read the failing test")).toBeNull();
      expect(screen.queryByRole("button", { name: /tasks hidden/ })).toBeNull();
    });

    it("draws every task's text while Find is open, so Find can match it", () => {
      render(
        <RevealHiddenStepsContext.Provider value>
          <ReplyDetailContext.Provider value="answers">
            <ThreadTasksPanel tasks={{ running: false, tasks }} />
          </ReplyDetailContext.Provider>
        </RevealHiddenStepsContext.Provider>,
      );
      for (const task of tasks) expect(screen.getByText(task.summary)).toBeVisible();
    });

    it("has one control for the hidden tasks, which never hides a waiting task", async () => {
      const user = userEvent.setup();
      render(
        <ReplyDetailContext.Provider value="answers">
          <ThreadTasksPanel tasks={{ running: false, tasks }} />
        </ReplyDetailContext.Provider>,
      );
      await user.click(screen.getByRole("button", { name: "2 tasks hidden" }));
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(screen.getByText("Choose a branch")).toBeVisible();
    });

    it("leaves the Tasks dock panel's list whole", () => {
      render(
        <ReplyDetailContext.Provider value="answers">
          <ThreadTasksPanel alwaysOpen tasks={{ running: false, tasks }} />
        </ReplyDetailContext.Provider>,
      );
      expect(screen.getByText("Watch CI on the branch head")).toBeVisible();
    });
  });
});
