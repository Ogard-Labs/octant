import { decodeThemePresetId, DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    expect(root.style.getPropertyValue("--octant-workspace")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--octant-surface")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--octant-surface-raised")).toBe("#fdfdfc");
    expect(root.style.getPropertyValue("--octant-surface-muted")).toBe("#f0f0ef");
    expect(root.style.getPropertyValue("--octant-border-subtle")).toBe("#e0e0de");
    expect(root.style.getPropertyValue("--octant-focus")).toBe("#1f6f96");
    expect(root.style.getPropertyValue("--octant-palette-green")).toBe("#41761c");
    expect(root.style.getPropertyValue("--octant-sidebar-translucent-subtle")).toBe(
      "color-mix(in srgb, #fafaf9 78%, transparent)",
    );
    expect(root.style.getPropertyValue("--octant-workspace-translucent-subtle")).toBe(
      "color-mix(in srgb, #ffffff 78%, transparent)",
    );

    result.unmount();
    expect(root.style.getPropertyValue("--octant-surface")).toBe("");
    expect(root.style.getPropertyValue("--octant-sidebar-translucent-subtle")).toBe("");
    expect(root.style.getPropertyValue("--octant-workspace-translucent-subtle")).toBe("");
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

  it("projects a preset's bounded art palette for the application ground", () => {
    const result = render(
      <ThemeSettingsProvider
        settings={{
          ...DEFAULT_THEME_SETTINGS,
          mode: "dark",
          darkPresetId: decodeThemePresetId("pride"),
        }}
      >
        <div>Pride theme</div>
      </ThemeSettingsProvider>,
    );

    const root = document.documentElement;
    expect(root.dataset.octantPatternInkCount).toBe("6");
    expect(root.style.getPropertyValue("--octant-pattern-ink-1")).toBe(
      root.style.getPropertyValue("--octant-accent"),
    );
    expect(root.style.getPropertyValue("--octant-pattern-ink-2")).toBe("#ff8c00");
    expect(root.style.getPropertyValue("--octant-pattern-ink-6")).toBe("#732982");

    result.unmount();
    expect(root.dataset.octantPatternInkCount).toBeUndefined();
    expect(root.style.getPropertyValue("--octant-pattern-ink-6")).toBe("");
  });

  it("reports the resolved palette to the desktop that owns the approval view", () => {
    const setApprovalSurfacePalette = vi.fn();
    const host = window as unknown as { octantHost?: unknown };
    host.octantHost = {
      setProviderCredential: vi.fn(),
      providerCredentialStatus: vi.fn(),
      clearProviderCredential: vi.fn(),
      setApprovalSurfacePalette,
    };
    try {
      const result = render(
        <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark" }}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(setApprovalSurfacePalette).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "dark", surface: "#232323" }),
      );
      result.unmount();
    } finally {
      delete host.octantHost;
    }
  });
});
