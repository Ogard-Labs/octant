import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantInput } from "./OctantInput";

describe("OctantInput", () => {
  it("wears the frame and the themed placeholder on an ordinary form field", () => {
    render(<OctantInput aria-label="Name" />);
    const field = screen.getByRole("textbox", { name: "Name" });
    expect(field.className).toContain("border-input");
    expect(field.className).toContain("placeholder:text-muted-foreground");
  });

  it("drops only the frame when a feature draws the box itself", () => {
    render(<OctantInput aria-label="Search" unstyled />);
    const field = screen.getByRole("textbox", { name: "Search" });
    expect(field.className).not.toContain("border-input");
    expect(field.className).not.toContain("rounded-lg");
    expect(field.className).not.toContain("hover:border");
    expect(field.className).not.toContain("focus-visible:bg");
    expect(field.className).toContain("placeholder:text-muted-foreground");
    expect(field.className).toContain("selection:bg-primary");
  });
});
