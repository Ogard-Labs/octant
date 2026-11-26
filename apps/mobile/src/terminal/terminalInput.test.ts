import { DEFAULT_TERMINAL_COLORS } from "@octant/theme";
import { describe, expect, it } from "vitest";
import { terminalRunColours } from "./terminalColours";
import { controlCharacter, pastedText, terminalKeyData } from "./terminalInput";

const NORMAL = { applicationCursorKeys: false, bracketedPaste: false };
const PROGRAM = { applicationCursorKeys: true, bracketedPaste: true };

describe("what the phone's terminal keys send", () => {
  it("sends the arrows a shell reads, and the ones an editor that asked for them reads", () => {
    expect(terminalKeyData("up", NORMAL)).toBe("\u001b[A");
    expect(terminalKeyData("left", PROGRAM)).toBe("\u001bOD");
    expect(terminalKeyData("escape", PROGRAM)).toBe("\u001b");
  });

  it("turns a letter typed with Control into its control code", () => {
    expect(controlCharacter("c")).toBe("\u0003");
    expect(controlCharacter("D")).toBe("\u0004");
    expect(controlCharacter("[")).toBe("\u001b");
    expect(controlCharacter("1")).toBe("1");
  });

  it("wraps a paste only for a program that asked for bracketed paste", () => {
    expect(pastedText("a\nb", NORMAL)).toBe("a\rb");
    expect(pastedText("a\nb", PROGRAM)).toBe("\u001b[200~a\rb\u001b[201~");
  });
});

describe("the colours a terminal run is drawn in", () => {
  const { palette, minimumContrastRatio } = DEFAULT_TERMINAL_COLORS;

  it("draws a named colour from the theme's palette and swaps ink and fill under inverse", () => {
    expect(
      terminalRunColours({ fg: { kind: "palette", index: 1 } }, palette, minimumContrastRatio),
    ).toEqual({
      color: palette.red,
    });
    expect(terminalRunColours({ inverse: true }, palette, minimumContrastRatio)).toEqual({
      color: palette.background,
      backgroundColor: palette.foreground,
    });
  });

  it("lifts an ink a program chose that would vanish into the ground", () => {
    const unreadable = { fg: { kind: "rgb" as const, hex: palette.background } };
    expect(terminalRunColours(unreadable, palette, minimumContrastRatio).color).toBe(
      palette.foreground,
    );
  });
});
