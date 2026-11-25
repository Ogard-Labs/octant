import type { MobileInboxRow } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import { compactAge, projectMonogram, pullRequestChip, threadRowState } from "./threadRowState";

const now = new Date("2026-11-25T12:00:00.000Z");
const row = (fields: Partial<MobileInboxRow> = {}): MobileInboxRow => ({
  hostId: "studio",
  mode: "code",
  threadId: "t",
  title: "t",
  status: "active",
  freshness: "2026-11-25T11:49:00.000Z",
  ...fields,
});

describe("a thread row's state", () => {
  it("says what it waits for before anything else", () => {
    expect(
      threadRowState(
        row({ live: "needs-input", waitingAsk: { label: "Approval", text: "Run npm test" } }),
        now,
      ),
    ).toMatchObject({ kind: "waiting", word: "Approval" });
    expect(threadRowState(row({ live: "needs-input" }), now)).toMatchObject({
      kind: "waiting",
      word: "Needs you",
    });
  });

  it("names a failure, a requested change and a review in words", () => {
    expect(threadRowState(row({ status: "failed" }), now)).toMatchObject({ word: "Failed" });
    expect(threadRowState(row({ reviewState: "changes-requested" }), now)).toMatchObject({
      word: "Changes requested",
    });
    expect(threadRowState(row({ reviewState: "pending" }), now)).toMatchObject({
      kind: "review",
      word: "In review",
    });
  });

  it("says a turn finished until it is opened, unless the thread still waits or runs", () => {
    expect(threadRowState(row({ unread: true, reviewState: "pending" }), now)).toMatchObject({
      kind: "finished",
      word: "Finished",
    });
    expect(threadRowState(row({ unread: true, live: "working" }), now).kind).toBe("working");
    expect(threadRowState(row({ unread: true, live: "needs-input" }), now).kind).toBe("waiting");
    expect(threadRowState(row({ unread: true, status: "failed" }), now).word).toBe("Failed");
  });

  it("shows how long a turn has run, and is spoken as working", () => {
    expect(threadRowState(row({ live: "working" }), now)).toEqual({
      kind: "working",
      word: "11m",
      spoken: "Working, 11m",
    });
  });

  it("shows a quiet thread's age", () => {
    expect(threadRowState(row(), now)).toMatchObject({ kind: "idle", word: "11m" });
  });

  it("shows how long ago a settled thread settled, whatever its last turn left", () => {
    expect(
      threadRowState(row({ status: "failed", completedAt: "2026-11-23T12:00:00.000Z" }), now),
    ).toEqual({ kind: "settled", word: "2d", spoken: "Settled 2d ago" });
  });
});

describe("a row's small marks", () => {
  it("shortens an age", () => {
    expect(compactAge("2026-11-25T11:59:21.000Z", now)).toBe("39s");
    expect(compactAge("2026-11-25T11:16:00.000Z", now)).toBe("44m");
    expect(compactAge("2026-11-25T09:00:00.000Z", now)).toBe("3h");
    expect(compactAge("2026-11-11T12:00:00.000Z", now)).toBe("14d");
    expect(compactAge("not a time", now)).toBe("");
    // A computer whose clock runs ahead never shows a negative age.
    expect(compactAge("2026-11-25T12:00:30.000Z", now)).toBe("0s");
  });

  it("gives a Project two letters", () => {
    expect(projectMonogram("octant")).toBe("OC");
    expect(projectMonogram("octant-site")).toBe("OS");
    expect(projectMonogram("Best Value")).toBe("BV");
    expect(projectMonogram("x")).toBe("X");
    expect(projectMonogram("  ")).toBe("");
  });

  it("shows one pull request's number, and only a count of several", () => {
    expect(pullRequestChip({ number: 2864, count: 1, state: "open" })).toBe("2864");
    expect(pullRequestChip({ number: 2864, count: 3, state: "open" })).toBe("+3");
  });
});
