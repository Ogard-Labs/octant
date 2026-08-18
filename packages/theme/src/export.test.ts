import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { exportThemeTokens, ThemeExportError } from "./export";

const settings = DEFAULT_THEME_SETTINGS;

describe("exporting a theme as design tokens", () => {
  it("writes both readings of the theme, not only the one on screen", () => {
    const light = exportThemeTokens({ ...settings, mode: "light" }, { format: "json" });
    const dark = exportThemeTokens({ ...settings, mode: "dark" }, { format: "json" });

    const lightDoc = JSON.parse(light.content) as {
      modes: { light: Record<string, string>; dark: Record<string, string> };
    };
    expect(Object.keys(lightDoc.modes.light).length).toBeGreaterThan(0);
    expect(Object.keys(lightDoc.modes.dark)).toEqual(Object.keys(lightDoc.modes.light));
    expect(lightDoc.modes.light["app-background"]).not.toBe(lightDoc.modes.dark["app-background"]);
    // Which mode the app happens to be showing is not part of the export.
    expect(dark.content).toBe(light.content);
  });

  it("carries the theme's own overrides, not the preset it started from", () => {
    const themed = exportThemeTokens(
      {
        ...settings,
        semanticOverrides: [{ role: "accent", color: "#123456" }],
      } as never,
      { format: "json" },
    );

    const doc = JSON.parse(themed.content) as { modes: { light: Record<string, string> } };
    expect(doc.modes.light["accent"]).toBe("#123456");
  });

  it("says which overrides the theme refused rather than exporting them", () => {
    const themed = exportThemeTokens(
      {
        ...settings,
        semanticOverrides: [{ role: "not-a-role", color: "#123456" }],
      } as never,
      { format: "json" },
    );

    expect(themed.droppedOverrides).toEqual([
      { role: "not-a-role", reason: "unknown-role" },
      { role: "not-a-role", reason: "unknown-role" },
    ]);
    expect(themed.content).not.toContain("not-a-role");
  });

  it("writes CSS a project can adopt in either mode and pin explicitly", () => {
    const css = exportThemeTokens(settings, { format: "css" }).content;

    expect(css).toContain(":root {");
    expect(css).toContain("--octant-app-background:");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain('[data-theme="dark"]');
  });

  it("takes a project's own prefix and refuses one that is not a custom-property name", () => {
    expect(exportThemeTokens(settings, { format: "css", prefix: "studio" }).content).toContain(
      "--studio-workspace:",
    );
    expect(() => exportThemeTokens(settings, { format: "css", prefix: "Studio Tokens" })).toThrow(
      ThemeExportError,
    );
  });

  it("includes the type scale only when the project asked for it", () => {
    expect(
      exportThemeTokens(settings, { format: "css", includeTypography: true }).content,
    ).toContain("--octant-font-ui:");
    expect(exportThemeTokens(settings, { format: "css" }).content).not.toContain(
      "--octant-font-ui:",
    );
  });
});
