import type { CanvasBlock, CanvasDefinition } from "@octant/contracts/canvas";
import { CANVAS_MAX_DECK_SLIDES, CANVAS_DECK_SLIDE_KINDS } from "@octant/contracts/canvas";
import { canvasReadingOrder } from "./canvasDashboardLayout";

/**
 * A deck proposed from the document itself: every screen and reading the
 * document already holds, in the order a person would present them — the
 * designs' frames with their notes, the mockups, then the data blocks — and
 * nothing a flow, deck, tab, or dashboard already places, because a block is
 * placed once. Pure, so the host action that journals it and the agent that
 * asks for one propose the same deck.
 */

/** One proposed slide, in the loose shape the deck block's own authoring takes. */
interface Slide {
  readonly slideId: string;
  readonly blockId: string;
  readonly frameId?: string;
  readonly variantId?: string;
  readonly notes?: string;
}

/** The deck the document's own shape suggests, or nothing when it has too little to present. */
export function proposeCanvasDeck(definition: Pick<CanvasDefinition, "title" | "blocks">):
  | {
      readonly blockId: string;
      readonly kind: "deck";
      readonly title: string;
      readonly slides: ReadonlyArray<Slide>;
    }
  | undefined {
  const slides: Slide[] = [];
  const push = (slide: Slide) => {
    if (slides.length < CANVAS_MAX_DECK_SLIDES) slides.push(slide);
  };
  // The reading order already skips every block a flow, deck, tab, column, or
  // dashboard places, so the proposal presents each block at most once too.
  for (const item of canvasReadingOrder(definition.blocks as ReadonlyArray<CanvasBlock>)) {
    if (item.kind === "group") continue;
    if (item.kind === "dashboard" || item.kind === "flow" || item.kind === "deck") continue;
    const block = item.kind === "block" ? item.block : undefined;
    if (block === undefined) continue;
    if (block.kind === "design") {
      for (const frame of block.frames) {
        push({
          slideId: `slide-${String(block.blockId)}-${String(frame.frameId)}`,
          blockId: String(block.blockId),
          frameId: String(frame.frameId),
          ...(frame.notes === undefined ? {} : { notes: frame.notes }),
        } satisfies Partial<Slide> as Slide);
      }
      continue;
    }
    if (block.kind === "mockup") {
      for (const variant of block.variants ?? []) {
        push({
          slideId: `slide-${String(block.blockId)}-${String(variant.variantId)}`,
          blockId: String(block.blockId),
          variantId: String(variant.variantId),
        });
      }
      if (block.variants === undefined) {
        push({ slideId: `slide-${String(block.blockId)}`, blockId: String(block.blockId) });
      }
      continue;
    }
    if ((CANVAS_DECK_SLIDE_KINDS as readonly string[]).includes(block.kind)) {
      push({ slideId: `slide-${String(block.blockId)}`, blockId: String(block.blockId) });
    }
  }
  if (slides.length < 2) return undefined;
  return {
    blockId: "proposed-deck",
    kind: "deck" as const,
    title: `${definition.title} — deck`,
    slides,
  };
}
