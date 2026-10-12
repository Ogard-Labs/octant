import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION, decodeCanvasDefinition } from "@octant/contracts/canvas";
import { decodeCanvasDocumentRecipe } from "@octant/contracts/canvas-skill";
import { validateCanvasDefinition } from "./canvasPolicy";
import { canvasRecipeStarterBlocks } from "./canvasRecipeStarter";

const definitionWith = (blocks: ReadonlyArray<unknown>) => ({
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Starter",
  provenance: {
    mode: "chat",
    hostId: "local",
    projectId: "11111111-1111-4111-8111-111111111111",
    threadId: "22222222-2222-4222-8222-222222222222",
    actor: { kind: "local-user", actorId: "33333333-3333-4333-8333-333333333333" },
    providerInstanceId: "44444444-4444-4444-8444-444444444444",
    modelId: "octant-local",
    createdAt: "2026-10-08T00:00:00.000Z",
  },
  sourceManifest: [],
  blocks,
});

const recipe = decodeCanvasDocumentRecipe({
  id: "decision-record",
  title: "Decision record",
  whenToUse: "When someone asks to record a decision.",
  skeleton: [
    { kind: "heading", role: "Options" },
    { kind: "comparison-matrix", role: "The options against the criteria." },
    { kind: "rich-text", role: "The decision." },
  ],
});

describe("canvasRecipeStarterBlocks", () => {
  it("opens a recipe as headings and one placeholder per role, in skeleton order", () => {
    const blocks = canvasRecipeStarterBlocks(recipe);
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "callout", "callout"]);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2, text: "Options" });
    expect(blocks[1]).toMatchObject({
      kind: "callout",
      tone: "info",
      title: "To fill: comparison matrix",
      text: "The options against the criteria.",
    });
    expect(new Set(blocks.map((block) => String(block.blockId))).size).toBe(blocks.length);
  });

  it("never writes invented content into a placeholder for a data block", () => {
    const blocks = canvasRecipeStarterBlocks(recipe);
    // A matrix with made-up scores would read as a finding; the starter only
    // says what belongs there.
    expect(blocks.some((block) => block.kind === "comparison-matrix")).toBe(false);
  });

  it("opens a document-size design slot as a themed document with headings that wait for content", () => {
    const article = decodeCanvasDocumentRecipe({
      id: "article",
      title: "Article",
      whenToUse: "When someone asks for an article.",
      skeleton: [
        { kind: "design", size: "document", role: "The article: a title, a lede, sections." },
      ],
    });
    const [block] = canvasRecipeStarterBlocks(article);
    expect(block).toMatchObject({ kind: "design", size: "document", title: "Article" });
    if (block?.kind !== "design") throw new Error("The article did not open as a design.");
    // Drawn in the workspace theme, which is a document's default.
    expect(block.theme).toBeUndefined();
    const html = block.frames.map((frame) => frame.html).join("");
    expect(html).toContain('<article class="oct-article">');
    expect(html).toContain("<h1>Article</h1>");
    expect(html).toContain("<h2>");
    expect(html).toContain("The article: a title, a lede, sections.");
    expect(validateCanvasDefinition(definitionWith([block])).blocks).toHaveLength(1);
  });

  it("writes a recipe's title and role into the frame as text, never as markup", () => {
    const hostile = decodeCanvasDocumentRecipe({
      id: "hostile",
      title: 'Notes <img src=x onerror="alert(1)">',
      whenToUse: "When a skill offers notes.",
      skeleton: [{ kind: "design", size: "document", role: "<script>alert(1)</script> & more" }],
    });
    const [block] = canvasRecipeStarterBlocks(hostile);
    if (block?.kind !== "design") throw new Error("The recipe did not open as a design.");
    const html = block.frames.map((frame) => frame.html).join("");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(() => validateCanvasDefinition(definitionWith([block]))).not.toThrow();
  });

  it("keeps a design slot that names no size, or a device size, as a placeholder to fill", () => {
    const screens = decodeCanvasDocumentRecipe({
      id: "screens",
      title: "Screens",
      whenToUse: "When someone asks for screens.",
      skeleton: [
        { kind: "design", role: "One frame per screen." },
        { kind: "design", size: "phone", role: "One phone frame per screen." },
      ],
    });
    expect(canvasRecipeStarterBlocks(screens).map((block) => block.kind)).toEqual([
      "callout",
      "callout",
    ]);
  });

  it("is a valid document at the current Canvas schema", () => {
    expect(() =>
      decodeCanvasDefinition({
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: "Decision record",
        provenance: {
          mode: "chat",
          hostId: "local",
          projectId: "11111111-1111-4111-8111-111111111111",
          threadId: "22222222-2222-4222-8222-222222222222",
          actor: { kind: "local-user", actorId: "33333333-3333-4333-8333-333333333333" },
          providerInstanceId: "44444444-4444-4444-8444-444444444444",
          modelId: "octant-local",
          createdAt: "2026-10-08T00:00:00.000Z",
        },
        sourceManifest: [],
        blocks: canvasRecipeStarterBlocks(recipe),
      }),
    ).not.toThrow();
  });
});
