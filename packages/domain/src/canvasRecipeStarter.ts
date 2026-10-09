import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import type { CanvasDocumentRecipe } from "@octant/contracts/canvas-skill";

/**
 * The document a Canvas opens with when a person starts it from a recipe.
 *
 * A heading role is already a section name, so it becomes that heading. Every
 * other role becomes an info callout that names the block kind it is waiting
 * for and what that block is for. The starter never draws the data block
 * itself: a metric, matrix, or timeline with made-up values would read as a
 * finding, and a person or the agent filling the Canvas replaces the
 * placeholder with the real block on the next version.
 */
export function canvasRecipeStarterBlocks(
  recipe: CanvasDocumentRecipe,
): ReadonlyArray<CanvasBlock> {
  return recipe.skeleton.map((entry, index) =>
    decodeCanvasBlock(
      entry.kind === "heading"
        ? {
            blockId: `recipe-${index + 1}`,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "heading",
            level: 2,
            text: entry.role,
          }
        : {
            blockId: `recipe-${index + 1}`,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "callout",
            tone: "info",
            title: `To fill: ${entry.kind.replaceAll("-", " ")}`,
            text: entry.role,
          },
    ),
  );
}
