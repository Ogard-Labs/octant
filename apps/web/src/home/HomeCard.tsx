import { useId } from "react";
import { OctantCard, OctantCardContent, OctantCardHeader } from "../ui/base/OctantCard";
import type { HomeCardDefinition } from "./homeCards";

/**
 * One card's chrome: icon, title, and count in the header, then its body or one
 * quiet line. The card's data hook runs here, so a card that is off is never
 * mounted and reads nothing. A card that hides when empty leaves the grid
 * instead of showing its line.
 */
export function HomeCard(props: { readonly definition: HomeCardDefinition }) {
  const { definition } = props;
  const content = definition.useContent();
  const titleId = useId();
  if (content.status === "ready" && content.count === 0 && definition.hideWhenEmpty === true) {
    return null;
  }
  const Icon = definition.icon;
  return (
    <OctantCard
      aria-labelledby={titleId}
      className="home-card"
      data-card={definition.id}
      data-state={
        content.status === "loading" ? "loading" : content.count === 0 ? "empty" : "ready"
      }
    >
      <OctantCardHeader className="home-card__header">
        <Icon aria-hidden="true" className="home-card__icon" size={16} strokeWidth={1.8} />
        <h2 className="oct-section-label home-card__title" id={titleId}>
          {definition.title}
        </h2>
        {content.status === "ready" && content.count > 0 ? (
          <span className="oct-meta home-card__count">{content.count}</span>
        ) : null}
      </OctantCardHeader>
      <OctantCardContent className="home-card__body">
        {content.status === "loading" ? (
          <p className="oct-row-detail home-card__quiet">Looking…</p>
        ) : content.count === 0 ? (
          <p className="oct-row-detail home-card__quiet">{definition.emptyLabel}</p>
        ) : (
          content.body
        )}
      </OctantCardContent>
    </OctantCard>
  );
}
