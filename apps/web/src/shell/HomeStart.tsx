import type { HomeCardCustomization } from "@octant/contracts/shell";
import type { ReactNode } from "react";
import { HomeDashboard } from "../home/HomeDashboard";
import type { HomeCardDefinition, HomeListContributor } from "../home/homeCards";

export interface HomeStartProps {
  /** The card area (`HomeDashboard`), which owns its own empty states. */
  readonly dashboard: ReactNode;
}

/**
 * What a start screen offers under its composer before the person types: the
 * card area. The wrapper keeps the stylesheet's spacing for that area in one
 * place.
 */
export function HomeStart(props: HomeStartProps) {
  return <div className="home-start">{props.dashboard}</div>;
}

/** The start screen's card registry and the person's choices over it. */
export interface HomeStartModel {
  /** The card registry for this screen; absent leaves the card area out. */
  readonly cards?: ReadonlyArray<HomeCardDefinition>;
  readonly cardCustomization: HomeCardCustomization;
  readonly onCardCustomizationChange: (next: HomeCardCustomization) => void;
}

const NO_HOME_CARDS: ReadonlyArray<HomeCardDefinition> = [];
const NO_HOME_CARD_CHOICE: HomeCardCustomization = { order: [], visibility: [] };
function ignoreCardChoice(): void {}

/**
 * The list under a start screen's composer, the same in every mode: Chat, Work
 * and Code each hand it their own rows and cards, and the column around it is
 * one stylesheet rule.
 */
export function HomeStartList(props: {
  readonly homeStart: HomeStartModel | undefined;
  readonly extraRows: ReadonlyArray<HomeListContributor>;
  /** The host and Project the list is read for: the key its last answer is kept under. */
  readonly cacheScope: string;
}) {
  return (
    <HomeStart
      dashboard={
        <HomeDashboard
          cards={props.homeStart?.cards ?? NO_HOME_CARDS}
          customization={props.homeStart?.cardCustomization ?? NO_HOME_CARD_CHOICE}
          cacheScope={props.cacheScope}
          extraRows={props.extraRows}
          onCustomizationChange={props.homeStart?.onCardCustomizationChange ?? ignoreCardChoice}
        />
      }
    />
  );
}
