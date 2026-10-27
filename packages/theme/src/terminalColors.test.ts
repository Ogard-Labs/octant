import { DEFAULT_THEME_SETTINGS, decodeThemeSemanticOverrideEntry } from "@octant/contracts/theme";
import { describe, expect, it } from "vitest";
import { INCREASED_CONTRAST_TEXT } from "./editorColors";
import { resolveEffectiveTokens } from "./fallback";
import { resolveTerminalColorProjection } from "./terminalColors";

describe("terminal color projection", () => {
  it("paints the terminal in the resolved mode's own ground, ink, and palette", () => {
    const dark = resolveTerminalColorProjection(
      resolveEffectiveTokens({ ...DEFAULT_THEME_SETTINGS, mode: "dark" }, false),
    );

    expect(dark.palette).toMatchObject({
      background: "#1a1a1a",
      foreground: "#f5f5f7",
      cursor: "#f5f5f7",
      cursorAccent: "#1a1a1a",
      selectionBackground: "#2c2c2c",
      red: "#d95778",
      green: "#93cb58",
      yellow: "#d9a441",
      blue: "#74b0f3",
      magenta: "#ab98f2",
      cyan: "#45c8bc",
      // Dark: black is the ground family, white the ink.
      black: "#151515",
      white: "#f5f5f7",
      // No bright set is published, so the bright variants reuse the hues and
      // bright black is the muted ink.
      brightRed: "#d95778",
      brightBlack: "#949494",
      brightWhite: "#f5f5f7",
    });
  });

  it("keeps ANSI black dark and white light when the resolved mode is light", () => {
    const light = resolveTerminalColorProjection(
      resolveEffectiveTokens({ ...DEFAULT_THEME_SETTINGS, mode: "light" }, false),
    );

    expect(light.palette).toMatchObject({
      background: "#ffffff",
      foreground: "#141414",
      black: "#141414",
      white: "#fafaf9",
    });
  });

  it("holds every cell to normal-text contrast, because palette roles are only checked as interface marks", () => {
    // A palette override is accepted at 3:1 against the sidebar; as terminal
    // output it is body text on the terminal's own ground.
    const resolved = resolveEffectiveTokens(
      {
        ...DEFAULT_THEME_SETTINGS,
        mode: "dark",
        semanticOverrides: [
          decodeThemeSemanticOverrideEntry({ role: "palette-red", color: "#b04060" }),
        ],
      },
      false,
    );
    const projection = resolveTerminalColorProjection(resolved);

    expect(projection.palette.red).toBe("#b04060");
    expect(projection.minimumContrastRatio).toBe(4.5);
  });

  it("draws the window's increased-contrast ink and raises the floor under increased contrast", () => {
    for (const mode of ["light", "dark"] as const) {
      const resolved = resolveEffectiveTokens({ ...DEFAULT_THEME_SETTINGS, mode }, false);
      const ink = INCREASED_CONTRAST_TEXT[mode];
      const projection = resolveTerminalColorProjection(resolved, { increasedContrast: true });

      expect(projection.palette).toMatchObject({
        foreground: ink.foreground,
        cursor: ink.foreground,
        brightBlack: ink.mutedForeground,
        [mode === "dark" ? "white" : "black"]: ink.foreground,
      });
      expect(projection.minimumContrastRatio).toBe(7);
    }
  });

  it("falls back to the mode's default for a role a theme does not carry", () => {
    const projection = resolveTerminalColorProjection({ mode: "dark", tokens: {} });

    expect(projection.palette.background).toBe("#1a1a1a");
    expect(projection.palette.red).toBe("#d95778");
  });
});
