import { DEFAULT_THEME_SETTINGS, decodeThemeSemanticOverrideEntry } from "@octant/contracts/theme";
import { describe, expect, it } from "vitest";
import { INCREASED_CONTRAST_TEXT, resolveEditorColorProjection } from "./editorColors";
import { resolveEffectiveTokens } from "./fallback";

describe("editor color projection", () => {
  it("paints the editor in the resolved mode's own surfaces and ink", () => {
    const light = resolveEditorColorProjection(
      resolveEffectiveTokens({ ...DEFAULT_THEME_SETTINGS, mode: "light" }, false),
    );
    const dark = resolveEditorColorProjection(
      resolveEffectiveTokens({ ...DEFAULT_THEME_SETTINGS, mode: "dark" }, false),
    );

    expect(light).toMatchObject({
      mode: "light",
      background: "#ffffff",
      foreground: "#141414",
      widgetBackground: "#fdfdfc",
    });
    expect(dark).toMatchObject({
      mode: "dark",
      background: "#1a1a1a",
      foreground: "#f5f5f7",
      widgetBackground: "#232323",
    });
  });

  it("carries a person's accepted override into the editor", () => {
    const projection = resolveEditorColorProjection(
      resolveEffectiveTokens(
        {
          ...DEFAULT_THEME_SETTINGS,
          mode: "light",
          semanticOverrides: [
            decodeThemeSemanticOverrideEntry({ role: "workspace", color: "#fff8ee" }),
          ],
        },
        false,
      ),
    );

    expect(projection.background).toBe("#fff8ee");
  });

  it("draws the increased-contrast ink in place of the theme's text under increased contrast", () => {
    const resolved = resolveEffectiveTokens(
      {
        ...DEFAULT_THEME_SETTINGS,
        mode: "dark",
        semanticOverrides: [
          decodeThemeSemanticOverrideEntry({ role: "text-primary", color: "#dddddd" }),
        ],
      },
      false,
    );

    expect(resolveEditorColorProjection(resolved).foreground).toBe("#dddddd");
    expect(resolveEditorColorProjection(resolved, { increasedContrast: true })).toMatchObject({
      background: "#1a1a1a",
      ...INCREASED_CONTRAST_TEXT.dark,
    });
  });

  it("falls back to the mode's default for a role a theme does not carry", () => {
    const projection = resolveEditorColorProjection({ mode: "dark", tokens: {} });

    expect(projection.background).toBe("#1a1a1a");
    expect(projection.selection).toBe("#2c2c2c");
  });
});
