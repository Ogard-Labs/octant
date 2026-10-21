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
      "memo",
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

  it("offers an architecture diagram and a UI kit built only from block kinds the catalogue has", () => {
    const recipes = new Map(
      inTreeCanvasDocumentRecipes().map((recipe) => [String(recipe.id), recipe] as const),
    );
    const architecture = recipes.get("architecture-diagram");
    const uiKit = recipes.get("ui-kit");
    if (architecture === undefined || uiKit === undefined) {
      throw new Error("The architecture diagram or UI kit recipe is not offered.");
    }
    // The system as grouped tiers, one flow through it, and the decisions behind it.
    const architectureKinds = architecture.skeleton.map((block) => block.kind);
    expect(architectureKinds).toContain("diagram");
    expect(architectureKinds).toContain("sequence");
    expect(architectureKinds).toContain("table");
    expect(architecture.skeleton.find((block) => block.kind === "diagram")?.role).toContain("tier");
    // Tokens as a table the person can sort, and the components as one sheet.
    const uiKitKinds = uiKit.skeleton.map((block) => block.kind);
    expect(uiKitKinds).toContain("table");
    expect(uiKit.skeleton.find((block) => block.kind === "design")).toMatchObject({
      size: "document",
    });
    expect(uiKit.skeleton.find((block) => block.kind === "design")?.role).toContain("state");
    // The skeleton schema admits only kinds the block catalogue has today.
    for (const recipe of [architecture, uiKit]) {
      expect(decodeCanvasDocumentRecipe(recipe)).toEqual(recipe);
    }
  });

  it("shapes a memo from typed blocks alone, so the reader can comment on and revise each part", () => {
    const memo = inTreeCanvasDocumentRecipes().find((recipe) => String(recipe.id) === "memo");
    if (memo === undefined) throw new Error("The memo recipe is not offered.");
    expect(memo.whenToUse).toContain("one-pager");
    const kinds = memo.skeleton.map((block) => block.kind);
    expect(kinds).not.toContain("design");
    expect(kinds[0]).toBe("heading");
    expect(kinds).toContain("key-value");
    expect(kinds.at(-1)).toBe("callout");
  });

  it("offers an app redesign prototype drawn as a running desktop window", () => {
    const recipe = inTreeCanvasDocumentRecipes().find(
      (candidate) => String(candidate.id) === "app-redesign-prototype",
    );
    expect(recipe?.skeleton[0]).toMatchObject({ kind: "design", size: "desktop" });
    expect(recipe?.skeleton[0]?.role).toContain("runsScript");
    expect(recipe?.skeleton[0]?.role).toContain("designEdits");
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
