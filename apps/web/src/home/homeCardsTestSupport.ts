import type { HomeCardCustomization } from "@octant/contracts/shell";
import type { HomeCardDefinition } from "./homeCards";

/** Every card starts off; a test of what a card shows turns its cards on. */
export function cardsTurnedOn(
  cards: ReadonlyArray<Pick<HomeCardDefinition, "id">>,
): HomeCardCustomization {
  return { order: [], visibility: cards.map((card) => ({ id: card.id, visible: true })) };
}
