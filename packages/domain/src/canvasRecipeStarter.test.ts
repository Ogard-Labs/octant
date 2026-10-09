import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION, decodeCanvasDefinition } from "@octant/contracts/canvas";
import { decodeCanvasDocumentRecipe } from "@octant/contracts/canvas-skill";
import { canvasRecipeStarterBlocks } from "./canvasRecipeStarter";

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
