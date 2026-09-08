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

  it("draws an original mark for the BFL image kind instead of falling back to a monogram", () => {
    const { container } = render(
      <ProviderGlyph displayName="FLUX" driverKind="bfl-image" size={14} />,
    );

    const glyph = container.querySelector("svg.provider-glyph");
    expect(glyph).toHaveAttribute("data-driver-kind", "bfl-image");
    expect(container.querySelector(".provider-glyph--monogram")).toBeNull();
  });

  it("draws an original mark for the Ideogram image kind instead of falling back to a monogram", () => {
    const { container } = render(
      <ProviderGlyph displayName="Ideogram" driverKind="ideogram-image" size={14} />,
    );

    const glyph = container.querySelector("svg.provider-glyph");
    expect(glyph).toHaveAttribute("data-driver-kind", "ideogram-image");
    expect(container.querySelector(".provider-glyph--monogram")).toBeNull();
  });

  it.each([
    ["claude", "Claude Code"],
    ["codex", "Codex CLI"],
    ["devin", "Devin ACP"],
    ["grok", "Grok Build"],
    ["kilo", "Kilo ACP"],
    ["kimi-code", "Kimi Code CLI"],
    ["mistral-vibe", "Mistral Vibe ACP"],
    ["opencode", "OpenCode CLI"],
    ["pi", "Pi RPC"],
    ["copilot", "GitHub Copilot"],
  ] as const)("uses a bundled brand mark for %s", (driverKind, displayName) => {
    const { container } = render(
      <ProviderGlyph displayName={displayName} driverKind={driverKind} size={16} />,
    );

    const glyph = container.querySelector("svg.provider-glyph");
    expect(glyph).toHaveAttribute("viewBox");
    expect(glyph).not.toHaveAttribute("viewBox", "0 0 16 16");
    expect(glyph?.querySelector("path")).toHaveAttribute("fill", "currentColor");
  });
});
