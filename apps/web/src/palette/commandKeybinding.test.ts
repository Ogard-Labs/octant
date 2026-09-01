import { describe, expect, it } from "vitest";
import { keybindingActionForCommand } from "./commandKeybinding";

describe("keybindingActionForCommand", () => {
  it("maps a command that shares a user-bindable chord", () => {
    expect(keybindingActionForCommand("workspace:zen-mode")).toBe("zen-mode");
    expect(keybindingActionForCommand("code:file-search")).toBe("code-file-search");
  });

  it("leaves navigation commands without a badge", () => {
    expect(keybindingActionForCommand("settings:open")).toBeUndefined();
    expect(keybindingActionForCommand("thread:search")).toBeUndefined();
  });
});
