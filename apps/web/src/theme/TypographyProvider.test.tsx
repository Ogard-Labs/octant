import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { OctantButton } from "../ui/base/OctantButton";
import { ThemeTypographyProvider } from "./TypographyProvider";

const typographyBridge = readFileSync(
  resolve(process.cwd(), "src/styles/octant-bridge.css"),
  "utf8",
);
const shellStyles = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8");
const systemStyles = readFileSync(resolve(process.cwd(), "src/styles/octant.css"), "utf8");
const settingsStyles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");
const appStyles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("ThemeTypographyProvider", () => {
  it("maps interface typography to sidebar, settings, and transcript text", () => {
    expect(typographyBridge).toMatch(/--oct-font-display:\s*var\(--octant-ui-font-family\);/);
    expect(typographyBridge).toMatch(/--oct-font-transcript:\s*var\(--octant-ui-font-family\);/);
    expect(typographyBridge).not.toMatch(/--oct-font-(ui|sans)\s*:/);
  });

  it("keeps rendered navigation sidebars tied to the selected interface size", () => {
    const typography = {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: "Inter", size: 18 },
    };

    render(
      <ThemeTypographyProvider availableFonts={["Inter"]} typography={typography}>
        <aside className="sidebar" aria-label="Main navigation">
          <OctantButton className="sidebar-item" type="button">
            New thread
          </OctantButton>
        </aside>
        <aside className="settings-view__sidebar" aria-label="Settings navigation">
          <OctantButton className="setnav-item" type="button">
            Appearance
          </OctantButton>
        </aside>
      </ThemeTypographyProvider>,
    );

    expect(document.documentElement.style.getPropertyValue("--octant-ui-font-family")).toBe(
      "Inter",
    );
    expect(document.documentElement.style.getPropertyValue("--octant-ui-font-size")).toBe("18px");
    expect(systemStyles).toMatch(
      /\.sidebar-item\s*\{[^}]*font-family:\s*var\(--oct-font-display\);[^}]*font-size:\s*var\(--octant-ui-font-size\);/s,
    );
    expect(shellStyles).toMatch(
      /\.sidebar-navigation__thread\s*\{[^}]*font-size:\s*var\(--octant-ui-font-size\);/s,
    );
    expect(systemStyles).toMatch(
      /\.setnav-item\s*\{[^}]*font-family:\s*var\(--oct-font-display\);[^}]*font-size:\s*var\(--octant-ui-font-size\);/s,
    );
    expect(settingsStyles).toMatch(
      /\.settings-navigation \.setnav-item,[\s\S]*font-size:\s*var\(--octant-ui-font-size\);/s,
    );
    expect(shellStyles).toMatch(
      /\.sidebar-navigation__thread\s*\{[^}]*font-family:\s*var\(--oct-font-display\);[^}]*font-size:\s*var\(--octant-ui-font-size\);/s,
    );
    expect(appStyles).toMatch(
      /\.project-row__copy > span\s*\{[^}]*font-family:\s*var\(--oct-font-display\);[^}]*font-size:\s*var\(--octant-ui-font-size\);/s,
    );
    expect(systemStyles).toMatch(
      /\.board-col-head\s*\{[^}]*font-family:\s*var\(--oct-font-display\);/s,
    );
    expect(systemStyles).toMatch(
      /\.board-card-title\s*\{[^}]*font-family:\s*var\(--oct-font-display\);/s,
    );
    expect(systemStyles).toMatch(
      /\.board-card-title\s*\{[^}]*font-size:\s*var\(--octant-ui-font-size\);/s,
    );
    expect(appStyles).toMatch(
      /\.project-section > \.sidebar-section\s*\{[^}]*font-size:\s*var\(--oct-text-xs\);/s,
    );
    expect(appStyles).toMatch(
      /\.workspace-pane__grip\s*\{[^}]*font-family:\s*var\(--oct-font-display\);[^}]*font-size:\s*var\(--oct-text-xs\);/s,
    );
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
