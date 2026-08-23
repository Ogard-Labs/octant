import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderGlyph } from "./ProviderGlyph";

describe("ProviderGlyph", () => {
  it("renders the bundled provider-owned mark without a network image", () => {
    const { container } = render(
      <span title="Codex">
        <ProviderGlyph displayName="Codex" driverKind="codex" size={14} />
      </span>,
    );

    const glyph = container.querySelector(".provider-glyph--brand");
    expect(glyph).toHaveAttribute("data-driver-kind", "codex");
    expect(glyph).toHaveStyle({ width: "14px", height: "14px" });
    expect(glyph?.getAttribute("style")).toContain("mask-image: url(");
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses a compact monogram when a compatible endpoint has no truthful brand", () => {
    render(<ProviderGlyph displayName="Internal Gateway" driverKind="openai-compatible" />);

    expect(screen.getByText("IG")).toHaveClass("provider-glyph--monogram");
  });
});
