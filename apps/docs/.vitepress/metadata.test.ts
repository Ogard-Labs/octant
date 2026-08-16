import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCS_SITE_URL,
  createPageHead,
  pageUrlFor,
  normalizeDocsSiteUrl,
} from "./metadata";

describe("documentation metadata", () => {
  it("normalizes the independently deployable site URL", () => {
    expect(normalizeDocsSiteUrl("https://docs.octant.dev")).toBe("https://docs.octant.dev/");
    expect(() => normalizeDocsSiteUrl("/docs/")).toThrow("absolute URL");
  });

  it("maps index and nested Markdown pages to clean canonical URLs", () => {
    expect(pageUrlFor("index.md", DEFAULT_DOCS_SITE_URL)).toBe(DEFAULT_DOCS_SITE_URL);
    expect(pageUrlFor("guide/index.md", DEFAULT_DOCS_SITE_URL)).toBe(
      `${DEFAULT_DOCS_SITE_URL}guide/`,
    );
    expect(pageUrlFor("concepts/providers.md", DEFAULT_DOCS_SITE_URL)).toBe(
      `${DEFAULT_DOCS_SITE_URL}concepts/providers`,
    );
  });

  it("creates stable Open Graph and canonical head entries", () => {
    expect(
      createPageHead({
        relativePath: "guide/index.md",
        title: "Guide",
        description: "Start with Octant.",
        siteUrl: DEFAULT_DOCS_SITE_URL,
      }),
    ).toEqual([
      ["link", { rel: "canonical", href: `${DEFAULT_DOCS_SITE_URL}guide/` }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:title", content: "Guide | Octant Docs" }],
      ["meta", { property: "og:description", content: "Start with Octant." }],
      ["meta", { property: "og:url", content: `${DEFAULT_DOCS_SITE_URL}guide/` }],
    ]);
  });

  it("uses the site title for the home page when VitePress has no page title", () => {
    expect(
      createPageHead({
        relativePath: "index.md",
        title: "",
        description: "Octant docs.",
        siteUrl: DEFAULT_DOCS_SITE_URL,
      })[2],
    ).toEqual(["meta", { property: "og:title", content: "Octant Docs" }]);
  });
});
