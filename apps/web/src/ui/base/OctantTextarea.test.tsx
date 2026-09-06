import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantTextarea } from "./OctantTextarea";

describe("OctantTextarea", () => {
  it("wears the field recipe on an ordinary form field", () => {
    render(<OctantTextarea aria-label="Notes" />);
    const field = screen.getByRole("textbox", { name: "Notes" });
    expect(field.className).toContain("rounded-lg");
    expect(field.className).toContain("border-input");
  });

  it("does not wear the field recipe when it is a composer prompt", () => {
    render(<OctantTextarea aria-label="First message" className="composer-input" />);
    const field = screen.getByRole("textbox", { name: "First message" });
    expect(field.className).toContain("composer-input");
    expect(field.className).not.toContain("rounded-lg");
    expect(field.className).not.toContain("border-input");
  });

  it("paints its own keyboard focus, which the global rule then leaves alone", () => {
    // The recipe owns focus as ordinary state (0086). The global
    // `:focus-visible` rule is scoped away from anything carrying a
    // `data-slot`, so this halo is the only one and the field keeps its shape.
    render(<OctantTextarea aria-label="Notes" />);
    const field = screen.getByRole("textbox", { name: "Notes" });
    expect(field).toHaveAttribute("data-slot", "textarea");
    expect(field.className).toContain("focus-visible:ring-ring/50");
  });
});
