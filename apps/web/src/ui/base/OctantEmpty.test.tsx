import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantEmpty } from "./OctantEmpty";

describe("OctantEmpty", () => {
  it("renders one raised, token-owned state card", () => {
    render(<OctantEmpty message="Try the primary action." role="status" title="Nothing here" />);

    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-slot", "empty");
    expect(state).toHaveClass("rounded-[var(--octant-radius-panel)]");
    expect(state).toHaveClass("shadow-[var(--octant-shadow-sm)]");
  });
});
