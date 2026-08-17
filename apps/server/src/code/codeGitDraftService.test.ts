import { describe, expect, it } from "vitest";
import { boundedDiff, splitDraft } from "./codeGitDraftService";

describe("splitDraft", () => {
  it("separates the subject from the body", () => {
    expect(splitDraft("Add the unstage button\n\nThe index was the only way back.")).toEqual({
      status: "drafted",
      title: "Add the unstage button",
      body: "The index was the only way back.",
    });
  });

  it("reports a subject with no body rather than an empty one", () => {
    expect(splitDraft("  Fix the stale token check  \n\n")).toEqual({
      status: "drafted",
      title: "Fix the stale token check",
    });
  });

  // Models wrap the answer in a fence despite being told not to; leaving it in
  // would put backticks in a commit subject.
  it("strips a code fence the provider added anyway", () => {
    expect(splitDraft("```\nAdd the unstage button\n\nBody text.\n```")).toEqual({
      status: "drafted",
      title: "Add the unstage button",
      body: "Body text.",
    });
    expect(splitDraft("```text\nOnly a subject\n```")).toEqual({
      status: "drafted",
      title: "Only a subject",
    });
  });

  it("fails rather than offering an empty message", () => {
    expect(splitDraft("   \n\n  ")).toEqual({ status: "failed" });
    expect(splitDraft("```\n\n```")).toEqual({ status: "failed" });
  });
});

describe("boundedDiff", () => {
  it("passes a small diff through untouched", () => {
    const diff = "diff --git a/a.txt b/a.txt\n+one\n";
    expect(boundedDiff(diff)).toEqual({ text: diff, truncated: false });
  });

  it("cuts an oversized diff on a line boundary and says it did", () => {
    const line = `+${"x".repeat(99)}\n`;
    const result = boundedDiff(line.repeat(1_000));

    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("x")).toBe(true);
    expect(result.text.split("\n").every((entry) => entry === "" || entry === line.trimEnd())).toBe(
      true,
    );
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(24_000);
  });
});
