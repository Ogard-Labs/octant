import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { ThemeAppearanceEditor } from "./ThemeAppearanceEditor";
import type { ThemeController } from "./useThemeController";

function controller(): ThemeController {
  return {
    status: "ready",
    settings: DEFAULT_THEME_SETTINGS,
    draft: DEFAULT_THEME_SETTINGS,
    version: 1,
    error: undefined,
    hasDraftChanges: false,
    updateDraft: vi.fn(),
    applyPatch: vi.fn(async () => true),
    apply: vi.fn(async () => true),
    cancel: vi.fn(),
    reset: vi.fn(),
    importJson: vi.fn(),
    exportJson: vi.fn(() => undefined),
    exportTokens: vi.fn(() => undefined),
  };
}

describe("ThemeAppearanceEditor", () => {
  it("saves appearance changes immediately without an Apply or Cancel bar", async () => {
    const user = userEvent.setup();
    const applyPatch = vi.fn(async () => true);
    render(
      <ThemeAppearanceEditor controller={{ ...controller(), applyPatch, hasDraftChanges: true }} />,
    );

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(applyPatch).toHaveBeenCalledWith({ mode: "light" });
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("heads every Appearance block the way the rest of Settings is headed", () => {
    render(<ThemeAppearanceEditor controller={controller()} />);

    // Appearance used to give each block its own card head — an h3 in a
    // section, a summary in a disclosure, a legend in a fieldset — so the page
    // did not read as the same surface as General. Every block now puts one
    // section label above one flat group.
    for (const name of ["Color scheme", "Typography", "Accessibility", "Import or export theme"]) {
      const block = screen.getByText(name).closest(".settings-card-section");
      expect(block, name).not.toBeNull();
      // The label is the block's own first child, and everything it labels sits
      // in the one group below it.
      expect(block?.firstElementChild?.textContent, name).toContain(name);
      expect(block?.querySelector(":scope > .setgroup"), name).not.toBeNull();
    }
  });

  it("does not wrap switch controls in a second implicit label", () => {
    render(<ThemeAppearanceEditor controller={controller()} />);

    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThanOrEqual(3);
    for (const control of switches) {
      expect(control.closest("label")).toBeNull();
    }
  });

  it("keeps every Appearance section open, JSON transfer included", () => {
    render(<ThemeAppearanceEditor controller={controller()} />);

    for (const name of ["Color scheme", "Typography", "Accessibility", "Import or export theme"]) {
      const section = screen.getByText(name).closest(".settings-card-section");
      expect(section).toHaveClass("settings-card-section--open");
      // The open class is styling only. A disclosure also has to carry the
      // native open state, or the section reads as raised while it is shut.
      if (section instanceof HTMLDetailsElement) expect(section.open).toBe(true);
    }
  });

  it("searches friendly font names and keeps raw stacks behind an advanced disclosure", async () => {
    const applyPatch = vi.fn(async () => true);
    render(<ThemeAppearanceEditor controller={{ ...controller(), applyPatch }} />);

    const user = userEvent.setup();
    const picker = screen.getByRole("combobox", { name: "Interface font" });
    await user.click(picker);
    await user.clear(picker);
    await user.type(picker, "Inter");

    const option = await screen.findByRole("option", { name: /Inter/ });
    expect(option).toHaveTextContent("Aa 01");
    await user.click(option);
    expect(applyPatch).toHaveBeenCalledWith({
      typography: {
        ...DEFAULT_THEME_SETTINGS.typography,
        ui: {
          ...DEFAULT_THEME_SETTINGS.typography.ui,
          family: "Inter, system-ui, sans-serif",
        },
      },
    });
    expect(screen.getAllByText("Custom font stack")[0]?.closest("details")).not.toHaveAttribute(
      "open",
    );
    expect(screen.getByRole("textbox", { name: "Interface font custom stack" })).not.toBeVisible();
  });

  it("offers the Octant appearance pack while that plugin is effective", async () => {
    const user = userEvent.setup();
    render(<ThemeAppearanceEditor controller={controller()} />);
    const light = screen.getByLabelText("Light preset");
    expect(light).toHaveTextContent("System");
    await user.click(light);
    expect(await screen.findByRole("option", { name: "Octant" })).toBeVisible();
  });

  it("omits the Octant appearance pack when that plugin is not effective", async () => {
    const user = userEvent.setup();
    render(
      <ThemeAppearanceEditor
        controller={controller()}
        effectivePlugins={new Map([["appearance-pack", false]])}
      />,
    );
    const light = screen.getByLabelText("Light preset");
    expect(light).toHaveTextContent("System");
    await user.click(light);
    expect(screen.queryByRole("option", { name: "Octant" })).not.toBeInTheDocument();
  });
});

describe("handing the theme to a project outside Octant", () => {
  it("fills the transfer box with design tokens and names the overrides it left out", async () => {
    const { fireEvent, render, screen } = await import("@testing-library/react");
    const exportTokens = vi.fn(() => ({
      format: "css" as const,
      fileName: "octant-theme-tokens.css",
      mediaType: "text/css",
      content: ":root { --octant-workspace: #1e1e1e; }",
      droppedOverrides: [{ role: "not-a-role", reason: "unknown-role" as const }],
    }));
    render(<ThemeAppearanceEditor controller={{ ...controller(), exportTokens } as never} />);

    fireEvent.click(screen.getByRole("button", { name: "Export design tokens (CSS)" }));

    expect(exportTokens).toHaveBeenCalledWith("css");
    expect(screen.getByRole("textbox", { name: "Theme JSON" })).toHaveValue(
      ":root { --octant-workspace: #1e1e1e; }",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("not-a-role");
  });
});
