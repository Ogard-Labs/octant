import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantEmpty } from "./OctantEmpty";

describe("OctantEmpty", () => {
  it("sets the label above a message's title in the interface font, not the code font", () => {
    render(
      <OctantEmpty
        eyebrow="Project authority"
        message="Local Machine access is unavailable."
        title="Project authority is unavailable"
      />,
    );
    // Only code, paths, and tool output use the code face. This label was the
    // one piece of chrome that did, so it ignored the font a person chose.
    expect(screen.getByText("Project authority")).not.toHaveClass("font-mono");
  });

  it("renders one raised, token-owned state card", () => {
    render(<OctantEmpty message="Try the primary action." role="status" title="Nothing here" />);

    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-slot", "empty");
    expect(state).toHaveClass("rounded-[var(--octant-radius-panel)]");
    expect(state).toHaveClass("shadow-[var(--octant-shadow-sm)]");
  });

  it("draws a message's mark in neutral ink, whatever went wrong", () => {
    render(
      <OctantEmpty
        icon={<svg data-testid="mark" />}
        message="Local Machine access is unavailable."
        role="alert"
        title="Project authority is unavailable"
      />,
    );

    // The mark's shape says what happened. A yellow or red glyph was the one
    // coloured thing on a neutral screen, so the recipe offers no such tone.
    const media = screen.getByTestId("mark").parentElement;
    expect(media).toHaveAttribute("data-slot", "empty-media");
    expect(media?.className).toContain("text-muted-foreground");
    expect(media?.className).not.toMatch(/warning|danger|destructive/);
  });
});
