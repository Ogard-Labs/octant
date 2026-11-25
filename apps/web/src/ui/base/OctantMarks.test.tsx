import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantKbd } from "./OctantKbd";
import { OctantSpinner } from "./OctantSpinner";
import { OctantStatusDot } from "./OctantStatusDot";

describe("OctantSpinner", () => {
  it("is decoration beside a word that already says what is running", () => {
    const { container } = render(
      <p>
        <OctantSpinner size={14} /> Loading issues
      </p>,
    );
    const glyph = container.querySelector("svg.octant-spinner");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveAttribute("width", "14");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the wait when nothing beside it does", () => {
    render(<OctantSpinner label="Saving" />);
    const glyph = screen.getByRole("img", { name: "Saving" });
    expect(glyph).toHaveClass("octant-spinner");
    expect(glyph).not.toHaveAttribute("aria-hidden");
    // 16 is the default: the size of every other glyph in a control.
    expect(glyph).toHaveAttribute("width", "16");
  });
});

describe("OctantKbd", () => {
  it("draws a chord as a boxed cap by default and as a bare hint at the end of a row", () => {
    const { rerender } = render(<OctantKbd>⌘K</OctantKbd>);
    const cap = screen.getByText("⌘K");
    expect(cap.tagName).toBe("KBD");
    expect(cap).toHaveClass("octant-kbd");
    expect(cap).toHaveAttribute("data-form", "cap");
    expect(cap).not.toHaveAttribute("aria-hidden");

    rerender(<OctantKbd form="bare">⌘K</OctantKbd>);
    expect(screen.getByText("⌘K")).toHaveAttribute("data-form", "bare");
  });

  it("is hidden from a screen reader where the control already says the chord", () => {
    render(
      <OctantKbd decorative form="bare">
        ⌘N
      </OctantKbd>,
    );
    expect(screen.getByText("⌘N")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("OctantStatusDot", () => {
  it("is always decoration, since the word beside it carries the state", () => {
    const { container } = render(<OctantStatusDot tone="success" />);
    const dot = container.querySelector(".octant-status-dot");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).toHaveAttribute("data-tone", "success");
    expect(dot).not.toHaveAttribute("data-size");
    expect(dot).not.toHaveAttribute("data-live");
  });

  it("rests neutral, and says when it is small or live", () => {
    const { container } = render(<OctantStatusDot live small />);
    const dot = container.querySelector(".octant-status-dot");
    expect(dot).toHaveAttribute("data-tone", "neutral");
    expect(dot).toHaveAttribute("data-size", "sm");
    expect(dot).toHaveAttribute("data-live", "true");
  });
});
