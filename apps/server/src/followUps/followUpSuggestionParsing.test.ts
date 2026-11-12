import { describe, expect, it } from "vitest";
import { parseFollowUpSuggestions } from "./followUpSuggestionParsing";

const turnId = "00000000-0000-4000-8000-000000000031" as never;
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

describe("follow-up suggestions in a reply", () => {
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
    const set = parseFollowUpSuggestions({ text, turnId, uuid }).followUps;
    expect(set?.suggestions.map((suggestion) => suggestion.title)).toEqual([
      "Add tests",
      "Docs",
      "Bench",
    ]);
  });

  it("suggests nothing for a reply without the block, or with a block it cannot read", () => {
    const none = { followUps: undefined, nextMessage: undefined };
    expect(parseFollowUpSuggestions({ text: "All done.", turnId, uuid })).toEqual(none);
    expect(
      parseFollowUpSuggestions({ text: "```octant-follow-ups\nnot json\n```", turnId, uuid }),
    ).toEqual(none);
    expect(
      parseFollowUpSuggestions({
        text: '```octant-follow-ups\n{"suggestions":[{"title":"x","prompt":"y","target":"elsewhere"}]}\n```',
        turnId,
        uuid,
      }),
    ).toEqual(none);
  });

  it("reads the predicted next message even when the reply offers no task", () => {
    const parsed = parseFollowUpSuggestions({
      text: '```octant-follow-ups\n{"next":"  yes, move the captures to the NAS  ","suggestions":[]}\n```',
      turnId,
      uuid,
    });
    expect(parsed).toEqual({
      followUps: { turnId, suggestions: [] },
      nextMessage: "yes, move the captures to the NAS",
    });
  });

  it("keeps the next message when the task list is unreadable, and drops a next message no one would type", () => {
    expect(
      parseFollowUpSuggestions({
        text: '```octant-follow-ups\n{"next":"run the tests","suggestions":[{"title":"x","prompt":"y","target":"elsewhere"}]}\n```',
        turnId,
        uuid,
      }).nextMessage,
    ).toBe("run the tests");
    for (const next of ["two\nlines", "x".repeat(281), "   ", 42]) {
      expect(
        parseFollowUpSuggestions({
          text: `\`\`\`octant-follow-ups\n${JSON.stringify({ next, suggestions: [] })}\n\`\`\``,
          turnId,
          uuid,
        }),
      ).toEqual({ followUps: undefined, nextMessage: undefined });
    }
  });
});
