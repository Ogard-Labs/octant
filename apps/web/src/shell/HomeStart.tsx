import type { CodeClient } from "@octant/client-runtime/code-client";
import type { HomeCardCustomization } from "@octant/contracts/shell";
import { lazy, Suspense, type ReactNode } from "react";
import type { CodeHomeActivityProps } from "../home/CodeHomeActivity";
import { HomeDashboard } from "../home/HomeDashboard";
import type { HomeCardDefinition, HomeListContributor } from "../home/homeCards";

const CodeHomeActivity = lazy(() =>
  import("../home/CodeHomeActivity").then(({ CodeHomeActivity }) => ({
    default: CodeHomeActivity,
  })),
);

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

/**
 * What the Code Home activity panel reads and where it navigates — wired on
 * the app side, where the client and the thread selectors live. Absent on
 * every surface that is not the Code Home welcome.
 */
export interface CodeHomeActivitySource {
  readonly read: NonNullable<CodeClient["readHomeActivity"]>;
  readonly openThread: CodeHomeActivityProps["onOpenThread"];
  readonly openExternal?: ((url: string) => void) | undefined;
}

/** The start screen's card registry and the person's choices over it. */
export interface HomeStartModel {
  /** The card registry for this screen; absent leaves the card area out. */
  readonly cards?: ReadonlyArray<HomeCardDefinition>;
  readonly cardCustomization: HomeCardCustomization;
  readonly onCardCustomizationChange: (next: HomeCardCustomization) => void;
  /** The Code Home activity panel's read and navigation; Code Home only. */
  readonly codeActivity?: CodeHomeActivitySource | undefined;
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
  const codeActivity = props.homeStart?.codeActivity;
  return (
    <HomeStart
      dashboard={
        <HomeDashboard
          {...(codeActivity === undefined
            ? {}
            : {
                activity: (
                  <Suspense fallback={null}>
                    <CodeHomeActivity
                      customization={props.homeStart?.cardCustomization ?? NO_HOME_CARD_CHOICE}
                      onCustomizationChange={
                        props.homeStart?.onCardCustomizationChange ?? ignoreCardChoice
                      }
                      onOpenThread={codeActivity.openThread}
                      {...(codeActivity.openExternal === undefined
                        ? {}
                        : { onOpenExternal: codeActivity.openExternal })}
                      read={codeActivity.read}
                    />
                  </Suspense>
                ),
              })}
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
