import { describe, expect, it } from "vitest";
import { CircleHelp } from "../ui/icons";
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

  it("says Input with its own mark when the thread waits on an answer, and Needs you for an approval", () => {
    const input = threadRowState({ ...row, activity: "attention", awaitingKind: "user-input" });
    expect(input.state).toMatchObject({ status: "attention", text: "Input", icon: CircleHelp });
    expect(
      threadRowState({ ...row, activity: "attention", awaitingKind: "approval" }).state?.text,
    ).toBe("Needs you");
  });

  it("says Needs you first when the thread also waits on the person", () => {
    expect(threadRowState({ ...row, activity: "attention", limited: {} }).state?.text).toBe(
      "Needs you",
    );
  });
});
