import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { INCREASED_CONTRAST_TEXT, type EditorColorProjection } from "@octant/theme/editor-colors";
import { MONO_STYLE_TOKENS } from "@octant/theme";
import { act, render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { followSystemIncreasedContrast } from "./increasedContrastAttribute";
import { ThemeSettingsProvider, useEditorColorProjection } from "./ThemeSettingsProvider";

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
      "color-mix(in srgb, #fafaf9 88%, transparent)",
    );
    expect(root.style.getPropertyValue("--octant-workspace-translucent-subtle")).toBe(
      "color-mix(in srgb, #ffffff 88%, transparent)",
    );

    result.unmount();
    expect(root.style.getPropertyValue("--octant-surface")).toBe("");
    expect(root.style.getPropertyValue("--octant-sidebar-translucent-subtle")).toBe("");
    expect(root.style.getPropertyValue("--octant-workspace-translucent-subtle")).toBe("");
  });

  it("remembers the chosen mode so the next window can paint it on its first frame", () => {
    localStorage.clear();
    const result = render(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "light" }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    expect(localStorage.getItem("octant.theme-mode")).toBe("light");
    result.unmount();
  });

  it("keeps the window's theme when a nested provider, such as Settings, closes", () => {
    const root = document.documentElement;
    const settings = { ...DEFAULT_THEME_SETTINGS, mode: "light" as const, increasedContrast: true };
    const frame = (settingsOpen: boolean) => (
      <ThemeSettingsProvider settings={settings}>
        {settingsOpen ? (
          <ThemeSettingsProvider settings={settings}>
            <div>Settings</div>
          </ThemeSettingsProvider>
        ) : (
          <div>Workspace</div>
        )}
      </ThemeSettingsProvider>
    );
    const result = render(frame(true));
    result.rerender(frame(false));

    expect(root.dataset.octantThemeMode).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.getPropertyValue("--octant-workspace")).toBe("#ffffff");
    expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");

    result.unmount();
    expect(root.dataset.octantThemeMode).toBeUndefined();
    expect(root.style.getPropertyValue("--octant-workspace")).toBe("");
  });

  it("clamps a chosen glass tint at paint time and marks thin glass for the stylesheet", () => {
    const result = render(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "light", glassTint: 20 }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    const root = document.documentElement;
    // The light floor is 45; the saved 20 is untouched, only the paint is clamped.
    for (const level of ["", "-subtle", "-strong"]) {
      expect(root.style.getPropertyValue(`--octant-workspace-translucent${level}`)).toBe(
        "color-mix(in srgb, #ffffff 45%, transparent)",
      );
    }
    expect(root.dataset.octantGlassThin).toBe("subtle strong");
    result.rerender(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark" }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    // Both dark levels (74 and 58) are under the secondary floor of 77.
    expect(root.dataset.octantGlassThin).toBe("subtle strong");
    result.rerender(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "light" }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    // Both light defaults (88 and 76) clear the secondary floor of 72.
    expect(root.dataset.octantGlassThin).toBeUndefined();
    result.unmount();
    expect(root.dataset.octantGlassThin).toBeUndefined();
  });

  it("paints the dark window coat at 74% for Subtle and 58% for Strong, and a saved low Tint at the floor", () => {
    const root = document.documentElement;
    const result = render(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark" }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    const coat = (level: "subtle" | "strong") =>
      root.style.getPropertyValue(`--octant-workspace-translucent-${level}`);
    expect(coat("subtle")).toMatch(/ 74%, transparent\)$/);
    expect(coat("strong")).toMatch(/ 58%, transparent\)$/);
    result.rerender(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark", glassTint: 8 }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    // A Tint replaces both levels and is clamped at the dark floor of 45%.
    expect(coat("subtle")).toMatch(/ 45%, transparent\)$/);
    expect(coat("strong")).toMatch(/ 45%, transparent\)$/);
    result.unmount();
  });

  it("publishes density, text smoothing, timestamp format and the custom contrast step for the stylesheets", () => {
    const result = render(
      <ThemeSettingsProvider
        settings={{
          ...DEFAULT_THEME_SETTINGS,
          mode: "dark",
          density: "compact",
          fontSmoothing: "off",
          timestampFormat: "24h",
          darkPresetId: "custom" as never,
          customThemeDark: {
            ground: "#1b1d23",
            ink: "#f2f2f4",
            accent: "#7aa2ff",
            contrast: "firm",
          } as never,
        }}
      >
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    const root = document.documentElement;
    expect(root.dataset.octantDensity).toBe("compact");
    expect(root.dataset.octantFontSmoothing).toBe("off");
    expect(root.dataset.octantTimestampFormat).toBe("24h");
    expect(root.style.getPropertyValue("--oct-contrast-scale")).toBe("1.5");
    result.rerender(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark" }}>
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    expect(root.dataset.octantDensity).toBe("comfortable");
    // Smooth is the default; only a stored "off" turns it off.
    expect(root.dataset.octantFontSmoothing).toBe("on");
    expect(root.dataset.octantTimestampFormat).toBeUndefined();
    expect(root.style.getPropertyValue("--oct-contrast-scale")).toBe("");
    result.rerender(
      <ThemeSettingsProvider
        settings={{
          ...DEFAULT_THEME_SETTINGS,
          mode: "dark",
          fontSmoothing: "auto",
          timestampFormat: "12h",
        }}
      >
        <div>Theme content</div>
      </ThemeSettingsProvider>,
    );
    expect(root.dataset.octantFontSmoothing).toBe("on");
    expect(root.dataset.octantTimestampFormat).toBe("12h");
    result.unmount();
    expect(root.dataset.octantFontSmoothing).toBeUndefined();
    expect(root.dataset.octantTimestampFormat).toBeUndefined();
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

  it("publishes the colour style by default and the old name, Mono on request, and Mono under increased contrast", () => {
    const root = document.documentElement;
    const published = (settings: typeof DEFAULT_THEME_SETTINGS) => {
      const view = render(
        <ThemeSettingsProvider settings={settings}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      const value = root.getAttribute("data-octant-style");
      view.unmount();
      return value;
    };
    expect(published(DEFAULT_THEME_SETTINGS)).toBe("colour");
    expect(root.getAttribute("data-octant-style")).toBeNull();
    expect(published({ ...DEFAULT_THEME_SETTINGS, style: "default" })).toBe("colour");
    expect(published({ ...DEFAULT_THEME_SETTINGS, style: "vivid" })).toBe("colour");
    expect(published({ ...DEFAULT_THEME_SETTINGS, style: "mono" })).toBe("mono");
    expect(published({ ...DEFAULT_THEME_SETTINGS, style: "vivid", increasedContrast: true })).toBe(
      "mono",
    );
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

  it("reports the resolved palette to the desktop that owns the approval view", () => {
    const setApprovalSurfacePalette = vi.fn();
    const host = window as unknown as { octantHost?: unknown };
    host.octantHost = {
      setProviderCredential: vi.fn(),
      addProviderApiKey: vi.fn(),
      listProviderApiKeys: vi.fn(async () => []),
      renameProviderApiKey: vi.fn(),
      replaceProviderApiKey: vi.fn(),
      removeProviderApiKey: vi.fn(),
      setActiveProviderApiKey: vi.fn(),
      moveProviderApiKey: vi.fn(),
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

  it("applies the high-contrast text with the in-app setting alone, and drops it when the setting is turned off", () => {
    const root = document.documentElement;
    for (const mode of ["light", "dark"] as const) {
      const result = render(
        <ThemeSettingsProvider
          settings={{ ...DEFAULT_THEME_SETTINGS, mode, increasedContrast: true }}
        >
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");
      // The stylesheet maps the text roles to their high-contrast values under
      // this attribute; an inline colour would outrank that rule.
      expect(root.style.getPropertyValue("--octant-text-primary")).toBe("");
      expect(root.style.getPropertyValue("--octant-text-muted")).toBe("");

      // Another appearance change leaves the contrast state where it was.
      result.rerender(
        <ThemeSettingsProvider
          settings={{ ...DEFAULT_THEME_SETTINGS, mode, glassTint: 30, increasedContrast: true }}
        >
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");

      result.rerender(
        <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode }}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("false");
      expect(root.style.getPropertyValue("--octant-text-primary")).not.toBe("");
      result.unmount();
    }
  });

  it("keeps increased contrast on while the system asks for more contrast, whatever the setting says", () => {
    const listeners = new Set<() => void>();
    let systemMore = true;
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query === "(prefers-contrast: more)" && systemMore;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    const root = document.documentElement;
    try {
      const result = render(
        <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, increasedContrast: false }}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");
      expect(root.style.getPropertyValue("--octant-text-primary")).toBe("");
      // The system's request also selects the grey style and roles, not the
      // blue accent and amber warning of the colour style.
      expect(root.getAttribute("data-octant-style")).toBe("mono");
      expect(root.style.getPropertyValue("--octant-accent")).toBe(
        MONO_STYLE_TOKENS.light["accent"],
      );

      systemMore = false;
      act(() => {
        for (const listener of listeners) listener();
      });
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("false");
      expect(root.style.getPropertyValue("--octant-text-primary")).not.toBe("");
      expect(root.getAttribute("data-octant-style")).toBe("colour");
      expect(root.style.getPropertyValue("--octant-accent")).not.toBe(
        MONO_STYLE_TOKENS.light["accent"],
      );
      result.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("draws the system's increased contrast before the settings load and after they unmount", () => {
    const listeners = new Set<() => void>();
    let systemMore = true;
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query === "(prefers-contrast: more)" && systemMore;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    const root = document.documentElement;
    const stopFollowing = followSystemIncreasedContrast();
    try {
      // Loading, pairing, and disconnected screens render before any settings
      // provider mounts; the system preference must already reach them.
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");

      const result = render(
        <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, increasedContrast: false }}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");
      // Returning to the disconnected screen unmounts the provider.
      result.unmount();
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");

      systemMore = false;
      for (const listener of listeners) listener();
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("false");
      systemMore = true;
      for (const listener of listeners) listener();
      expect(root.getAttribute("data-octant-increased-contrast")).toBe("true");
    } finally {
      stopFollowing();
      expect(listeners.size).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("keys every high-contrast stylesheet rule off the attribute the setting and the system preference share", () => {
    const sheets: Array<string> = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".css")) sheets.push(path);
      }
    };
    walk(resolve(process.cwd(), "src"));
    for (const sheet of sheets) {
      expect(readFileSync(sheet, "utf8"), sheet).not.toMatch(/prefers-contrast/);
    }
    const tokens = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const block = /:root\[data-octant-increased-contrast="true"\] \{([^}]*)\}/.exec(tokens)?.[1];
    expect(block).toContain("--octant-text-primary: var(--octant-text-primary-high-contrast);");
    expect(block).toContain("--octant-text-secondary: var(--octant-text-secondary-high-contrast);");
    expect(block).toContain("--octant-text-muted: var(--octant-text-muted-high-contrast);");
  });
  it("draws the code editor in the same increased-contrast ink as the rest of the window", () => {
    const seen: Array<EditorColorProjection> = [];
    const Probe = () => {
      seen.push(useEditorColorProjection());
      return null;
    };
    for (const mode of ["light", "dark"] as const) {
      render(
        <ThemeSettingsProvider
          settings={{ ...DEFAULT_THEME_SETTINGS, mode, increasedContrast: true }}
        >
          <Probe />
        </ThemeSettingsProvider>,
      ).unmount();
      expect(seen.at(-1)).toMatchObject(INCREASED_CONTRAST_TEXT[mode]);
    }

    // The editor cannot read the stylesheet, so its ink must be the very
    // values the stylesheet swaps in for each mode.
    const sheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const blocks = {
      dark: /^:root \{([^}]*)\}/m.exec(sheet)?.[1] ?? "",
      light: /^html\[data-octant-theme-mode="light"\] \{([^}]*)\}/m.exec(sheet)?.[1] ?? "",
    };
    for (const mode of ["light", "dark"] as const) {
      const ink = INCREASED_CONTRAST_TEXT[mode];
      expect(blocks[mode]).toContain(`--octant-text-primary-high-contrast: ${ink.foreground};`);
      expect(blocks[mode]).toContain(`--octant-text-muted-high-contrast: ${ink.mutedForeground};`);
    }
  });

  it("follows a live system appearance change while set to follow the system, and stops listening when it is not", () => {
    const listeners = new Set<() => void>();
    const query = {
      matches: false,
      addEventListener: vi.fn((_type: "change", listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: "change", listener: () => void) =>
        listeners.delete(listener),
      ),
    };
    // Only the appearance query is under test; the contrast query keeps its
    // own listener, so it answers from a separate object.
    const otherQuery = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal(
      "matchMedia",
      vi.fn((media: string) => (media === "(prefers-color-scheme: dark)" ? query : otherQuery)),
    );
    const root = document.documentElement;
    const switchSystemAppearance = (dark: boolean) =>
      act(() => {
        query.matches = dark;
        for (const listener of listeners) listener();
      });
    try {
      const result = render(
        <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "system" }}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(root.dataset.octantThemeMode).toBe("light");

      switchSystemAppearance(true);
      expect(root.dataset.octantThemeMode).toBe("dark");
      switchSystemAppearance(false);
      expect(root.dataset.octantThemeMode).toBe("light");

      result.rerender(
        <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "light" }}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(listeners.size).toBe(0);
      switchSystemAppearance(true);
      expect(root.dataset.octantThemeMode).toBe("light");

      result.rerender(
        <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "system" }}>
          <div>Theme content</div>
        </ThemeSettingsProvider>,
      );
      expect(root.dataset.octantThemeMode).toBe("dark");
      result.unmount();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
