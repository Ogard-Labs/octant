import { describe, expect, it } from "vitest";
import {
  COMPUTER_TOOL_HOST_LINE,
  computerUseSelection,
  isComputerUseSelection,
  COMPUTER_USE_PLUGIN,
} from "./computerUsePlugin";

describe("Computer use selection", () => {
  it("recognizes a selection from an older draft so a send can ignore it", () => {
    expect(COMPUTER_USE_PLUGIN.displayName).toBe("Computer use");
    expect(isComputerUseSelection(computerUseSelection("older-draft"))).toBe(true);
  });
});

describe("Computer host line", () => {
  it("names the tool and its ask-first rule within 40 tokens", () => {
    expect(COMPUTER_TOOL_HOST_LINE).toContain("octant_computer");
    expect(COMPUTER_TOOL_HOST_LINE).toContain("asks the person first");
    expect(Math.ceil(COMPUTER_TOOL_HOST_LINE.length / 4)).toBeLessThanOrEqual(40);
  });
});
