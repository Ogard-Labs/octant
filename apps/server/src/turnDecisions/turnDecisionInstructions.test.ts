import { parseTurnDecision } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { TURN_DECISION_INSTRUCTIONS, turnDecisionInstructions } from "./turnDecisionInstructions";

describe("turn decision instructions", () => {
  it("asks Work and Code turns for the closing block, and Chat turns for nothing", () => {
    expect(turnDecisionInstructions("work")).toEqual([TURN_DECISION_INSTRUCTIONS]);
    expect(turnDecisionInstructions("code")).toEqual([TURN_DECISION_INSTRUCTIONS]);
    expect(turnDecisionInstructions("chat")).toEqual([]);
  });

  it("shows a block the host's own parser reads", () => {
    const example = TURN_DECISION_INSTRUCTIONS.text.match(/```octant-decision\n[^\n]*\n```/)?.[0];
    expect(example).toBeDefined();
    const filled = (example ?? "")
      .replace(
        '"label":"...","detail":"...","recommended"',
        '"label":"Ship","detail":"Now","recommended"',
      )
      .replace('"label":"...","detail":"..."}', '"label":"Wait","detail":"Later"}')
      .replaceAll("...", "Go ahead");
    expect(parseTurnDecision(`Done.\n\n${filled}`)).toMatchObject({
      ask: "Go ahead",
      why: "Go ahead",
      urgent: true,
      options: [
        { label: "Ship", detail: "Now", recommended: true },
        { label: "Wait", detail: "Later", recommended: false },
      ],
    });
  });
});
