import { describe, expect, it } from "vitest";
import { samePollingData } from "./samePollingData";

describe("samePollingData", () => {
  it("keeps object identity when two decoded snapshots describe the same data", () => {
    const left = {
      threads: [{ id: "a", title: "Notes", activity: 3 }],
      activity: [{ threadId: "a", lastSequence: 3 }],
    };
    const right = {
      threads: [{ id: "a", title: "Notes", activity: 3 }],
      activity: [{ threadId: "a", lastSequence: 3 }],
    };
    expect(samePollingData(left, right)).toBe(true);
    expect(
      samePollingData(left, { ...right, activity: [{ threadId: "a", lastSequence: 4 }] }),
    ).toBe(false);
  });

  it("treats equal arrays as the same regardless of allocation", () => {
    expect(samePollingData(["ready", "waiting"], ["ready", "waiting"])).toBe(true);
    expect(samePollingData(["ready"], ["waiting"])).toBe(false);
  });
});
