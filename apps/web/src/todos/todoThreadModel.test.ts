import { describe, expect, it } from "vitest";
import { todoThreadState } from "./todoThreadModel";

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
});
