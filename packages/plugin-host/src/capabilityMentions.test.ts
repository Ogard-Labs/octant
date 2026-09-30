import { describe, expect, it } from "vitest";
import {
  unattachedCapabilityMentionCopy,
  unattachedCapabilityMentions,
} from "./capabilityMentions";
import { browserUseSelection } from "./browserUsePlugin";
import { computerUseSelection } from "./computerUsePlugin";

describe("unattached capability mentions", () => {
  it.each([
    "@computer describe my screen",
    "open @computer and describe my screen",
    "@Browser open the docs",
    "draft ends with @computer",
  ])("flags the token when no selection carries it: %s", (prompt) => {
    expect(unattachedCapabilityMentions(prompt, [])).toHaveLength(1);
  });

  it("flags every unattached token in one draft", () => {
    expect(unattachedCapabilityMentions("@computer and @browser", [])).toEqual([
      { label: "Computer", token: "@computer" },
      { label: "Browser", token: "@browser" },
    ]);
  });

  it("passes a token the send's selections attach", () => {
    expect(
      unattachedCapabilityMentions("@computer describe my screen", [
        computerUseSelection("9f2c2f2e-2f2a-4f2a-8f2a-2f2a2f2a2f2a"),
      ]),
    ).toEqual([]);
    expect(
      unattachedCapabilityMentions("@browser open the docs", [
        browserUseSelection("9f2c2f2e-2f2a-4f2a-8f2a-2f2a2f2a2f2a"),
      ]),
    ).toEqual([]);
  });

  it.each([
    "@computers are faster than @browsers",
    "email me@computer.example.org",
    "mention @build-tools instead",
    "use $review on this",
    "plain text with no token",
    "",
  ])("leaves ordinary prose alone: %s", (prompt) => {
    expect(unattachedCapabilityMentions(prompt, [])).toEqual([]);
  });

  it("names the tokens the person should pick or remove", () => {
    expect(unattachedCapabilityMentionCopy([{ label: "Computer", token: "@computer" }])).toBe(
      "@Computer is not attached to this message. Pick the mention from the suggestion list, or remove the token, then send again.",
    );
    expect(
      unattachedCapabilityMentionCopy([
        { label: "Computer", token: "@computer" },
        { label: "Browser", token: "@browser" },
      ]),
    ).toContain("@Computer and @Browser are not attached");
  });
});
