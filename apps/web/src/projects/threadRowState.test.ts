import { describe, expect, it } from "vitest";
import { CircleAlert, CirclePause } from "../ui/icons";
import { threadRowState } from "./threadRowState";

const now = Date.parse("2026-07-19T11:00:00.000Z");
const row = { activity: "idle" as const, unread: false, woke: false, now };

describe("a sidebar row stopped on a usage limit", () => {
  it("reads Limited 2h while a known reset is two hours away", () => {
    const { state, label } = threadRowState({
      ...row,
      limited: { resetsAt: "2026-07-19T13:00:00.000Z" as never },
    });
    expect(state).toMatchObject({ status: "limited", text: "Limited 2h" });
    expect(state?.icon).toBeDefined();
    expect(label).toBe("Limited");
  });

  it("reads Limited with no reset", () => {
    expect(threadRowState({ ...row, limited: {} }).state?.text).toBe("Limited");
  });

  it("says nothing of the limit once the reset has passed", () => {
    expect(
      threadRowState({ ...row, limited: { resetsAt: "2026-07-19T10:59:00.000Z" as never } }),
    ).toEqual({ unread: false });
  });

  it("says Needs you first when the thread also waits on the person", () => {
    expect(threadRowState({ ...row, activity: "attention", limited: {} }).state?.text).toBe(
      "Needs you",
    );
  });
});

describe("a sidebar row's short age beside its status mark", () => {
  it("reads a Needs-you row's age from when the thread last moved and keeps the word for its name", () => {
    const { state } = threadRowState({
      ...row,
      activity: "attention",
      updatedAt: "2026-07-19T10:55:00.000Z",
    });
    expect(state).toMatchObject({ status: "attention", text: "Needs you", age: "5m" });
    expect(state?.icon).toBe(CirclePause);
  });

  it("gives a running row the time its turn has run, and none in its first minute", () => {
    expect(
      threadRowState({ ...row, activity: "working", startedAt: "2026-07-19T10:46:00.000Z" }).state,
    ).toMatchObject({ status: "working", text: "Working 14m", age: "14m" });
    expect(
      threadRowState({ ...row, activity: "working", startedAt: "2026-07-19T10:59:40.000Z" }).state
        ?.age,
    ).toBeUndefined();
  });

  it("counts a limited row down to its reset and keeps the alert mark", () => {
    const { state } = threadRowState({
      ...row,
      limited: { resetsAt: "2026-07-19T13:00:00.000Z" as never },
    });
    expect(state).toMatchObject({ text: "Limited 2h", age: "2h" });
    expect(state?.icon).toBe(CircleAlert);
  });
});
