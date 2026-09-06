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

  it("leaves keyboard focus to the one ring the app paints", () => {
    // Focus is a single global treatment (0086). A recipe that painted its own
    // would swap an app control's crisp ring for the style's wide soft halo,
    // one control at a time.
    render(<OctantTextarea aria-label="Notes" />);
    const field = screen.getByRole("textbox", { name: "Notes" });
    expect(field.className).not.toContain("focus-visible:ring");
    expect(field.className).not.toContain("focus-visible:border");
  });
});
