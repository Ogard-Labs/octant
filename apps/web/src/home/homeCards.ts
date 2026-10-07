import type { HomeCardCustomization } from "@octant/contracts/shell";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * What a card says once it has looked. `loading` keeps the card's place with
 * a quiet line; `ready` with a count of zero is the card's empty state, so a
 * card never shows rows it does not have.
 */
export type HomeCardContent =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      /** Shown beside the title, and the only thing that decides "empty". */
      readonly count: number;
      /** Rendered inside the card when `count` is above zero. */
      readonly body: ReactNode;
      /**
       * Replaces the card's `emptyLabel` while `count` is zero, for a card that
       * could not look: "nothing is running" would be a claim it never made.
       */
      readonly emptyLabel?: string;
    };

/**
 * One card the start screen can show. A card is a value, not a place in the
 * frame: the screen builds the list from the registry and passes it to
 * `HomeDashboard`, so a new card is a new definition and nothing else.
 */
export interface HomeCardDefinition {
  /** Stable, lower-case, stored in settings; never reused for another card. */
  readonly id: string;
  readonly title: string;
  readonly icon: LucideIcon;
  /** Whether the card is on until the person turns it off. */
  readonly defaultOn: boolean;
  /**
   * False when what the card needs is missing here (no GitHub connection, no
   * client for this window). The card is hidden and absent from Customize
   * rather than shown broken.
   */
  readonly available: boolean;
  /** Drop the whole card while it has nothing to say, instead of one quiet line. */
  readonly hideWhenEmpty?: boolean;
  /** The one quiet line an empty card shows. */
  readonly emptyLabel: string;
  /**
   * The card's data, called as a hook by the frame, and only while the card is
   * on. A card that is off, or unavailable, therefore reads and fetches
   * nothing.
   */
  readonly useContent: () => HomeCardContent;
}

export interface HomeCardPlacement {
  readonly definition: HomeCardDefinition;
  readonly visible: boolean;
}

export function isDefaultHomeCardCustomization(customization: HomeCardCustomization): boolean {
  return customization.order.length === 0 && customization.visibility.length === 0;
}

/**
 * The cards this window can offer, in the order the person asked for, each
 * with whether it is on. A stored id the registry no longer knows is ignored;
 * a card the stored order does not name follows in registry order.
 */
export function arrangeHomeCards(
  definitions: ReadonlyArray<HomeCardDefinition>,
  customization: HomeCardCustomization,
): ReadonlyArray<HomeCardPlacement> {
  const offered = definitions.filter((definition) => definition.available);
  const unplaced = new Map(offered.map((definition) => [definition.id, definition]));
  const ordered: HomeCardDefinition[] = [];
  for (const id of customization.order) {
    const definition = unplaced.get(id);
    if (definition === undefined) continue;
    ordered.push(definition);
    unplaced.delete(id);
  }
  for (const definition of offered) {
    if (unplaced.has(definition.id)) ordered.push(definition);
  }
  const chosen = new Map(customization.visibility.map((entry) => [entry.id, entry.visible]));
  return ordered.map((definition) => ({
    definition,
    visible: chosen.get(definition.id) ?? definition.defaultOn,
  }));
}

/**
 * Turn a card on or off. A choice equal to the card's default is not stored,
 * so a default that changes later still reaches a person who never moved away
 * from it.
 */
export function setHomeCardVisible(
  definitions: ReadonlyArray<HomeCardDefinition>,
  customization: HomeCardCustomization,
  id: string,
  visible: boolean,
): HomeCardCustomization {
  const definition = definitions.find((candidate) => candidate.id === id);
  if (definition === undefined) return customization;
  const others = customization.visibility.filter((entry) => entry.id !== id);
  return {
    order: customization.order,
    visibility: visible === definition.defaultOn ? others : [...others, { id, visible }],
  };
}

/**
 * Put a card at a new position among the cards on offer. The stored order
 * keeps ids of cards this window cannot offer right now, after the ones it
 * can, so a card that comes back keeps its place.
 */
export function moveHomeCard(
  definitions: ReadonlyArray<HomeCardDefinition>,
  customization: HomeCardCustomization,
  id: string,
  toIndex: number,
): HomeCardCustomization {
  const arranged = arrangeHomeCards(definitions, customization).map(
    (placement) => placement.definition.id,
  );
  const from = arranged.indexOf(id);
  if (from === -1) return customization;
  const to = Math.min(Math.max(toIndex, 0), arranged.length - 1);
  if (to === from) return customization;
  const next = arranged.filter((candidate) => candidate !== id);
  next.splice(to, 0, id);
  const unseen = customization.order.filter((candidate) => !next.includes(candidate));
  return { order: [...next, ...unseen], visibility: customization.visibility };
}
