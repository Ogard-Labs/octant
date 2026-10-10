import { describe, expect, it } from "vitest";
import { parseTurnDecision, turnDecisionIsOpen } from "./turnDecisionPolicy";

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
