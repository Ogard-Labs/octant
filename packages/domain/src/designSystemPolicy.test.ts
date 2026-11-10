import { describe, expect, it } from "vitest";
import { designBrandDeclarations } from "./canvasDesignFrameKit";
import {
  designSystemInstructions,
  designSystemTemplate,
  primaryDesignSystem,
  readDesignSystem,
  splitDesignSystemFrontMatter,
} from "./designSystemPolicy";

describe("a Project's DESIGN.md", () => {
  it("separates the front matter from the prose and keeps the prose's headings", () => {
    const split = splitDesignSystemFrontMatter(
      "---\nname: Acme\n---\n\n# Acme\n\n## Colour\n\n```\n## not a heading\n```\n## Voice\n",
    );
    expect(split.frontMatter).toBe("name: Acme");
    const reading = readDesignSystem({
      frontMatter: { name: "Acme" },
      hasFrontMatter: true,
      body: split.body,
      fallbackName: "Project",
    });
    expect(reading.name).toBe("Acme");
    expect(reading.sections).toEqual(["Colour", "Voice"]);
  });

  it("reads headings padded with long runs of tabs without slowing down", () => {
    const body = `#\ta${"\t".repeat(200_000)}\u2028\n##\ta${"\t".repeat(200_000)}\u2028\n# Acme\n## x\n`;
    const started = performance.now();
    const reading = readDesignSystem({
      frontMatter: undefined,
      hasFrontMatter: false,
      body,
      fallbackName: "Project",
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(reading.name).toBe("a");
    expect(reading.sections).toHaveLength(2);
    expect(reading.sections.at(-1)).toBe("x");
  });

  it("reads a file with no front matter as prose named by its title", () => {
    const text = "# Field notes\n\n## Colour\n";
    const split = splitDesignSystemFrontMatter(text);
    expect(split.frontMatter).toBeUndefined();
    const reading = readDesignSystem({
      frontMatter: undefined,
      hasFrontMatter: false,
      body: split.body,
      fallbackName: "Project",
    });
    expect(reading).toMatchObject({ name: "Field notes", frontMatter: "absent", tokens: [] });
    expect(reading.brand).toEqual({});
  });

  it("turns colours, type, radii, and spacing into the brand a Canvas design draws with", () => {
    const reading = readDesignSystem({
      frontMatter: {
        name: "Acme",
        colors: { primary: "#1a73e8", onPrimary: "#fff", background: "oklch(98% 0 0)" },
        typography: {
          body: "Geist, Inter, system-ui, sans-serif",
          heading: { fontFamily: "Georgia" },
        },
        rounded: { card: 12 },
        spacing: { md: "16px" },
        components: { button: { radius: "8px" } },
      },
      hasFrontMatter: true,
      body: "",
      fallbackName: "Project",
    });
    expect(reading.brand).toEqual({
      "color-primary": "#1a73e8",
      "color-on-primary": "#fff",
      "color-background": "oklch(98% 0 0)",
      "font-body": "Inter, system-ui, sans-serif",
      "font-heading": "Georgia",
      "radius-card": "12px",
      "space-md": "16px",
    });
    expect(reading.tokens.find((token) => token.token === "font-body")).toMatchObject({
      status: "adjusted",
      value: "Geist, Inter, system-ui, sans-serif",
      carriedValue: "Inter, system-ui, sans-serif",
    });
    expect(reading.ignoredKeys).toEqual(["components"]);
    // Every carried token is one the frame stylesheet writes.
    const declarations = designBrandDeclarations(reading.brand);
    for (const name of Object.keys(reading.brand)) {
      expect(declarations).toContain(`--brand-${name}:`);
    }
  });

  it("refuses a value that could escape its declaration and says why", () => {
    const reading = readDesignSystem({
      frontMatter: {
        colors: { primary: "red; } body { background: url(x)", accent: "#ff0000" },
        typography: { display: "Brand Sans" },
      },
      hasFrontMatter: true,
      body: "",
      fallbackName: "Project",
    });
    expect(reading.brand).toEqual({ "color-accent": "#ff0000" });
    expect(
      reading.tokens.filter((token) => token.status === "refused").map((t) => t.token),
    ).toEqual(["color-primary", "font-display"]);
    expect(
      reading.tokens.every((token) => token.status !== "refused" || token.note !== undefined),
    ).toBe(true);
  });

  it("carries no more tokens than a brand holds", () => {
    const colors = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`c${String(index)}`, "#000000"]),
    );
    const reading = readDesignSystem({
      frontMatter: { colors },
      hasFrontMatter: true,
      body: "",
      fallbackName: "Project",
    });
    expect(Object.keys(reading.brand)).toHaveLength(32);
    expect(reading.tokens.filter((token) => token.status === "refused")).toHaveLength(8);
  });

  it("marks front matter that is not a mapping as invalid", () => {
    const reading = readDesignSystem({
      frontMatter: ["a", "b"],
      hasFrontMatter: true,
      body: "# X",
      fallbackName: "Project",
    });
    expect(reading.frontMatter).toBe("invalid");
  });

  it("seeds a template whose every token reaches Canvas", () => {
    const split = splitDesignSystemFrontMatter(designSystemTemplate("Acme"));
    expect(split.frontMatter).toContain("colors:");
    expect(split.body.startsWith("# Acme")).toBe(true);
  });

  it("takes the top-level file as the Project's design system, else the only one", () => {
    const top = { folder: "/p", path: "DESIGN.md" };
    const nested = { folder: "/p", path: "apps/web/DESIGN.md" };
    const other = { folder: "/p", path: "apps/site/DESIGN.md" };
    expect(primaryDesignSystem([nested, top], "/p")).toBe(top);
    expect(primaryDesignSystem([nested], "/p")).toBe(nested);
    expect(primaryDesignSystem([nested, other], "/p")).toBeUndefined();
    expect(
      primaryDesignSystem([{ folder: "/extra", path: "DESIGN.md" }, nested], "/p"),
    ).toBeUndefined();
  });

  it("tells a turn where every other design system lives", () => {
    const text = designSystemInstructions({
      primary: { folder: "/p", path: "DESIGN.md" },
      others: [
        { folder: "/p", path: "apps/web/DESIGN.md" },
        { folder: "/extra", path: "DESIGN.md" },
      ],
      mainFolder: "/p",
    });
    expect(text).toContain("apps/web/DESIGN.md, /extra/DESIGN.md");
    expect(text).toContain("nearest one above a file wins");
  });
});
