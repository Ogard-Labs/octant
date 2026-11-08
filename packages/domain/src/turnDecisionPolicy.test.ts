import { describe, expect, it } from "vitest";
import {
  decisionReviewPrompt,
  parseTurnDecision,
  readDecisionReview,
  replyBeforeTurnDecision,
  turnDecisionIsOpen,
} from "./turnDecisionPolicy";

function reply(block: string, before = "The parser fix is in and the tests pass."): string {
  return `${before}\n\n\`\`\`octant-decision\n${block}\n\`\`\`\n`;
}

const ask = "Should I open the pull request now?";

describe("parseTurnDecision", () => {
  it("reads the ask and options a reply closes with", () => {
    expect(
      parseTurnDecision(
        reply(
          JSON.stringify({
            ask,
            options: [{ label: "Open it", recommended: true }, { label: "Wait for review" }],
          }),
        ),
      ),
    ).toEqual({
      ask,
      options: [
        { label: "Open it", recommended: true },
        { label: "Wait for review", recommended: false },
      ],
    });
  });

  it("reads why, urgency and option details, and trims them", () => {
    expect(
      parseTurnDecision(
        reply(
          JSON.stringify({
            ask,
            why: "  Tests are green.  ",
            urgent: true,
            options: [
              { label: "Open it", recommended: true, detail: " Rollback is ready " },
              { label: "Wait" },
            ],
          }),
        ),
      ),
    ).toEqual({
      ask,
      why: "Tests are green.",
      urgent: true,
      options: [
        { label: "Open it", recommended: true, detail: "Rollback is ready" },
        { label: "Wait", recommended: false },
      ],
    });
  });

  it("refuses the whole block when why, urgent or a detail is present but unusable", () => {
    const options = [{ label: "Open it", recommended: true }];
    const refused = (extra: object, detail?: unknown) =>
      parseTurnDecision(
        reply(
          JSON.stringify({
            ask,
            ...extra,
            options: detail === undefined ? options : [{ ...options[0], detail }],
          }),
        ),
      );
    expect(refused({ why: 3 })).toBeUndefined();
    expect(refused({ why: "   " })).toBeUndefined();
    expect(refused({ why: "w".repeat(241) })).toBeUndefined();
    expect(refused({ why: "one\ntwo" })).toBeUndefined();
    expect(refused({ urgent: "yes" })).toBeUndefined();
    expect(refused({}, 3)).toBeUndefined();
    expect(refused({}, "d".repeat(81))).toBeUndefined();
    expect(refused({}, "one\ntwo")).toBeUndefined();
    expect(refused({ urgent: false })?.ask).toBe(ask);
  });

  it("raises nothing for a reply without a marker", () => {
    expect(parseTurnDecision("Done. Nothing here needs you.")).toBeUndefined();
  });

  it("raises nothing when the marker is not the end of the reply", () => {
    const text = `${reply(JSON.stringify({ ask, options: [{ label: "Yes", recommended: true }] }))}And one more thing.`;
    expect(parseTurnDecision(text)).toBeUndefined();
  });

  it("still reads a decision followed only by a follow-up block", () => {
    const text = `${reply(JSON.stringify({ ask, options: [{ label: "Yes", recommended: true }] }))}\`\`\`octant-follow-ups\n{"suggestions":[]}\n\`\`\``;
    expect(parseTurnDecision(text)?.ask).toBe(ask);
  });

  it("reads a decision followed by a follow-up block longer than the tail it reads", () => {
    const prompt = "p".repeat(4_000);
    const followUps = `\`\`\`octant-follow-ups\n${JSON.stringify({
      suggestions: [{ title: "Tests", prompt, target: "new-thread" }],
    })}\n\`\`\``;
    const text = `${reply(JSON.stringify({ ask, options: [{ label: "Yes", recommended: true }] }))}${followUps}\n`;
    expect(parseTurnDecision(text)?.ask).toBe(ask);
  });

  it("refuses more than four options", () => {
    const options = ["a", "b", "c", "d", "e"].map((label, index) => ({
      label,
      recommended: index === 0,
    }));
    expect(parseTurnDecision(reply(JSON.stringify({ ask, options })))).toBeUndefined();
  });

  it("refuses a marker with no recommended option", () => {
    expect(
      parseTurnDecision(reply(JSON.stringify({ ask, options: [{ label: "a" }, { label: "b" }] }))),
    ).toBeUndefined();
  });

  it("refuses a marker with two recommended options", () => {
    expect(
      parseTurnDecision(
        reply(
          JSON.stringify({
            ask,
            options: [
              { label: "a", recommended: true },
              { label: "b", recommended: true },
            ],
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses an ask or option past its bound, and malformed JSON", () => {
    const one = [{ label: "Yes", recommended: true }];
    expect(
      parseTurnDecision(reply(JSON.stringify({ ask: "x".repeat(111), options: one }))),
    ).toBeUndefined();
    expect(
      parseTurnDecision(reply(JSON.stringify({ ask: "First line.\nSecond line?", options: one }))),
    ).toBeUndefined();
    expect(
      parseTurnDecision(
        reply(JSON.stringify({ ask, options: [{ label: "y".repeat(61), recommended: true }] })),
      ),
    ).toBeUndefined();
    expect(
      parseTurnDecision(
        reply(
          JSON.stringify({
            ask,
            options: [{ label: "Same", recommended: true }, { label: "Same" }],
          }),
        ),
      ),
    ).toBeUndefined();
    expect(parseTurnDecision(reply("{not json"))).toBeUndefined();
    expect(parseTurnDecision(reply(JSON.stringify({ ask, options: [] })))).toBeUndefined();
  });
});

describe("turnDecisionIsOpen", () => {
  const open = { latestTurnCompleted: true, archived: false, completed: false, snoozed: false };

  it("is open only while the asking turn is the latest and the thread is in play", () => {
    expect(turnDecisionIsOpen(open)).toBe(true);
    expect(turnDecisionIsOpen({ ...open, latestTurnCompleted: false })).toBe(false);
    expect(turnDecisionIsOpen({ ...open, archived: true })).toBe(false);
    expect(turnDecisionIsOpen({ ...open, completed: true })).toBe(false);
    expect(turnDecisionIsOpen({ ...open, snoozed: true })).toBe(false);
  });
});

describe("a second opinion's reading of a decision", () => {
  const options = ["Open it", "Wait for review"];

  it("reads a bare or fenced JSON reply and returns the option label as written", () => {
    expect(
      readDecisionReview('{"backs":" Wait for review ","reason":"Too soon."}', options),
    ).toEqual({ status: "reviewed", backs: "Wait for review", reason: "Too soon." });
    expect(
      readDecisionReview('```json\n{"backs":"Open it","reason":"It is ready."}\n```', options),
    ).toEqual({ status: "reviewed", backs: "Open it", reason: "It is ready." });
    expect(
      readDecisionReview('```\n{"backs":"Open it","reason":"It is ready."}```', options),
    ).toEqual({ status: "reviewed", backs: "Open it", reason: "It is ready." });
  });

  it("reads a long run of blank fenced lines quickly as unreadable", () => {
    const started = performance.now();
    expect(readDecisionReview(`\`\`\`\n${"\n ".repeat(20_000)}x`, options).status).toBe(
      "unreadable",
    );
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("refuses a label that is not an option, a missing reason, and text that is not JSON", () => {
    expect(readDecisionReview('{"backs":"Ship it","reason":"x"}', options).status).toBe(
      "unreadable",
    );
    expect(readDecisionReview('{"backs":"Open it"}', options).status).toBe("unreadable");
    expect(readDecisionReview("I back Open it.", options).status).toBe("unreadable");
  });

  it("makes the reason one line and shortens a long one on a word boundary", () => {
    const long = `${"word ".repeat(30)}end`;
    const read = readDecisionReview(JSON.stringify({ backs: "Open it", reason: long }), options);
    expect(read.status === "reviewed" && read.reason.length).toBeLessThanOrEqual(100);
    expect(read.status === "reviewed" && read.reason.endsWith("word…")).toBe(true);
    expect(readDecisionReview('{"backs":"Open it","reason":"a\\nb"}', options)).toEqual({
      status: "reviewed",
      backs: "Open it",
      reason: "a b",
    });
  });

  it("takes the end of the reply before the block, without the block or a follow-up block", () => {
    const reply = `${"x".repeat(5000)}Finished the fix.\n\n\`\`\`octant-decision\n{"ask":"Open it?","options":[{"label":"Yes","recommended":true}]}\n\`\`\``;
    const before = replyBeforeTurnDecision(reply);
    expect(before.length).toBe(3000);
    expect(before.endsWith("Finished the fix.")).toBe(true);
    expect(replyBeforeTurnDecision("Nothing asked here.")).toBe("");
  });

  it("puts the options, the recommendation and the preceding text in the prompt", () => {
    const prompt = decisionReviewPrompt({
      decision: {
        ask: "Open it?",
        why: "Friday.",
        options: [
          { label: "Yes", recommended: true, detail: "Fast" },
          { label: "No", recommended: false },
        ],
      },
      context: "Finished.",
    });
    expect(prompt).toContain("- Yes (the agent recommends this): Fast");
    expect(prompt).toContain("- No");
    expect(prompt).toContain("Finished.");
  });
});
