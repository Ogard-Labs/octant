import { describe, expect, it } from "vitest";
import { todoThreadKey, todoThreadStates, todoThreadState } from "./todoThreadModel";

describe("a to-do's thread badge", () => {
  const row = { threadId: "t", title: "Fix it" };

  it("reads Done before anything else, then Running, then Waiting on you", () => {
    expect(
      todoThreadState({ ...row, activity: "working", completedAt: "2026-11-14T10:00:00.000Z" })
        .label,
    ).toBe("Done");
    expect(todoThreadState({ ...row, markedDone: true }).label).toBe("Done");
    expect(todoThreadState({ ...row, activity: "working" }).label).toBe("Running");
    expect(todoThreadState({ ...row, activity: "attention" }).label).toBe("Waiting on you");
    expect(todoThreadState({ ...row, awaitingKind: "approval" }).label).toBe("Waiting on you");
    expect(todoThreadState(row).label).toBe("Started");
  });
  it("does not show a local thread's state for the same id on another computer", () => {
    const local = "11111111-1111-4111-8111-111111111111";
    const remote = "22222222-2222-4222-8222-222222222222";
    const states = todoThreadStates(local, [
      { mode: "code", rows: [{ ...row, markedDone: true }] },
    ]);
    expect(states.get(todoThreadKey({ hostId: local, mode: "code", threadId: "t" }))?.label).toBe(
      "Done",
    );
    expect(
      states.get(todoThreadKey({ hostId: remote, mode: "code", threadId: "t" })),
    ).toBeUndefined();
  });
});
