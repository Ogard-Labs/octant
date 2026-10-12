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

  it("offers an article, a design brief, a design system, and a clickable prototype", () => {
    const recipes = new Map(
      inTreeCanvasDocumentRecipes().map((recipe) => [String(recipe.id), recipe] as const),
    );
    for (const id of ["article", "design-brief", "design-system", "clickable-prototype"]) {
      expect(recipes.get(id)?.summary, id).toBeDefined();
    }
    // The brief arranges typed blocks in tabs; the prototype is a design that runs.
    expect(recipes.get("design-brief")?.skeleton.map((block) => block.kind)).toContain("tabs");
    expect(recipes.get("clickable-prototype")?.skeleton[0]).toMatchObject({ kind: "design" });
    expect(recipes.get("clickable-prototype")?.skeleton[0]?.role).toContain("runsScript");
  });

  it("opens the article recipe as a themed document frame with headings that wait for content", () => {
    const article = inTreeCanvasDocumentRecipes().find((recipe) => String(recipe.id) === "article");
    if (article === undefined) throw new Error("The article recipe is not offered.");
    const [frame] = canvasRecipeStarterBlocks(article);
    expect(frame).toMatchObject({ kind: "design", size: "document" });
    if (frame?.kind !== "design") throw new Error("The article did not open as a design.");
    expect(frame.frames[0]?.html).toContain("<h1>Article</h1>");
    expect(frame.frames[0]?.html).toContain("<h2>");
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
