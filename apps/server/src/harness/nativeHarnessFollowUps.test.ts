import { describe, expect, it } from "vitest";
import { parseNativeHarnessFollowUps, stripNativeHarnessFollowUps } from "./nativeHarnessFollowUps";

const turnId = "00000000-0000-4000-8000-000000000031" as never;
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

describe("native harness follow-ups", () => {
  it("reads up to three suggestions from the fenced block at the end of a reply", () => {
    const text = [
      "Done. The parser now handles nested lists.",
      "```octant-follow-ups",
      JSON.stringify({
        suggestions: [
          {
            title: "Add tests",
            prompt: "Write tests for nested lists in the parser.",
            target: "new-thread",
          },
          { title: "Docs", prompt: "Document the nested list syntax.", target: "same-thread" },
          { title: "Bench", prompt: "Benchmark parse time.", target: "new-worktree" },
          { title: "Fourth", prompt: "Should be dropped.", target: "same-thread" },
        ],
      }),
      "```",
    ].join("\n");
    const set = parseNativeHarnessFollowUps({ text, turnId, uuid });
    expect(set?.suggestions.map((suggestion) => suggestion.title)).toEqual([
      "Add tests",
      "Docs",
      "Bench",
    ]);
    expect(stripNativeHarnessFollowUps(text)).toBe("Done. The parser now handles nested lists.");
  });

  it("suggests nothing for a reply without the block, or with a block it cannot read", () => {
    expect(parseNativeHarnessFollowUps({ text: "All done.", turnId, uuid })).toBeUndefined();
    expect(
      parseNativeHarnessFollowUps({ text: "```octant-follow-ups\nnot json\n```", turnId, uuid }),
    ).toBeUndefined();
    expect(
      parseNativeHarnessFollowUps({
        text: '```octant-follow-ups\n{"suggestions":[{"title":"x","prompt":"y","target":"elsewhere"}]}\n```',
        turnId,
        uuid,
      }),
    ).toBeUndefined();
  });
});
