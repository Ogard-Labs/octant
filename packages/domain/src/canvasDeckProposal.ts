import {
  CANVAS_MAX_DECK_SLIDES,
  type CanvasBlock,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import { canvasReadingOrder, isCanvasDeckSlideKind } from "./canvasDashboardLayout";

/**
 * A deck proposed from the document itself: every screen and reading the
 * document already holds, in the order a person would present them — every
 * static design's frames with their notes, then every mockup at each of its
 * variants, then the data blocks — and nothing a flow, deck, tab, column, or
 * dashboard already places, because a block is placed by one block. Pure, so
 * the host action that journals it and an agent that asks for one propose the
 * same deck, and the proposal passes the same policy a hand-written deck does.
 */

/** One proposed slide, in the shape the deck block's own authoring takes. */
export interface CanvasProposedDeckSlide {
  readonly slideId: string;
  readonly blockId: string;
  readonly frameId?: string;
  readonly variantId?: string;
  readonly notes?: string;
}

export interface CanvasProposedDeck {
  readonly blockId: string;
  readonly kind: "deck";
  readonly title: string;
  readonly slides: ReadonlyArray<CanvasProposedDeckSlide>;
  /** Slides past the deck's budget, left out in presenting order, so a caller can say so. */
  readonly omitted: number;
}

// A deck title is a label; a long Canvas title is cut to leave room for the
// suffix rather than refused.
const DECK_TITLE_MAX_LENGTH = 512;
const DECK_TITLE_SUFFIX = " — deck";

/** A block id the document has not taken: `deck`, then `deck-2`, `deck-3`, … */
function freeBlockId(blocks: ReadonlyArray<CanvasBlock>): string {
  const taken = new Set(blocks.map((block) => String(block.blockId)));
  let candidate = "deck";
  for (let index = 2; taken.has(candidate); index += 1) candidate = `deck-${String(index)}`;
  return candidate;
}

/** The deck the document's own shape suggests, or nothing when it has too little to present. */
export function proposeCanvasDeck(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
): CanvasProposedDeck | undefined {
  const designs: Array<Omit<CanvasProposedDeckSlide, "slideId">> = [];
  const mockups: Array<Omit<CanvasProposedDeckSlide, "slideId">> = [];
  const readings: Array<Omit<CanvasProposedDeckSlide, "slideId">> = [];
  // The reading order already leaves out every block another block places,
  // and a group's children are placed by the group, so only top-level blocks
  // are candidates.
  for (const item of canvasReadingOrder(definition.blocks)) {
    if (item.kind !== "block") continue;
    const block = item.block;
    const blockId = String(block.blockId);
    if (block.kind === "design") {
      // A running design is the prototype tier and keeps its own Run.
      if (block.runsScript === true) continue;
      for (const frame of block.frames) {
        designs.push({
          blockId,
          frameId: String(frame.frameId),
          ...(frame.notes === undefined ? {} : { notes: frame.notes }),
        });
      }
    } else if (block.kind === "mockup") {
      if (block.variants === undefined) mockups.push({ blockId });
      for (const variant of block.variants ?? []) {
        mockups.push({ blockId, variantId: String(variant.variantId) });
      }
    } else if (isCanvasDeckSlideKind(block.kind)) {
      readings.push({ blockId });
    }
  }
  const ordered = [...designs, ...mockups, ...readings];
  if (ordered.length < 2) return undefined;
  const slides = ordered
    .slice(0, CANVAS_MAX_DECK_SLIDES)
    .map((slide, index) => ({ slideId: `s${String(index + 1)}`, ...slide }));
  const title = definition.title.slice(0, DECK_TITLE_MAX_LENGTH - DECK_TITLE_SUFFIX.length);
  return {
    blockId: freeBlockId(definition.blocks),
    kind: "deck",
    title: `${title.trimEnd()}${DECK_TITLE_SUFFIX}`,
    slides,
    omitted: ordered.length - slides.length,
  };
}
