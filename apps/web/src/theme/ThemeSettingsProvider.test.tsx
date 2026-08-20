import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeSettingsProvider } from "./ThemeSettingsProvider";

describe("ThemeSettingsProvider", () => {
  it("projects the semantic palette and legacy surface aliases in light mode", () => {
    const result = render(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "light" }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );

    const root = document.documentElement;
    expect(root.dataset.octantThemeMode).toBe("light");
    expect(root.style.getPropertyValue("--octant-workspace")).toBe("#fafafb");
    expect(root.style.getPropertyValue("--octant-surface")).toBe("#fafafb");
    expect(root.style.getPropertyValue("--octant-surface-raised")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--octant-surface-muted")).toBe("#eff0f2");
    expect(root.style.getPropertyValue("--octant-border-subtle")).toBe("#e4e6e9");
    expect(root.style.getPropertyValue("--octant-focus")).toBe("#0285ff");
    expect(root.style.getPropertyValue("--octant-palette-green")).toBe("#157a3d");
    expect(root.style.getPropertyValue("--octant-sidebar-translucent-subtle")).toBe(
      "color-mix(in srgb, #eef0f1 78%, transparent)",
    );

    result.unmount();
    expect(root.style.getPropertyValue("--octant-surface")).toBe("");
    expect(root.style.getPropertyValue("--octant-sidebar-translucent-subtle")).toBe("");
  });

  it("publishes accessibility state on the data-octant-* attributes the stylesheets read", () => {
    const result = render(
      <ThemeSettingsProvider
        settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark", reducedMotion: true }}
      >
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );

    const root = document.documentElement;
    expect(root.getAttribute("data-octant-theme-mode")).toBe("dark");
    expect(root.getAttribute("data-octant-reduced-motion")).toBe("true");
    expect(root.getAttribute("data-octant-reduced-transparency")).toBe("false");
    expect(root.getAttribute("data-octant-increased-contrast")).toBe("false");

    result.unmount();
    expect(root.getAttribute("data-octant-theme-mode")).toBeNull();
    expect(root.getAttribute("data-octant-reduced-motion")).toBeNull();
  });

  it("projects the accent-text role so accent used as text carries its own contrast guarantee", () => {
    const result = render(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark" }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--octant-accent-text")).not.toBe("");

    result.unmount();
  });
});
