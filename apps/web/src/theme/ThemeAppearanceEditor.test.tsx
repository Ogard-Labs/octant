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
    apply: vi.fn(async () => true),
    cancel: vi.fn(),
    reset: vi.fn(),
    importJson: vi.fn(),
    exportJson: vi.fn(() => undefined),
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
});
