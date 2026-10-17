import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantInput } from "./OctantInput";
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

  it("keeps focus classes free of drawn ring utilities", () => {
    // Focus stays keyboard-addressable while the app keeps the visual state
    // quiet; a recipe must not add its own halo.
    render(<OctantTextarea aria-label="Notes" />);
    const field = screen.getByRole("textbox", { name: "Notes" });
    expect(field.className).not.toContain("focus-visible:ring");
    expect(field.className).not.toContain("focus-visible:border");
  });

  it("rests, hovers and takes focus like a single-line input", () => {
    render(
      <>
        <OctantInput aria-label="Name" />
        <OctantTextarea aria-label="Notes" />
      </>,
    );
    const paint = (name: string) =>
      screen
        .getByRole("textbox", { name })
        .className.split(/\s+/)
        .filter((token) => /^(hover:|focus-visible:|border|bg-|rounded)/.test(token))
        .sort();
    expect(paint("Notes")).toEqual(paint("Name"));
    expect(paint("Notes")).toContain("hover:border-muted-foreground");
    expect(paint("Notes")).toContain("focus-visible:bg-accent");
  });
});
