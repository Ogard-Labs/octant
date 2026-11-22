import { describe, expect, it } from "vitest";
import {
  DESIGN_FRAME_THEME_TOKENS,
  designBrandDeclarations,
  withDrawnDesignAssetAddresses,
} from "./canvasDesignFrameKit";

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

describe("drawn design asset references", () => {
  const drawn = (markup: string, language: "html" | "css") => {
    const ids: string[] = [];
    withDrawnDesignAssetAddresses(markup, language, (id) => {
      ids.push(id);
      return "data:,";
    });
    return ids;
  };

  it("skips references a browser would never draw because they sit in a comment", () => {
    expect(
      drawn(
        [
          '<!-- <img src="octant-asset:html-comment"> -->',
          "<div style=/*background:url(octant-asset:unquoted-style)*/color:red></div>",
          '<div style="color:red; /* background:url(octant-asset:quoted-style) */"></div>',
          "<style>/* .x { background: url(octant-asset:style-comment) } */</style>",
          '<script>/* el.src = "octant-asset:script-block" */ // <img src="octant-asset:script-line">\n</script>',
        ].join(""),
        "html",
      ),
    ).toEqual([]);
    expect(drawn("/* .x { background: url(octant-asset:old) } */", "css")).toEqual([]);
  });

  it("draws references after comment markers that are only text or strings", () => {
    expect(
      drawn(
        [
          '<p>Matches docs/*</p><img src="octant-asset:after-text">',
          "<style>/* opening marker: <!-- */ .hero { background: url(octant-asset:after-css-comment) }</style>",
          '<div class="hero" style="background:url(octant-asset:style-value)">Home</div>',
        ].join(""),
        "html",
      ),
    ).toEqual(["after-text", "after-css-comment", "style-value"]);
    expect(
      drawn(
        '.a::before { content: "/*"; } .b { background: url(octant-asset:after-string) }',
        "css",
      ),
    ).toEqual(["after-string"]);
    // A quote in a regular expression opens no string; every line terminator
    // and newline reference ends a line comment.
    expect(
      drawn(
        [
          `<button onclick="this.title = this.title.replace(/&quot;/g, ''); /* url(octant-asset:after-regex) */">C</button>`,
          `<button onclick="&#47;&#47; on click&#13;this.style.backgroundImage = 'url(octant-asset:after-cr)'">D</button>`,
          `<button onclick="&#47;&#47; on click&NewLine;this.style.backgroundImage = 'url(octant-asset:after-newline)'">E</button>`,
          `<button onclick="&#47;&#47; on click&#10this.style.backgroundImage = 'url(octant-asset:after-bare-reference)'">F</button>`,
        ].join(""),
        "html",
      ),
    ).toEqual(["after-cr", "after-newline", "after-bare-reference"]);
    // Text-only elements hold text, not markup.
    expect(
      drawn(
        '<textarea><img src="octant-asset:in-textarea"></textarea><xmp><img src="octant-asset:in-xmp"></xmp><img src="octant-asset:after">',
        "html",
      ),
    ).toEqual(["after"]);
  });

  it("does not draw a reference written as text or in an attribute that loads no image", () => {
    expect(
      drawn(
        [
          '<p>Example: src="octant-asset:in-text"</p>',
          '<img alt="Example: src=octant-asset:in-alt" src="octant-asset:shown">',
          '<a title="url(octant-asset:in-title)" href="#home">Home</a>',
          // A backslash does not escape a quote in HTML: the comment after this still hides.
          '<p title="C:\\">Drive</p><!-- <img src=octant-asset:old> -->',
          // A custom element named like a script holds HTML.
          '<script-preview><code>// Example</code><img src="octant-asset:in-custom"></script-preview>',
        ].join(""),
        "html",
      ),
    ).toEqual(["shown", "in-custom"]);
    // A running design's event handler is script, and its references draw.
    expect(
      drawn(
        `<button onclick="this.style.backgroundImage='url(octant-asset:on-click)' /* url(octant-asset:old) */">Go</button>`,
        "html",
      ),
    ).toEqual(["on-click"]);
    // The browser decodes a handler's character references before running it.
    expect(
      drawn(
        [
          `<button onclick="this.title = &quot;https://example.com&quot;; this.style.backgroundImage = 'url(octant-asset:after-string)'">A</button>`,
          `<button onclick="this.title = &quot;It's ready&quot;; /* url(octant-asset:in-comment) */">B</button>`,
        ].join(""),
        "html",
      ),
    ).toEqual(["after-string"]);
  });
});
