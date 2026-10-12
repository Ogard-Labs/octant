import type { CanvasDefinition, CanvasPresentation } from "@octant/contracts/canvas";

/**
 * Blocks a person works in rather than reads. The agent may not put these in
 * the thread on its own: a board, plan, mockup, or design asks for the room
 * and the controls only the sidebar gives it. A person can still expand any
 * Canvas in its thread; this bounds only what the agent asks for unprompted.
 */
const SIDEBAR_ONLY_BLOCK_KINDS: ReadonlySet<CanvasDefinition["blocks"][number]["kind"]> = new Set([
  "diagram",
  "plan",
  "mockup",
  "design",
]);

/**
 * Why the agent's request to draw a Canvas inside the thread is refused, or
 * `undefined` when it is admitted. Reading blocks are admitted at any length
 * the definition schema's ordinary block budget allows; the thread shows a
 * long one as a faded teaser the person can expand in place. The reason is
 * written for the agent that asked, so it can choose differently.
 */
export function canvasInlineRefusal(blocks: CanvasDefinition["blocks"]): string | undefined {
  const sidebarOnly = blocks.find((block) => SIDEBAR_ONLY_BLOCK_KINDS.has(block.kind));
  if (sidebarOnly !== undefined) {
    return `A ${sidebarOnly.kind} block is worked on in the sidebar, so this Canvas opens there.`;
  }
  return undefined;
}

/**
 * Where the thread shows this Canvas now. A Canvas asked for inline that has
 * since gained a worked-on block (a later revision, or a person's own edit)
 * falls back to the sidebar instead of being drawn in the conversation.
 */
export function effectiveCanvasPresentation(definition: CanvasDefinition): CanvasPresentation {
  if (definition.presentation !== "inline") return "sidebar";
  return canvasInlineRefusal(definition.blocks) === undefined ? "inline" : "sidebar";
}
