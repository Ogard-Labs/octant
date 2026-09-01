import { DEFAULT_THEME_SETTINGS, type ThemeTypography } from "@octant/contracts/theme";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  DEFAULT_TERMINAL_TYPOGRAPHY,
  DEFAULT_UI_TYPOGRAPHY,
  resolveTypographyProjection,
} from "./typography";

describe("typography projections", () => {
  it("resolves UI, editor, and terminal families independently", () => {
    const resolved = resolveTypographyProjection(
      {
        ...DEFAULT_THEME_SETTINGS.typography,
        ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: "Inter" },
        editor: { ...DEFAULT_THEME_SETTINGS.typography.editor, family: "Source Code Pro" },
        terminal: { ...DEFAULT_THEME_SETTINGS.typography.terminal, family: "Missing Terminal" },
      },
      ["Inter", "Source Code Pro"],
    );

    expect(resolved.ui.fontFamily).toBe("Inter");
    expect(resolved.editor.fontFamily).toBe("Source Code Pro");
    expect(resolved.terminal.fontFamily).toBe(DEFAULT_TERMINAL_TYPOGRAPHY.fontFamily);
    expect(resolved.typography.ui.family).toBe("Inter");
    expect(resolved.typography.editor.family).toBe("Source Code Pro");
    expect(resolved.typography.terminal.family).toBe(DEFAULT_TERMINAL_TYPOGRAPHY.fontFamily);
  });

  it("fails closed for invalid runtime values while preserving safe defaults", () => {
    const invalid = {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: "url(https://bad.example/font.woff)" },
      editor: {
        ...DEFAULT_THEME_SETTINGS.typography.editor,
        size: 3.5,
        lineHeight: 4,
        weight: 901,
      },
      terminal: {
        ...DEFAULT_THEME_SETTINGS.typography.terminal,
        size: Number.NaN,
        lineHeight: Number.POSITIVE_INFINITY,
        weight: 200,
      },
    } as unknown as ThemeTypography;

    const resolved = resolveTypographyProjection(invalid, []);

    expect(resolved.ui).toEqual(DEFAULT_UI_TYPOGRAPHY);
    expect(resolved.editor).toMatchObject({
      fontSize: DEFAULT_EDITOR_TYPOGRAPHY.fontSize,
      lineHeight: DEFAULT_EDITOR_TYPOGRAPHY.lineHeight,
      fontWeight: DEFAULT_EDITOR_TYPOGRAPHY.fontWeight,
    });
    expect(resolved.terminal).toMatchObject({
      fontSize: DEFAULT_TERMINAL_TYPOGRAPHY.fontSize,
      lineHeight: DEFAULT_TERMINAL_TYPOGRAPHY.lineHeight,
      fontWeight: DEFAULT_TERMINAL_TYPOGRAPHY.fontWeight,
    });
  });

  it("keeps independent size, weight, line-height, and ligature projections", () => {
    const resolved = resolveTypographyProjection(
      {
        ...DEFAULT_THEME_SETTINGS.typography,
        ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, size: 17, weight: 600 },
        editor: {
          ...DEFAULT_THEME_SETTINGS.typography.editor,
          size: 15,
          lineHeight: 2,
          weight: 500,
          ligatures: false,
        },
        terminal: {
          ...DEFAULT_THEME_SETTINGS.typography.terminal,
          size: 11,
          lineHeight: 1.2,
          weight: 300,
          ligatures: true,
        },
      },
      ["Inter", "JetBrains Mono"],
    );

    expect(resolved.ui).toMatchObject({ fontSize: 17, fontWeight: 600 });
    expect(resolved.editor).toMatchObject({
      fontSize: 15,
      lineHeight: 2,
      fontWeight: 500,
      fontLigatures: false,
    });
    expect(resolved.terminal).toMatchObject({
      fontSize: 11,
      lineHeight: 1.2,
      fontWeight: 300,
      fontLigatures: true,
    });
  });
});

describe("interface face migration", () => {
  it("reads a saved pre-Inter system stack as the current default face", () => {
    const legacy: ThemeTypography = {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: {
        ...DEFAULT_THEME_SETTINGS.typography.ui,
        family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      },
    };

    const projection = resolveTypographyProjection(legacy, []);

    expect(projection.ui.fontFamily).toBe(DEFAULT_THEME_SETTINGS.typography.ui.family);
    expect(projection.ui.fontFamily).toContain("Inter Variable");
  });

  it("keeps a deliberately chosen system stack", () => {
    const chosen: ThemeTypography = {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: "'SF Pro Text', system-ui" },
    };

    expect(resolveTypographyProjection(chosen, []).ui.fontFamily).toBe("'SF Pro Text', system-ui");
  });
});
