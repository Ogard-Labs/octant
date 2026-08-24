import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { ThemeTypographyProvider } from "./TypographyProvider";

const typographyBridge = readFileSync(
  resolve(process.cwd(), "src/styles/octant-bridge.css"),
  "utf8",
);

describe("ThemeTypographyProvider", () => {
  it("maps interface typography to sidebar, settings, and transcript text", () => {
    expect(typographyBridge).toMatch(/--oct-font-display:\s*var\(--octant-ui-font-family\);/);
    expect(typographyBridge).toMatch(/--oct-font-transcript:\s*var\(--octant-ui-font-family\);/);
  });

  it("projects independent variables and restores them on remount", () => {
    const typography = {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: "Inter", size: 16, weight: 600 },
      editor: {
        ...DEFAULT_THEME_SETTINGS.typography.editor,
        family: "Source Code Pro",
        size: 15,
        lineHeight: 1.8,
        weight: 500,
        ligatures: false,
      },
      terminal: {
        ...DEFAULT_THEME_SETTINGS.typography.terminal,
        family: "JetBrains Mono",
        size: 12,
        lineHeight: 1.3,
        weight: 300,
        ligatures: true,
      },
    };

    const first = render(
      <ThemeTypographyProvider
        availableFonts={["Inter", "Source Code Pro", "JetBrains Mono"]}
        typography={typography}
      >
        <div />
      </ThemeTypographyProvider>,
    );
    expect(document.documentElement.style.getPropertyValue("--octant-ui-font-family")).toBe(
      "Inter",
    );
    expect(document.documentElement.style.getPropertyValue("--octant-editor-font-family")).toBe(
      "Source Code Pro",
    );
    expect(document.documentElement.style.getPropertyValue("--octant-terminal-font-family")).toBe(
      "JetBrains Mono",
    );
    expect(document.documentElement.style.getPropertyValue("--octant-editor-font-weight")).toBe(
      "500",
    );
    expect(
      document.documentElement.style.getPropertyValue("--octant-terminal-font-ligatures"),
    ).toBe("common-ligatures");

    first.unmount();
    expect(document.documentElement.style.getPropertyValue("--octant-ui-font-family")).toBe("");

    render(
      <ThemeTypographyProvider
        availableFonts={["Inter", "Source Code Pro", "JetBrains Mono"]}
        typography={typography}
      >
        <div />
      </ThemeTypographyProvider>,
    );
    expect(document.documentElement.style.getPropertyValue("--octant-terminal-font-size")).toBe(
      "12px",
    );
  });

  it("uses only locally reported declared families and keeps an unavailable client safe", () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { check: vi.fn((value: string) => value.includes('"Inter"')) },
    });
    const typography = {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: "Inter" },
      editor: { ...DEFAULT_THEME_SETTINGS.typography.editor, family: "Missing Editor" },
      terminal: { ...DEFAULT_THEME_SETTINGS.typography.terminal, family: "Missing Terminal" },
    };

    const rendered = render(
      <ThemeTypographyProvider typography={typography}>
        <div />
      </ThemeTypographyProvider>,
    );

    expect(document.documentElement.style.getPropertyValue("--octant-ui-font-family")).toBe(
      "Inter",
    );
    expect(document.documentElement.style.getPropertyValue("--octant-editor-font-family")).toMatch(
      /monospace/,
    );
    expect(
      document.documentElement.style.getPropertyValue("--octant-terminal-font-family"),
    ).toMatch(/monospace/);
    rendered.unmount();
  });
});
