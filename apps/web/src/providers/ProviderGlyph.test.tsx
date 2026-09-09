import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderGlyph } from "./ProviderGlyph";
import { PROVIDER_LOGOS } from "./providerLogoPaths";

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

  it.each(["anthropic-compatible", "openai-compatible"])(
    "keeps %s as a neutral monogram because its endpoint brand is unknown",
    (driverKind) => {
      render(<ProviderGlyph displayName="Custom Endpoint" driverKind={driverKind} />);

      expect(screen.getByText("CE")).toHaveClass("provider-glyph--monogram");
    },
  );

  it("renders the bundled BFL identity mark", () => {
    const { container } = render(
      <ProviderGlyph displayName="FLUX" driverKind="bfl-image" size={14} />,
    );

    const glyph = container.querySelector("svg.provider-glyph");
    expect(glyph).toHaveAttribute("data-driver-kind", "bfl-image");
    expect(container.querySelector(".provider-glyph--monogram")).toBeNull();
  });

  it("renders the bundled Ideogram identity mark", () => {
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
    ["oh-my-pi", "Oh My Pi"],
    ["pi", "Pi RPC"],
    ["copilot", "GitHub Copilot"],
    ["goose", "Goose ACP"],
    ["glm", "GLM Agent"],
  ] as const)("uses a bundled brand mark for %s", (driverKind, displayName) => {
    const { container } = render(
      <ProviderGlyph displayName={displayName} driverKind={driverKind} size={16} />,
    );

    const glyph = container.querySelector("svg.provider-glyph");
    expect(glyph).toHaveAttribute("viewBox");
    expect(glyph).not.toHaveAttribute("viewBox", "0 0 16 16");
    const mark = glyph?.querySelector("path");
    if (mark === null || mark === undefined) {
      expect(glyph?.querySelector("g")).not.toBeNull();
    } else {
      expect(mark).toHaveAttribute("fill", "currentColor");
    }
  });

  it("keeps exact source and license metadata beside every bundled mark", () => {
    for (const [driverKind, spec] of Object.entries(PROVIDER_LOGOS)) {
      expect(spec.source.source, driverKind).toMatch(/^https:\/\//);
      expect(spec.source.license, driverKind).not.toHaveLength(0);
    }

    const pi = PROVIDER_LOGOS.pi;
    const grok = PROVIDER_LOGOS.grok;
    if (pi === undefined || grok === undefined) throw new Error("expected bundled marks");
    expect(pi.source.license).toContain("not stated");
    expect(grok.source.source).toContain("/logos/grok-icon/");
    expect(PROVIDER_LOGOS["oh-my-pi"]?.source.license).toBe("MIT");
    expect(PROVIDER_LOGOS.goose?.source.license).toBe("Apache-2.0");
    expect(PROVIDER_LOGOS.glm?.source.license).toBe("Apache-2.0");
    expect(PROVIDER_LOGOS["bfl-image"]?.source.license).toBe("MIT");
    expect(PROVIDER_LOGOS["bfl-image"]?.source.source).toContain("/icons/bfl.svg");
    expect(PROVIDER_LOGOS["ideogram-image"]?.source.license).toBe("MIT");
    expect(PROVIDER_LOGOS["ideogram-image"]?.source.source).toContain("/icons/ideogram.svg");
  });
});
