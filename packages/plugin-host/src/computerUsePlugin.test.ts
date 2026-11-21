import { describe, expect, it } from "vitest";
import {
  COMPUTER_TOOL_HOST_LINE,
  computerUseSelection,
  isComputerUseSelection,
  computerUsePluginManifest,
} from "./computerUsePlugin";

describe("Computer use selection", () => {
  it("recognizes a selection from an older draft so a send can ignore it", () => {
    expect(computerUsePluginManifest().displayName).toBe("Computer use");
    expect(isComputerUseSelection(computerUseSelection("older-draft"))).toBe(true);
  });
});

describe("Computer host line", () => {
  it("names the tool and its conditional approval rule within 40 tokens", () => {
    expect(COMPUTER_TOOL_HOST_LINE).toContain("octant_computer");
    expect(COMPUTER_TOOL_HOST_LINE).toContain("Octant may ask the person before acting on an app");
    expect(COMPUTER_TOOL_HOST_LINE).not.toContain("first action on each app asks");
    expect(Math.ceil(COMPUTER_TOOL_HOST_LINE.length / 4)).toBeLessThanOrEqual(40);
  });
});
