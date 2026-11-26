import { MAX_THREAD_REPLY_DETAILS } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import {
  effectiveReplyDetail,
  nextReplyDetailLevel,
  replyDetailOpening,
  thinkingPreviewLine,
  withThreadReplyDetail,
} from "./replyDetailPolicy";

const work = { mode: "work", threadId: "thread-1" } as const;

describe("a thread's Reply detail level", () => {
  it("follows the default until the thread chooses, and keeps its choice when the default moves", () => {
    expect(effectiveReplyDetail({ defaultLevel: "medium", threads: [] }, work)).toBe("medium");
    const threads = withThreadReplyDetail([], work, "high");
    expect(effectiveReplyDetail({ defaultLevel: "low", threads }, work)).toBe("high");
    expect(effectiveReplyDetail({ defaultLevel: "medium", threads }, work)).toBe("high");
  });

  it("tells threads in different modes apart even when their ids match", () => {
    const threads = withThreadReplyDetail([], work, "high");
    expect(effectiveReplyDetail({ defaultLevel: "low", threads }, { ...work, mode: "chat" })).toBe(
      "low",
    );
  });

  it("returns to the default when the thread is set back to use it", () => {
    const threads = withThreadReplyDetail(withThreadReplyDetail([], work, "high"), work, undefined);
    expect(threads).toEqual([]);
    expect(effectiveReplyDetail({ defaultLevel: "medium", threads }, work)).toBe("medium");
  });

  it("drops the longest-standing choice rather than growing past the bound", () => {
    let threads = withThreadReplyDetail([], { mode: "chat", threadId: "first" }, "high");
    for (let index = 1; index < MAX_THREAD_REPLY_DETAILS; index += 1) {
      threads = withThreadReplyDetail(threads, { mode: "chat", threadId: `t-${index}` }, "medium");
    }
    expect(threads).toHaveLength(MAX_THREAD_REPLY_DETAILS);
    const next = withThreadReplyDetail(threads, work, "low");
    expect(next).toHaveLength(MAX_THREAD_REPLY_DETAILS);
    expect(next.some((entry) => entry.threadId === "first")).toBe(false);
    expect(next.at(-1)).toEqual({ ...work, level: "low" });
  });

  it("steps from Answers only through Failures only, Low, Medium and High, then back", () => {
    expect(nextReplyDetailLevel("answers")).toBe("failures");
    expect(nextReplyDetailLevel("failures")).toBe("low");
    expect(nextReplyDetailLevel("low")).toBe("medium");
    expect(nextReplyDetailLevel("medium")).toBe("high");
    expect(nextReplyDetailLevel("high")).toBe("answers");
  });

  it("hides steps only at the two quiet levels, folded like Low", () => {
    expect(replyDetailOpening("answers")).toEqual({ ...replyDetailOpening("low"), hides: "steps" });
    expect(replyDetailOpening("failures").hides).toBe("succeeded-calls");
    expect(replyDetailOpening("low").hides).toBe("nothing");
    expect(replyDetailOpening("high").hides).toBe("nothing");
  });

  it("keeps a quiet level per thread like any other", () => {
    const threads = withThreadReplyDetail([], work, "answers");
    expect(effectiveReplyDetail({ defaultLevel: "high", threads }, work)).toBe("answers");
  });
});

describe("the thinking preview line", () => {
  it("reads the first non-empty line as plain words", () => {
    expect(thinkingPreviewLine("\n## **Check** the `suite`\nthen more")).toBe("Check the suite");
  });

  it("bounds a long line", () => {
    const line = thinkingPreviewLine("word ".repeat(100));
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.endsWith("…")).toBe(true);
  });
});
