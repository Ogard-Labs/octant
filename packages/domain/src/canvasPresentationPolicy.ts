import type { CanvasDefinition, CanvasPresentation } from "@octant/contracts/canvas";

type CanvasBlock = CanvasDefinition["blocks"][number];

/**
 * Blocks a person works in rather than reads. The agent may not put these in
 * the thread on its own: a board, plan, or mockup asks for the room and the
 * controls only the sidebar gives it. A person can still expand any Canvas in
 * its thread; this bounds only what the agent asks for unprompted.
 */
const SIDEBAR_ONLY_BLOCK_KINDS: ReadonlySet<CanvasBlock["kind"]> = new Set([
  "diagram",
  "plan",
  "mockup",
]);

/**
 * Why this block keeps the agent's Canvas out of the thread, or `undefined`
 * when it reads there. A design is the one kind judged by more than its kind:
 * a document-size design is an article or spec and reads in the thread like
 * reading blocks do, while a device-size design is reviewed at its own size
 * and a design that runs script waits for the person to start it.
 */
function sidebarOnlyReason(block: CanvasBlock): string | undefined {
  if (block.kind === "design") {
    if (block.runsScript === true) {
      return "A design that runs script is started by the person in the sidebar, so this Canvas opens there.";
    }
    return block.size === "document"
      ? undefined
      : `A ${block.size} design is reviewed in the sidebar, so this Canvas opens there; only a document-size design that runs no script is shown in the thread.`;
  }
  return SIDEBAR_ONLY_BLOCK_KINDS.has(block.kind)
    ? `A ${block.kind} block is worked on in the sidebar, so this Canvas opens there.`
    : undefined;
}

/**
 * Why the agent's request to draw a Canvas inside the thread is refused, or
 * `undefined` when it is admitted. Reading blocks and document-size designs
 * are admitted at any length the definition schema's ordinary block budget
 * allows; the thread shows a long one as a faded teaser the person can expand
 * in place. The reason is written for the agent that asked, so it can choose
 * differently.
 */
export function canvasInlineRefusal(blocks: CanvasDefinition["blocks"]): string | undefined {
  for (const block of blocks) {
    const reason = sidebarOnlyReason(block);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * Where the thread shows this Canvas now. A Canvas asked for inline that has
 * since gained a sidebar-only block (a later revision, or a person's own edit)
 * falls back to the sidebar instead of being drawn in the conversation.
 */
export function effectiveCanvasPresentation(definition: CanvasDefinition): CanvasPresentation {
  if (definition.presentation !== "inline") return "sidebar";
  return canvasInlineRefusal(definition.blocks) === undefined ? "inline" : "sidebar";
}
