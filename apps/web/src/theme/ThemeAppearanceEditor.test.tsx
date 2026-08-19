import { render, screen } from "@testing-library/react";
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
  it("does not wrap switch controls in a second implicit label", () => {
    render(<ThemeAppearanceEditor controller={controller()} />);

    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThanOrEqual(3);
    for (const control of switches) {
      expect(control.closest("label")).toBeNull();
    }
  });

  it("keeps typography and theme transfer in deliberate advanced disclosures", () => {
    render(<ThemeAppearanceEditor controller={controller()} />);

    expect(screen.getByText("Typography").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Import or export theme").closest("details")).not.toHaveAttribute(
      "open",
    );
  });

  it("offers the Octant appearance pack while that plugin is effective", () => {
    render(<ThemeAppearanceEditor controller={controller()} />);
    expect(screen.getByLabelText("Light preset")).toHaveTextContent("Octant");
  });

  it("omits the Octant appearance pack when that plugin is not effective", () => {
    render(
      <ThemeAppearanceEditor
        controller={controller()}
        effectivePlugins={new Map([["appearance-pack", false]])}
      />,
    );
    const light = screen.getByLabelText("Light preset");
    expect(light).toHaveTextContent("System");
    expect(light).not.toHaveTextContent("Octant");
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
