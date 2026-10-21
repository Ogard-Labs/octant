import type { ReactNode } from "react";

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
