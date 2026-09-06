import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantSeparator } from "./OctantSeparator";

describe("OctantSeparator", () => {
  it("publishes the orientation the rule that gives it size selects on", () => {
    // The recipe sizes itself with `data-[orientation=…]`. The upstream style
    // writes that as a `data-horizontal:` shorthand, which is a custom variant
    // defined in a stylesheet this repo does not import — it would compile to
    // an attribute nothing sets and leave the rule with no height. Assert the
    // attribute and the selector agree, so that swap cannot land silently.
    const { rerender } = render(<OctantSeparator aria-label="Section break" />);
    const rule = screen.getByRole("separator", { name: "Section break" });
    expect(rule).toHaveAttribute("data-orientation", "horizontal");
    expect(rule.className).toContain("data-[orientation=horizontal]:h-px");

    rerender(<OctantSeparator aria-label="Section break" orientation="vertical" />);
    expect(screen.getByRole("separator", { name: "Section break" })).toHaveAttribute(
      "data-orientation",
      "vertical",
    );
  });
});
