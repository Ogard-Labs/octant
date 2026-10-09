import {
  decodeCanvasContextSelection,
  type CanvasContextSelection,
} from "@octant/contracts/canvasContext";
import type { CanvasRecipeFillRequest } from "./CreateCanvasDraft";

/**
 * The turn that asks a thread's agent to fill a Canvas just started from a
 * recipe.
 *
 * It is what a person could have typed, plus the new Canvas attached as the
 * same whole-canvas context the composer attaches by hand. The host
 * reauthorizes that selection at send time, and the agent fills the Canvas by
 * revising it with its own tools and the thread's own authority. Nothing here
 * widens what the agent may do; it only says which Canvas and which recipe.
 */
export function canvasRecipeFillTurn(request: CanvasRecipeFillRequest): {
  readonly message: string;
  readonly selection: CanvasContextSelection;
} {
  const { receipt, recipe, notes } = request;
  const lines = [
    `Please fill in the Canvas "${receipt.title}" I just started from the ${recipe.title} recipe (${String(recipe.id)}).`,
    "Each section marked “To fill” says which block belongs there. Replace those placeholders with real blocks using what this conversation already knows, and revise this Canvas rather than creating a new one.",
  ];
  if (notes.length > 0) lines.push(`It should cover: ${notes}`);
  return {
    message: lines.join("\n\n"),
    selection: decodeCanvasContextSelection({
      id: crypto.randomUUID(),
      canvasId: String(receipt.canvasId),
      versionId: String(receipt.versionId),
      // A Canvas started from a recipe is always at its first version.
      sequence: 1,
      displayName: receipt.title.replace(/[\\/]/g, " "),
      scope: "whole-canvas",
    }),
  };
}
