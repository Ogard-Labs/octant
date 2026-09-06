import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantBadge } from "./OctantBadge";

describe("OctantBadge", () => {
  it("renders a status as a filled pill sized on the type ramp", () => {
    render(<OctantBadge variant="warning">Waiting</OctantBadge>);

    const badge = screen.getByText("Waiting");
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge).toHaveAttribute("data-variant", "warning");
    // 0073 has no size below `text-xs`; the label used to be drawn at 10px.
    expect(badge.className).toContain("text-xs");
    expect(badge.className).not.toContain("text-[10px]");
  });

  it("carries a status fill rather than an outline", () => {
    render(<OctantBadge variant="warning">Waiting</OctantBadge>);

    const badge = screen.getByText("Waiting");
    expect(badge.className).toContain("bg-[var(--octant-warning-surface)]");
    expect(badge.className).not.toContain("bg-transparent");
  });
});
