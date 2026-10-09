import { CANVAS_SCHEMA_VERSION, decodeCanvasDefinition } from "@octant/contracts/canvas";
import { decodeCanvasDocumentRecipe } from "@octant/contracts/canvas-skill";
import { canvasRecipeStarterBlocks } from "@octant/domain/canvas-recipe-starter";
import { describe, expect, it } from "vitest";
import { inTreeCanvasDocumentRecipes } from "./canvasDocumentRecipes";

describe("in-tree Canvas document recipes", () => {
  it("offers the planned set, each with a one-line summary for the chooser", () => {
    const recipes = inTreeCanvasDocumentRecipes();
    const ids = recipes.map((recipe) => String(recipe.id));
    for (const planned of [
      "implementation-plan",
      "design-spec",
      "architecture-review",
      "code-review",
      "audit-report",
      "postmortem",
      "research-brief",
      "dashboard",
    ]) {
      expect(ids).toContain(planned);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const recipe of recipes) expect(recipe.summary).toBeDefined();
  });

  it("weighs an architecture review's options in a comparison matrix", () => {
    const review = inTreeCanvasDocumentRecipes().find(
      (recipe) => String(recipe.id) === "architecture-review",
    );
    expect(review?.skeleton.map((block) => block.kind)).toContain("comparison-matrix");
  });

  it("validates every recipe and opens each one as a valid Canvas at the current schema", () => {
    for (const recipe of inTreeCanvasDocumentRecipes()) {
      expect(decodeCanvasDocumentRecipe(recipe)).toEqual(recipe);
      const definition = decodeCanvasDefinition({
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: recipe.title,
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
      });
      expect(definition.blocks).toHaveLength(recipe.skeleton.length);
    }
  });
});
