import { describe, expect, it } from "vitest";
import { DESIGN_FRAME_THEME_TOKENS, designBrandDeclarations } from "./canvasDesignFrameKit";

describe("brand declarations", () => {
  it("writes each brand token as a custom property and on the kit roles it names", () => {
    const css = designBrandDeclarations({
      "color-primary": "#0a7d5a",
      "font-heading": "georgia, serif",
      "radius-card": "14px",
    });
    expect(css).toContain("--brand-color-primary: #0a7d5a;");
    expect(css).toContain("--brand-font-heading: georgia, serif;");
    expect(css).toContain("--oct-accent: #0a7d5a;");
    expect(css).toContain("--oct-series-1: #0a7d5a;");
    expect(css).toContain("--oct-radius-md: 14px;");
    // The base value of a role the brand names is replaced, not repeated.
    expect(css.match(/--oct-accent:/g)).toHaveLength(1);
  });

  it("gives every kit role a value even when the brand names none", () => {
    const css = designBrandDeclarations({});
    for (const token of DESIGN_FRAME_THEME_TOKENS) {
      expect(css).toContain(`${token}:`);
    }
  });

  it("leaves out a token that could end a declaration, load something, or is not a token", () => {
    const css = designBrandDeclarations({
      "color-primary": "red; } body { display: none",
      "color-secondary": "url(https://example.com/a.png)",
      "font-body": "Some Web Font",
      "radius-card": "10px",
      "x-evil": "#000000",
      "color-text }": "#000000",
    });
    expect(css).not.toContain("display");
    expect(css).not.toContain("url(");
    expect(css).not.toContain("Web Font");
    expect(css).not.toContain("x-evil");
    expect(css).not.toContain("}");
    expect(css).toContain("--brand-radius-card: 10px;");
  });
});
