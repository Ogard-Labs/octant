import { describe, expect, it } from "vitest";
import {
  COMPUTER_TOOL_HOST_LINE,
  computerUseSelection,
  validateComputerUseSelection,
  COMPUTER_USE_PLUGIN,
} from "./computerUsePlugin";

describe("Computer use selection", () => {
  it("admits the bundled plugin only while enabled and refuses a substituted package", () => {
    const selection = computerUseSelection("composer");
    expect(COMPUTER_USE_PLUGIN.displayName).toBe("Computer use");
    expect(validateComputerUseSelection(selection, true)).toBe(true);
    expect(validateComputerUseSelection(selection, false)).toBe(false);
    expect(
      validateComputerUseSelection(
        { ...selection, packageDigest: `sha256:${"0".repeat(64)}` },
        true,
      ),
    ).toBe(false);
  });
});

describe("Computer host line", () => {
  it("names the tool and its ask-first rule within 40 tokens", () => {
    expect(COMPUTER_TOOL_HOST_LINE).toContain("octant_computer");
    expect(COMPUTER_TOOL_HOST_LINE).toContain("asks the person first");
    expect(Math.ceil(COMPUTER_TOOL_HOST_LINE.length / 4)).toBeLessThanOrEqual(40);
  });
});
