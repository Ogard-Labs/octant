import type { HomeCardCustomization } from "@octant/contracts/shell";
import { useEffect, useMemo, useState } from "react";
import { HomeCard } from "./HomeCard";
import { HomeCustomize } from "./HomeCustomize";
import { arrangeHomeCards, type HomeCardDefinition } from "./homeCards";
import "./home.css";

export interface HomeDashboardProps {
  /** The registry: every card this screen could show, available or not. */
  readonly cards: ReadonlyArray<HomeCardDefinition>;
  readonly customization: HomeCardCustomization;
  readonly onCustomizationChange: (next: HomeCardCustomization) => void;
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
 * The card area under the start-screen composer: a Customize control on the
 * right, then the cards the person has on, in the order they chose, in a grid
 * (two columns, one on a phone). The frame knows nothing about any card; it
 * arranges the definitions it is given and lets each one read its own data.
 */
export function HomeDashboard(props: HomeDashboardProps) {
  const painted = useAfterFirstPaint();
  const placements = useMemo(
    () => arrangeHomeCards(props.cards, props.customization),
    [props.cards, props.customization],
  );
  if (!painted || placements.length === 0) return null;
  const visible = placements.filter((placement) => placement.visible);
  return (
    <section aria-label="Home cards" className="home-dashboard">
      <div className="home-dashboard__bar">
        <HomeCustomize
          customization={props.customization}
          definitions={props.cards}
          onChange={props.onCustomizationChange}
          placements={placements}
        />
      </div>
      {visible.length === 0 ? null : (
        <div className="home-dashboard__grid">
          {visible.map((placement) => (
            <HomeCard definition={placement.definition} key={placement.definition.id} />
          ))}
        </div>
      )}
    </section>
  );
}
