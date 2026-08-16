import { describe, expect, it } from "vitest";
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_ROLE_IDS,
} from "@octant/theme/tokens";
import { createSemanticTokenCss } from "./semanticTokens";

describe("documentation semantic tokens", () => {
  it("emits every shared light and dark role as a CSS custom property", () => {
    const css = createSemanticTokenCss();

    for (const role of THEME_TOKEN_ROLE_IDS) {
      expect(css).toContain(`--octant-docs-${role}: ${DEFAULT_LIGHT_TOKENS[role]};`);
      expect(css).toContain(`--octant-docs-${role}: ${DEFAULT_DARK_TOKENS[role]};`);
    }
  });

  it("keeps the light/dark shells explicit and operationally branded", () => {
    const css = createSemanticTokenCss();
    const upstreamName = ["syn", "ara"].join("");

    expect(css).toContain(":root {");
    expect(css).toContain(".dark {");
    expect(css).toContain("color-scheme: light;");
    expect(css).toContain("color-scheme: dark;");
    expect(css.toLowerCase()).not.toContain(upstreamName);
  });
});
