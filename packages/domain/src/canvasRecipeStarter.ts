import {
  CANVAS_MAX_MOCKUP_TEXT_LENGTH,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import type { CanvasDocumentRecipe } from "@octant/contracts/canvas-skill";

/**
 * The document a Canvas opens with when a person starts it from a recipe.
 *
 * A heading role is already a section name, so it becomes that heading. A
 * design slot drawn as a document becomes that document: a themed frame with
 * the recipe's title and section headings that wait for content, because an
 * article starts as a page, not as a note about one. Every other role becomes
 * an info callout that names the block kind it is waiting for and what that
 * block is for. The starter never draws a data block itself: a metric,
 * matrix, or timeline with made-up values would read as a finding, and a
 * person or the agent filling the Canvas replaces the placeholder with the
 * real block on the next version.
 */
export function canvasRecipeStarterBlocks(
  recipe: CanvasDocumentRecipe,
): ReadonlyArray<CanvasBlock> {
  return recipe.skeleton.map((entry, index) => {
    const blockId = `recipe-${index + 1}`;
    if (entry.kind === "heading") {
      return decodeCanvasBlock({
        blockId,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "heading",
        level: 2,
        text: entry.role,
      });
    }
    if (entry.kind === "design" && entry.size === "document") {
      // A recipe's title may be longer than a design's; the page keeps all of
      // it in its heading and the design is named by as much as fits.
      const title = recipe.title.slice(0, CANVAS_MAX_MOCKUP_TEXT_LENGTH).trim();
      return decodeCanvasBlock({
        blockId,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "design",
        title,
        size: "document",
        frames: [
          {
            frameId: "document",
            title,
            html: [
              '<article class="oct-article">',
              '<p class="oct-eyebrow">To fill</p>',
              `<h1>${text(recipe.title)}</h1>`,
              `<p class="oct-lede">${text(entry.role)}</p>`,
              "<h2>First section</h2>",
              "<p>Write this section.</p>",
              "<h2>Next section</h2>",
              "<p>Write this section.</p>",
              "</article>",
            ].join(""),
          },
        ],
      });
    }
    return decodeCanvasBlock({
      blockId,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "callout",
      tone: "info",
      title: `To fill: ${entry.kind.replaceAll("-", " ")}`,
      text: entry.role,
    });
  });
}

// A recipe's words are text. A contributed recipe is a skill's data, and a
// frame is markup, so nothing in a title or a role may be read as an element.
function text(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
