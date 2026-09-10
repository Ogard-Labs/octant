import { describe, expect, it } from "vitest";
import {
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
