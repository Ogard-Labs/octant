import { describe, expect, it } from "vitest";
import {
  decodeThreadTaskProgress,
  decodeThreadTaskProgressList,
  MAX_THREAD_TASKS_PER_TURN,
  restateThreadTaskList,
  upsertThreadTaskProgress,
} from "./threadTasks";

const task = {
  taskId: "task-1",
  state: "running",
  summary: "Watch CI on the branch head",
} as const;

describe("the thread task progress contract", () => {
  it("accepts one provider-reported task with its own id and wording", () => {
    expect(decodeThreadTaskProgress(task)).toEqual(task);
  });

  it("refuses a summary longer than the turn record holds", () => {
    expect(() => decodeThreadTaskProgress({ ...task, summary: "x".repeat(2_049) })).toThrow();
  });

  it("refuses a list that carries more tasks than one turn may hold", () => {
    expect(() =>
      decodeThreadTaskProgressList(
        Array.from({ length: MAX_THREAD_TASKS_PER_TURN + 1 }, (_unused, index) => ({
          taskId: `task-${String(index)}`,
          state: "pending" as const,
          summary: `Task ${String(index)}`,
        })),
      ),
    ).toThrow();
  });

  it("updates a restated task in place rather than appending a second row", () => {
    const list = decodeThreadTaskProgressList([task]);
    expect(upsertThreadTaskProgress(list, { ...task, state: "completed" })).toEqual([
      { ...task, state: "completed" },
    ]);
  });

  it("keeps the newest task's own wording for the panel", () => {
    const list = decodeThreadTaskProgressList([task]);
    expect(
      upsertThreadTaskProgress(list, { ...task, state: "running", summary: "CI is in progress" }),
    ).toEqual([{ ...task, state: "running", summary: "CI is in progress" }]);
  });

  it("stops appending once the list is full instead of decoding a refusal later", () => {
    let list = decodeThreadTaskProgressList(
      Array.from({ length: MAX_THREAD_TASKS_PER_TURN }, (_unused, index) => ({
        taskId: `task-${String(index)}`,
        state: "pending" as const,
        summary: `Task ${String(index)}`,
      })),
    );
    list = upsertThreadTaskProgress(list, {
      taskId: "task-extra",
      state: "pending",
      summary: "One task too many",
    });
    expect(list).toHaveLength(MAX_THREAD_TASKS_PER_TURN);
    expect(list.some((entry) => entry.taskId === "task-extra")).toBe(false);
  });

  it("keeps only the tasks a restated plan lists, in its order", () => {
    const list = decodeThreadTaskProgressList([
      task,
      { taskId: "task-2", state: "pending", summary: "Write the note" },
      { taskId: "task-3", state: "pending", summary: "Dropped step" },
    ]);
    expect(restateThreadTaskList(list, ["task-2", "task-1"]).map(({ taskId }) => taskId)).toEqual([
      "task-2",
      "task-1",
    ]);
    expect(restateThreadTaskList(list, [])).toEqual([]);
    // An unchanged plan returns the same list, so callers skip a needless journal write.
    expect(restateThreadTaskList(list, ["task-1", "task-2", "task-3"])).toBe(list);
  });

  it("makes room in a full plan for the new tasks its restatement lists", () => {
    const full = decodeThreadTaskProgressList(
      Array.from({ length: MAX_THREAD_TASKS_PER_TURN }, (_unused, index) => ({
        taskId: `task-${String(index)}`,
        state: "pending" as const,
        summary: `Task ${String(index)}`,
      })),
    );
    const renamed = { taskId: "task-new", state: "running" as const, summary: "Renamed step" };
    // The full plan turns the new task away before the restatement arrives.
    expect(upsertThreadTaskProgress(full, renamed)).toBe(full);

    const restated = restateThreadTaskList(
      full,
      ["task-0", "task-new"],
      new Map([[renamed.taskId, renamed]]),
    );
    expect(restated).toEqual([full[0], renamed]);
  });
});
