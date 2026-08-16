import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { importThemeSettings, serializeOctantTheme } from "./import";

describe("safe theme settings import/export", () => {
  it("round-trips the bounded Octant settings envelope", () => {
    const settings = {
      ...DEFAULT_THEME_SETTINGS,
      mode: "dark" as const,
      density: "compact" as const,
    };
    expect(importThemeSettings(JSON.parse(serializeOctantTheme(settings)))).toEqual(settings);
  });

  it("maps only known VS Code colors and rejects executable or remote content", () => {
    const settings = importThemeSettings({
      name: "Local theme",
      type: "dark",
      colors: { "octant.focus-ring": "#ffcc00", "editor.background": "#111113" },
      tokenColors: [],
    });
    expect(settings.mode).toBe("dark");
    expect(settings.semanticOverrides).toContainEqual({ role: "focus-ring", color: "#ffcc00" });
    expect(() => importThemeSettings({ colors: {}, scripts: "javascript:alert(1)" })).toThrow();
    expect(() =>
      importThemeSettings({ colors: { "octant.focus-ring": "url(https://x)" } }),
    ).toThrow();
  });
});
import { ThemeImportError, importVsCodeTheme } from "./import";

describe("vs code theme import validation", () => {
  it("accepts a minimal valid color theme", () => {
    const result = importVsCodeTheme({
      name: "Octant Graphite",
      type: "dark",
      colors: {
        "editor.background": "#0d0d0f",
        "editor.foreground": "#eeeeec",
      },
      tokenColors: [
        { scope: "comment", settings: { foreground: "#a4a4a0", fontStyle: "italic" } },
        { scope: ["keyword", "storage"], settings: { foreground: "#8b5cf6" } },
      ],
    });
    expect(result.name).toBe("Octant Graphite");
    expect(result.type).toBe("dark");
    expect(result.colors["editor.background"]).toBe("#0d0d0f");
    expect(result.tokenColors).toHaveLength(2);
    expect(result.tokenColors[0]?.fontStyle).toBe("italic");
  });

  it("accepts eight-digit hex colors with alpha", () => {
    const result = importVsCodeTheme({
      type: "dark",
      colors: { "editor.selectionBackground": "#8b5cf680" },
    });
    expect(result.colors["editor.selectionBackground"]).toBe("#8b5cf680");
  });

  it.each([null, "string", 42, [], true])("rejects non-object input %s", (input) => {
    expect(() => importVsCodeTheme(input)).toThrow(ThemeImportError);
  });

  it.each(["include", "$include", "imports", "scripts", "fontFamily", "constructor"])(
    "rejects disallowed top-level key %s",
    (key) => {
      expect(() => importVsCodeTheme({ type: "dark", [key]: "evil" })).toThrow(ThemeImportError);
    },
  );

  it("rejects remote urls and import directives in any string value", () => {
    expect(() =>
      importVsCodeTheme({ type: "dark", colors: { "editor.background": "https://evil.example" } }),
    ).toThrow(ThemeImportError);
    expect(() => importVsCodeTheme({ name: "@import 'evil.css'", type: "dark" })).toThrow(
      ThemeImportError,
    );
    expect(() =>
      importVsCodeTheme({ type: "dark", colors: { "editor.background": "url(font.woff)" } }),
    ).toThrow(ThemeImportError);
  });

  it("rejects named colors and rgb() values", () => {
    expect(() =>
      importVsCodeTheme({ type: "dark", colors: { "editor.background": "white" } }),
    ).toThrow(ThemeImportError);
    expect(() =>
      importVsCodeTheme({ type: "dark", colors: { "editor.background": "rgb(0,0,0)" } }),
    ).toThrow(ThemeImportError);
  });

  it("rejects tokenColors settings carrying fontFamily", () => {
    expect(() =>
      importVsCodeTheme({
        type: "dark",
        tokenColors: [
          { scope: "comment", settings: { foreground: "#a4a4a0", fontFamily: "EvilFont" } },
        ],
      }),
    ).toThrow(ThemeImportError);
  });

  it("rejects tokenColors entries with excess top-level keys", () => {
    expect(() =>
      importVsCodeTheme({
        type: "dark",
        tokenColors: [{ scope: "comment", settings: { foreground: "#a4a4a0" }, script: "evil" }],
      }),
    ).toThrow(ThemeImportError);
  });

  it.each(["italic; url(evil)", "italic <script>", "@import 'x'", "italic; font-family: evil"])(
    "rejects unsafe fontStyle %s",
    (fontStyle) => {
      expect(() =>
        importVsCodeTheme({
          type: "dark",
          tokenColors: [{ scope: "comment", settings: { foreground: "#a4a4a0", fontStyle } }],
        }),
      ).toThrow(ThemeImportError);
    },
  );

  it("accepts combined fontStyle tokens", () => {
    const result = importVsCodeTheme({
      type: "dark",
      tokenColors: [
        {
          scope: "keyword",
          settings: { foreground: "#8b5cf6", fontStyle: "italic bold underline" },
        },
      ],
    });
    expect(result.tokenColors[0]?.fontStyle).toBe("italic bold underline");
  });

  it("rejects oversized colors and tokenColors collections", () => {
    const colors: Record<string, string> = {};
    for (let i = 0; i < 600; i++) colors[`key${i}`] = "#000000";
    expect(() => importVsCodeTheme({ type: "dark", colors })).toThrow(ThemeImportError);

    const tokenColors = Array.from({ length: 300 }, () => ({
      scope: "comment",
      settings: { foreground: "#000000" },
    }));
    expect(() => importVsCodeTheme({ type: "dark", tokenColors })).toThrow(ThemeImportError);
  });

  it("rejects invalid type values", () => {
    expect(() => importVsCodeTheme({ type: "high-contrast" })).toThrow(ThemeImportError);
  });
});
