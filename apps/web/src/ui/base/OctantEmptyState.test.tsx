import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantEmptyState } from "./OctantEmptyState";

describe("OctantEmptyState", () => {
  it("renders one raised, token-owned state card", () => {
    render(
      <OctantEmptyState message="Try the primary action." role="status" title="Nothing here" />,
    );

    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-slot", "empty-state");
    expect(state).toHaveClass("rounded-[var(--octant-radius-panel)]");
    expect(state).toHaveClass("shadow-[var(--octant-shadow-sm)]");
  });
});
