import { CANVAS_TOOL_NAME } from "./canvasAgentTools";

/**
 * Sent in a turn's required context whenever `octant_canvas` is offered.
 *
 * The same rule in the tool description did not steer a runtime that owns
 * file tools: asked for a memo in Work, it wrote a Markdown file, and after a
 * denial pasted the memo into the reply. Instructions reach the model where a
 * tool description does not. It names no provider and grants nothing.
 */
export const CANVAS_DELIVERY_INSTRUCTIONS =
  "Deliver a document, report, memo, plan, deck, dashboard, page, or prototype the person will keep or share as a Canvas with the octant_canvas tool, not as a file written with your own file tools and not as a long reply, unless the person asks for a file or for plain text. This instruction grants no tools or authority.";

export function offersCanvasTool(
  definitions: ReadonlyArray<{ readonly name: string }> | undefined,
): boolean {
  return definitions?.some((definition) => definition.name === CANVAS_TOOL_NAME) === true;
}
