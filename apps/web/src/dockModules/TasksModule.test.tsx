import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import TasksModule from "./TasksModule";
import type { ThreadTaskProgress } from "../transcript/ThreadTasksPanel";
import { usePublishThreadTaskList } from "../transcript/threadTaskLists";

afterEach(cleanup);

function ThreadView(props: { readonly threadId: string; readonly tasks?: ThreadTaskProgress }) {
  usePublishThreadTaskList(props.threadId, props.tasks);
  return null;
}

const settled: ThreadTaskProgress = {
  running: false,
  tasks: [
    { id: "1", state: "completed", summary: "Read the failing test" },
    { id: "2", state: "pending", summary: "Fix the parser" },
  ],
};

it("keeps the thread's newest task list open beside it, even once the turn settled", () => {
  render(
    <>
      <ThreadView tasks={settled} threadId="thread-a" />
      <TasksModule subject={{ mode: "code", threadId: "thread-a" }} />
    </>,
  );
  expect(screen.getByText("1 of 2 tasks completed")).toBeVisible();
  expect(screen.getByRole("list", { name: "Task list" })).toBeVisible();
  expect(screen.getByText("Fix the parser")).toBeVisible();
});

it("shows only its own thread's list, and says so when that thread has none", () => {
  render(
    <>
      <ThreadView tasks={settled} threadId="thread-a" />
      <ThreadView threadId="thread-b" />
      <TasksModule subject={{ mode: "work", threadId: "thread-b" }} />
    </>,
  );
  expect(screen.getByText("No task list yet")).toBeVisible();
  expect(screen.queryByText("Fix the parser")).not.toBeInTheDocument();
});

it("keeps the list while another pane still shows the thread after one closes", () => {
  const { rerender } = render(
    <>
      <ThreadView key="left" tasks={settled} threadId="thread-a" />
      <ThreadView key="right" tasks={settled} threadId="thread-a" />
      <TasksModule subject={{ mode: "chat", threadId: "thread-a" }} />
    </>,
  );
  rerender(
    <>
      <ThreadView key="right" tasks={settled} threadId="thread-a" />
      <TasksModule subject={{ mode: "chat", threadId: "thread-a" }} />
    </>,
  );
  expect(screen.getByText("1 of 2 tasks completed")).toBeVisible();

  rerender(<TasksModule subject={{ mode: "chat", threadId: "thread-a" }} />);
  expect(screen.getByText("No task list yet")).toBeVisible();
});

it("follows the pane that published last, whichever pane mounted first", () => {
  const done: ThreadTaskProgress = {
    running: false,
    tasks: settled.tasks.map((task) => ({ ...task, state: "completed" as const })),
  };
  const { rerender } = render(
    <>
      <ThreadView key="left" tasks={settled} threadId="thread-a" />
      <ThreadView key="right" tasks={settled} threadId="thread-a" />
      <TasksModule subject={{ mode: "code", threadId: "thread-a" }} />
    </>,
  );
  rerender(
    <>
      <ThreadView key="left" tasks={done} threadId="thread-a" />
      <ThreadView key="right" tasks={settled} threadId="thread-a" />
      <TasksModule subject={{ mode: "code", threadId: "thread-a" }} />
    </>,
  );
  expect(screen.getByText("2 of 2 tasks completed")).toBeVisible();
});
