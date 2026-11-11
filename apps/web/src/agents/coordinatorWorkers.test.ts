import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { coordinatorWorkersOf } from "./coordinatorWorkers";

const coordinator: ChatThreadNavigationItem = {
  threadId: "coordinator",
  title: "Backlog",
  coordinator: true,
};

function worker(
  threadId: string,
  more: Partial<ChatThreadNavigationItem> = {},
): ChatThreadNavigationItem {
  return { threadId, title: `Worker ${threadId}`, coordinatorThreadId: "coordinator", ...more };
}

describe("coordinatorWorkersOf", () => {
  it("names a coordinator's workers with the state the thread list shows for each", () => {
    const workers = coordinatorWorkersOf(
      [
        coordinator,
        worker("a", {
          activity: "working",
          provider: { driverKind: "codex", displayName: "Codex" },
        }),
        worker("b", { activity: "attention" }),
        worker("c", { completedAt: "2026-11-10T12:00:00.000Z" }),
        worker("d", { unread: true }),
        // Another coordinator's worker, and an ordinary thread.
        { threadId: "e", title: "Elsewhere", coordinatorThreadId: "other" },
        { threadId: "f", title: "On its own" },
      ],
      "coordinator",
    );

    expect(workers).toEqual([
      {
        threadId: "a",
        title: "Worker a",
        provider: { driverKind: "codex", displayName: "Codex" },
        state: "working",
      },
      { threadId: "b", title: "Worker b", state: "attention" },
      { threadId: "c", title: "Worker c", state: "done" },
      { threadId: "d", title: "Worker d", state: "idle" },
    ]);
  });

  it("names none for a thread that is not a coordinator, even one other threads point at", () => {
    const threads = [{ ...coordinator, coordinator: false }, worker("a")];

    expect(coordinatorWorkersOf(threads, "coordinator")).toBeUndefined();
    expect(coordinatorWorkersOf([coordinator, worker("a")], "a")).toBeUndefined();
    expect(coordinatorWorkersOf([coordinator, worker("a")], undefined)).toBeUndefined();
  });

  it("names none for a coordinator that has started no workers", () => {
    expect(coordinatorWorkersOf([coordinator], "coordinator")).toBeUndefined();
  });
});
