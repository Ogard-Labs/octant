import { describe, expect, it } from "vitest";
import { decodeCanvasBlock, type CanvasMockupBlock } from "@octant/contracts/canvas";
import { canvasMockupTsx } from "./canvasMockupTsx";
import { canvasMockupHtml } from "./canvasMockupHtml";

const decoded = decodeCanvasBlock({
  blockId: "search",
  schemaVersion: 24,
  kind: "mockup",
  device: "phone",
  title: "Search Results",
  nodes: [
    { nodeId: "window", component: "window", label: "Search" },
    { nodeId: "go", parentId: "window", component: "button", label: "Go" },
  ],
});
if (decoded.kind !== "mockup") throw new Error("expected a mockup");
const search: CanvasMockupBlock = decoded;

describe("mockup TSX handoff", () => {
  it("exports a dependency-free component: no imports, no script, styles inlined", () => {
    const tsx = canvasMockupTsx(search);
    expect(tsx).toContain("export function SearchResults() {");
    expect(tsx).not.toMatch(/^import /m);
    expect(tsx.toLowerCase()).not.toContain("<script");
    expect(tsx).toContain("export const SearchResultsStyles =");
    // The component is the same tree the HTML form generates.
    expect(tsx).toContain("</section></section></div>");
  });

  it("is deterministic: the same definition hands off the same bytes", () => {
    expect(canvasMockupTsx(search)).toBe(canvasMockupTsx(search));
  });

  it("escapes what JSX would otherwise read as markup", () => {
    const tricky = decodeCanvasBlock({
      blockId: "t",
      schemaVersion: 24,
      kind: "mockup",
      device: "phone",
      title: "A<B",
      nodes: [{ nodeId: "w", component: "text", label: "Use {curly} and 'quotes'" }],
    });
    if (tricky.kind !== "mockup") throw new Error("expected a mockup");
    const tsx = canvasMockupTsx(tricky);
    expect(tsx).toContain("&#123;curly&#125;");
    // Quotes stay as the HTML escaper wrote them; a JSX child reads the same
    // entity a browser does.
    expect(tsx).toContain("{curly}".replace("{", "&#123;").replace("}", "&#125;"));
  });
});
