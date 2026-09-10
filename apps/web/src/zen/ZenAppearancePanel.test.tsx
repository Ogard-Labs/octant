import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZEN_BUILTIN_BACKGROUNDS } from "@octant/contracts/zen";
import type { ZenAppearance } from "@octant/contracts/zen";
import { ZenAppearancePanel } from "./ZenAppearancePanel";

const appearance: ZenAppearance = {
  dimming: 0,
  elementOpacity: 100,
  reducedMotion: false,
  reducedTransparency: false,
  increasedContrast: false,
  background: { kind: "solid", color: "#1a1a2e" },
};

describe("the Zen appearance panel", () => {
  it("shows a picture of every built-in background, not just its name", () => {
    render(<ZenAppearancePanel appearance={appearance} />);
    for (const preset of ZEN_BUILTIN_BACKGROUNDS) {
      const choice = screen.getByRole("button", { name: preset.title });
      // An animated preset is a moving WebP; the picker shows its still frame
      // so choosing a background does not set eight of them playing at once.
      const expected = "stillSrc" in preset ? preset.stillSrc : preset.src;
      expect(choice.querySelector("img")).toHaveAttribute("src", expected);
    }
  });

  it("marks the chosen background and commits the one that is clicked", () => {
    const onUpdateAppearance = vi.fn();
    const chosen = ZEN_BUILTIN_BACKGROUNDS[0];
    if (chosen === undefined) throw new Error("no built-in backgrounds to choose from");
    render(
      <ZenAppearancePanel
        appearance={{
          ...appearance,
          background: { kind: "builtin", presetId: chosen.id, overlay: 0, fill: "cover" },
        }}
        onUpdateAppearance={onUpdateAppearance}
      />,
    );
    expect(screen.getByRole("button", { name: chosen.title })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps the custom fill controls folded away until they are asked for", () => {
    render(<ZenAppearancePanel appearance={appearance} />);
    const disclosure = screen.getByText("Custom fill").closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
  });
});
