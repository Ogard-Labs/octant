import type { CanvasDefinition, CanvasPresentation } from "@octant/contracts/canvas";

type CanvasBlock = CanvasDefinition["blocks"][number];

/**
 * Blocks a person works in rather than looks at. A plan's tasks and a mockup's
 * variants ask for the room and the controls only the sidebar gives them, so
 * the thread shows a Canvas holding one as a preview card that opens there. A
 * diagram board is not here: the thread draws it without its layout runtime,
 * so it can be panned and zoomed but not rearranged, and dragging a node
 * happens in the sidebar.
 */
const SIDEBAR_ONLY_BLOCK_KINDS: ReadonlySet<CanvasBlock["kind"]> = new Set(["plan", "mockup"]);

/**
 * Why this block keeps the agent's Canvas out of the thread, or `undefined`
 * when it is drawn there. A design is the one kind judged by more than its
 * kind: a document-size design is a page as wide as the column, so it is drawn
 * in the thread, and one that runs script waits there for the person's Run in
 * the same sandboxed frame the sidebar uses. A device-size design is reviewed
 * at its own size, so the thread shows it as a preview card.
 */
function sidebarOnlyReason(block: CanvasBlock): string | undefined {
  if (block.kind === "design") {
    return block.size === "document"
      ? undefined
      : `A ${block.size} design is reviewed in the sidebar, so the thread shows this Canvas as a preview card that opens there; only a document-size design is drawn in the thread.`;
  }
  return SIDEBAR_ONLY_BLOCK_KINDS.has(block.kind)
    ? `A ${block.kind} block is worked on in the sidebar, so the thread shows this Canvas as a preview card that opens there.`
    : undefined;
}

/**
 * Why the agent's request to draw a Canvas inside the thread is refused, or
 * `undefined` when it is admitted. Reading blocks, charts, dashboards, tables,
 * math, diagrams, and document-size designs are admitted at any length the
 * definition schema's ordinary block budget allows; the thread shows a long
 * one as a faded teaser the person can expand in place. The reason is written
 * for the agent that asked, so it can choose differently.
 */
export function canvasInlineRefusal(blocks: CanvasDefinition["blocks"]): string | undefined {
  for (const block of blocks) {
    const reason = sidebarOnlyReason(block);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * Where the thread shows this Canvas now. A Canvas asked for inline that holds
 * a sidebar-only block (from the start, after a later revision, or after a
 * person's own edit) is a sidebar Canvas; its definition keeps the inline
 * request, which the thread reads to show it as a preview card.
 */
export function effectiveCanvasPresentation(definition: CanvasDefinition): CanvasPresentation {
  if (definition.presentation !== "inline") return "sidebar";
  return canvasInlineRefusal(definition.blocks) === undefined ? "inline" : "sidebar";
}
