import type { HomeCardCustomization } from "@octant/contracts/shell";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { HomeCard } from "./HomeCard";
import { HomeCustomize } from "./HomeCustomize";
import { HomeList } from "./HomeList";
import {
  arrangeHomeCards,
  isGridCard,
  type HomeCardDefinition,
  type HomeListContributor,
} from "./homeCards";
import "./home.css";

export interface HomeDashboardProps {
  /** The registry: every card this screen could show, available or not. */
  readonly cards: ReadonlyArray<HomeCardDefinition>;
  readonly customization: HomeCardCustomization;
  readonly onCustomizationChange: (next: HomeCardCustomization) => void;
  /**
   * Rows this screen adds to the list that are not cards of the registry (what is
   * assigned to the person, the threads to continue). They are always on and
   * Customize does not list them.
   */
  readonly extraRows?: ReadonlyArray<HomeListContributor> | undefined;
  /** The host and Project the list is read for: the key its last answer is kept under. */
  readonly cacheScope?: string | undefined;
  /** Injectable for tests; defaults to the browser's local storage. */
  readonly cacheStorage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  /**
   * A section below the cards, drawn only on screens that have one — Code
   * Home's activity panel. It shares the first-paint wait.
   */
  readonly activity?: ReactNode;
}

/**
 * True once the screen has painted. The composer is the first thing on a start
 * screen, so everything under it waits for the frame after the first commit
 * rather than competing with it; a card's reads begin only then too.
 */
function useAfterFirstPaint(): boolean {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") {
      const timer = setTimeout(() => setPainted(true), 0);
      return () => clearTimeout(timer);
    }
    const frame = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return painted;
}

/**
 * The area under the start-screen composer. Cards that give rows (Needs you,
 * Working now, Running services, Pull requests) are not drawn as cards: their
 * rows go into one calm list, with a "…" menu for Customize at the right end of
 * its first header. Any other card keeps its place in a grid below the list.
 * The frame knows nothing about any card; it arranges the definitions it is
 * given and lets each one read its own data.
 */
export function HomeDashboard(props: HomeDashboardProps) {
  const painted = useAfterFirstPaint();
  const placements = useMemo(
    () => arrangeHomeCards(props.cards, props.customization),
    [props.cards, props.customization],
  );
  const extraRows = props.extraRows;
  const contributors = useMemo(
    (): ReadonlyArray<HomeListContributor> => [
      ...placements.flatMap((placement) =>
        placement.visible && placement.definition.useListRows !== undefined
          ? [{ id: placement.definition.id, useRows: placement.definition.useListRows }]
          : [],
      ),
      ...(extraRows ?? []),
    ],
    [placements, extraRows],
  );
  if (
    !painted ||
    (placements.length === 0 && contributors.length === 0 && props.activity === undefined)
  ) {
    return null;
  }
  const grid = placements.flatMap((placement) =>
    placement.visible && isGridCard(placement.definition) ? [placement.definition] : [],
  );
  const customize =
    placements.length === 0 ? null : (
      <HomeCustomize
        customization={props.customization}
        definitions={props.cards}
        onChange={props.onCustomizationChange}
        placements={placements}
      />
    );
  const listed = contributors.length > 0;
  return (
    <section aria-label="Home cards" className="home-dashboard">
      {listed ? (
        <HomeList
          cacheScope={props.cacheScope}
          contributors={contributors}
          menu={customize}
          storage={props.cacheStorage}
        />
      ) : (
        <div className="home-dashboard__bar">{customize}</div>
      )}
      {grid.length === 0 ? null : (
        <div className="home-dashboard__grid">
          {grid.map((definition) => (
            <HomeCard definition={definition} key={definition.id} />
          ))}
        </div>
      )}
      {props.activity}
    </section>
  );
}
