import { describe, expect, it } from "vitest";
import {
  formatChord,
  matchKeybinding,
  matchPageKeybinding,
  parseChord,
  parseKeybindingOverrides,
  resolveKeybindings,
} from "./keybindings";

const keyEvent = (
  key: string,
  modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
) => ({
  key,
  metaKey: modifiers.meta === true,
  ctrlKey: modifiers.ctrl === true,
  shiftKey: modifiers.shift === true,
  altKey: modifiers.alt === true,
});

describe("parseChord", () => {
  it("reads modifiers in any order and any casing", () => {
    expect(parseChord("shift+MOD+f")).toEqual({
      status: "ok",
      chord: { mod: true, shift: true, alt: false, key: "f" },
    });
    expect(formatChord({ mod: true, shift: true, alt: true, key: "f" })).toBe("Mod+Alt+Shift+F");
  });

  it("refuses a chord that would swallow ordinary typing", () => {
    // Unqualified or Shift-only keys are what a text field receives.
    expect(parseChord("k")).toMatchObject({ status: "invalid" });
    expect(parseChord("Shift+K")).toMatchObject({ status: "invalid" });
    expect(parseChord("Mod+Escape")).toMatchObject({ status: "invalid" });
    expect(parseChord("Mod+Tab")).toMatchObject({ status: "invalid" });
    expect(parseChord("Mod")).toMatchObject({ status: "invalid" });
    expect(parseChord("Mod+K+P")).toMatchObject({ status: "invalid" });
  });
});

describe("resolveKeybindings", () => {
  it("binds every action even when an override is unusable", () => {
    const resolved = resolveKeybindings({
      "command-palette": "Mod+J",
      "code-file-search": "p",
      "not-an-action": "Mod+Y",
    });

    expect(formatChord(resolved.bindings.get("command-palette")!)).toBe("Mod+J");
    // A rejected override falls back to the default rather than unbinding it.
    expect(formatChord(resolved.bindings.get("code-file-search")!)).toBe("Mod+P");
    expect(resolved.rejected).toEqual([
      expect.objectContaining({ actionId: "code-file-search" }),
      expect.objectContaining({ actionId: "not-an-action", reason: "No such action." }),
    ]);
    expect(resolved.conflicts).toEqual([]);
  });

  it("reports two actions that ended up on the same chord", () => {
    const resolved = resolveKeybindings({ "code-file-search": "Mod+K" });

    expect(resolved.conflicts).toEqual([
      { chord: "Mod+K", actionIds: ["command-palette", "code-file-search"] },
    ]);
    // The collision is reported, not silently resolved by dropping a binding.
    expect(formatChord(resolved.bindings.get("code-file-search")!)).toBe("Mod+K");
  });
});

describe("matchKeybinding", () => {
  const bindings = resolveKeybindings();

  it("matches the platform's own meaning of Mod", () => {
    expect(matchKeybinding(bindings, keyEvent("k", { meta: true }), true)).toBe("command-palette");
    // Control is Cocoa text editing on Apple hardware; it never stands for Mod.
    expect(matchKeybinding(bindings, keyEvent("k", { ctrl: true }), true)).toBeUndefined();
    expect(matchKeybinding(bindings, keyEvent("k", { ctrl: true }), false)).toBe("command-palette");
  });

  it("separates chords that differ only by Shift", () => {
    expect(matchKeybinding(bindings, keyEvent("f", { meta: true, shift: true }), true)).toBe(
      "code-content-search",
    );
    expect(matchKeybinding(bindings, keyEvent("f", { meta: true }), true)).toBeUndefined();
    expect(matchKeybinding(bindings, keyEvent("p", { meta: true, shift: true }), true)).toBe(
      undefined,
    );
  });

  it("never matches an unqualified key", () => {
    expect(matchKeybinding(bindings, keyEvent("k"), true)).toBeUndefined();
  });

  it("opens context usage on the configured chord", () => {
    expect(matchKeybinding(bindings, keyEvent("u", { meta: true, shift: true }), true)).toBe(
      "context-usage",
    );
  });

  it("runs the override rather than the default once one is set", () => {
    const rebound = resolveKeybindings({ "command-palette": "Alt+Shift+K" });

    expect(matchKeybinding(rebound, keyEvent("k", { meta: true }), true)).toBeUndefined();
    expect(matchKeybinding(rebound, keyEvent("k", { alt: true, shift: true }), true)).toBe(
      "command-palette",
    );
  });
});

describe("a page's own commands", () => {
  const bindings = resolveKeybindings();

  it("answers to bare keys on that page and nowhere else", () => {
    expect(matchPageKeybinding(bindings, "review", keyEvent("j"), true)).toBe("review-next");
    expect(matchPageKeybinding(bindings, "review", keyEvent("Enter"), true)).toBe("review-open");
    // The window-level matcher never runs a page's command, bare or qualified.
    expect(matchKeybinding(bindings, keyEvent("j"), true)).toBeUndefined();
    const rebound = resolveKeybindings({ "review-next": "Mod+J" });
    expect(matchKeybinding(rebound, keyEvent("j", { meta: true }), true)).toBeUndefined();
    expect(matchPageKeybinding(rebound, "review", keyEvent("j", { meta: true }), true)).toBe(
      "review-next",
    );
  });

  it("lets a page action be rebound to another bare key but still refuses Escape and Tab", () => {
    expect(parseChord("x", { page: true })).toMatchObject({ status: "ok" });
    expect(parseChord("Escape", { page: true })).toMatchObject({ status: "invalid" });
    expect(parseChord("Tab", { page: true })).toMatchObject({ status: "invalid" });
    const resolved = resolveKeybindings({ "review-complete": "x", "command-palette": "x" });
    expect(formatChord(resolved.bindings.get("review-complete")!)).toBe("X");
    // A global action still cannot be a bare key.
    expect(formatChord(resolved.bindings.get("command-palette")!)).toBe("Mod+K");
  });
});

describe("parseKeybindingOverrides", () => {
  it("accepts an object of chords and an empty document", () => {
    expect(parseKeybindingOverrides('{"command-palette":"Mod+J"}')).toEqual({
      status: "ok",
      overrides: { "command-palette": "Mod+J" },
    });
    expect(parseKeybindingOverrides("  ")).toEqual({ status: "ok", overrides: {} });
  });

  it("refuses a malformed document whole rather than applying half of it", () => {
    expect(parseKeybindingOverrides("{")).toMatchObject({ status: "invalid" });
    expect(parseKeybindingOverrides('["Mod+J"]')).toMatchObject({ status: "invalid" });
    expect(parseKeybindingOverrides('{"command-palette":3}')).toMatchObject({ status: "invalid" });
  });
});
