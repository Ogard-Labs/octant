import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderGlyph } from "./ProviderGlyph";

describe("ProviderGlyph", () => {
  it("renders an Octant-owned bundled mark without a network image", () => {
    const { container } = render(
      <span title="Codex">
        <ProviderGlyph displayName="Codex" driverKind="codex" size={14} />
      </span>,
    );

    const glyph = container.querySelector("svg.provider-glyph");
    expect(glyph).toHaveAttribute("data-driver-kind", "codex");
    expect(glyph).toHaveAttribute("width", "14");
    expect(glyph).toHaveAttribute("height", "14");
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses a compact monogram when a compatible endpoint has no truthful brand", () => {
    render(<ProviderGlyph displayName="Internal Gateway" driverKind="future-provider" />);

    expect(screen.getByText("IG")).toHaveClass("provider-glyph--monogram");
  });
});
