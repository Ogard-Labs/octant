import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantBadge } from "./OctantBadge";

describe("OctantBadge", () => {
  it("renders status as a compact label instead of a filled pill", () => {
    render(<OctantBadge variant="warning">Waiting</OctantBadge>);

    const badge = screen.getByText("Waiting");
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge).toHaveClass("rounded-[4px]", "px-1.5", "text-[10px]", "bg-transparent");
    expect(badge).not.toHaveClass("rounded-full");
  });
});
