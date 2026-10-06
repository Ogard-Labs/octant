import type { CanvasDefinition, CanvasPresentation } from "@octant/contracts/canvas";

/**
 * How many blocks a Canvas may hold and still be drawn inside the
 * conversation. Past this it reads as a document, and a document belongs in
 * the sidebar where it can be read, commented on and kept.
 */
export const CANVAS_INLINE_MAX_BLOCKS = 12;

/**
 * Blocks a person works in rather than reads. Inline, a board's wheel zoom
 * would fight the thread's own scrolling, and a plan or mockup asks for the
 * room and the editing controls only the sidebar gives it.
 */
const SIDEBAR_ONLY_BLOCK_KINDS: ReadonlySet<CanvasDefinition["blocks"][number]["kind"]> = new Set([
  "diagram",
  "plan",
  "mockup",
]);

/**
 * Why a Canvas cannot be drawn inside the thread, or `undefined` when it can.
 * The reason is written for the agent that asked, so it can choose differently.
 */
export function canvasInlineRefusal(blocks: CanvasDefinition["blocks"]): string | undefined {
  if (blocks.length > CANVAS_INLINE_MAX_BLOCKS) {
    return `A Canvas shown in the thread holds at most ${String(CANVAS_INLINE_MAX_BLOCKS)} blocks; this one has ${String(blocks.length)}, so it opens in the sidebar.`;
  }
  const sidebarOnly = blocks.find((block) => SIDEBAR_ONLY_BLOCK_KINDS.has(block.kind));
  if (sidebarOnly !== undefined) {
    return `A ${sidebarOnly.kind} block is worked on in the sidebar, so this Canvas opens there.`;
  }
  return undefined;
}

/**
 * Where the thread shows this Canvas now. A Canvas asked for inline that has
 * since grown past the bound (a later revision, or a person's own edit) falls
 * back to the sidebar instead of stretching the conversation.
 */
export function effectiveCanvasPresentation(definition: CanvasDefinition): CanvasPresentation {
  if (definition.presentation !== "inline") return "sidebar";
  return canvasInlineRefusal(definition.blocks) === undefined ? "inline" : "sidebar";
}
