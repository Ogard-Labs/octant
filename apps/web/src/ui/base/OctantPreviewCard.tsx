import type { ReactElement, ReactNode } from "react";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardPortal,
  PreviewCardPositioner,
  PreviewCardTrigger,
} from "../shadcn/preview-card";

export interface OctantPreviewCardProps {
  /** The element that opens the card on hover or keyboard focus. */
  readonly children: ReactElement;
  readonly content: ReactNode;
  /** Accessible name of the card; it has no visible heading of its own. */
  readonly label: string;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "right" | "bottom" | "left";
}

/**
 * A delayed, non-modal card that can be hovered into and clicked.
 *
 * This is the interactive sibling of `OctantTooltip`'s card surface. A tooltip
 * describes its trigger and closes the moment the pointer leaves it, so a
 * control placed inside one can never be reached; a preview card stays open
 * while the pointer crosses to it and carries no tooltip role, which is what
 * lets it hold actions. Content that only describes belongs in a tooltip.
 */
export function OctantPreviewCard(props: OctantPreviewCardProps) {
  return (
    <PreviewCard>
      <PreviewCardTrigger closeDelay={150} delay={350} render={props.children} />
      <PreviewCardPortal>
        <PreviewCardPositioner
          align={props.align ?? "center"}
          className="octant-preview-card__positioner"
          side={props.side ?? "bottom"}
          sideOffset={8}
        >
          <PreviewCardPopup aria-label={props.label} className="octant-preview-card" role="group">
            {props.content}
          </PreviewCardPopup>
        </PreviewCardPositioner>
      </PreviewCardPortal>
    </PreviewCard>
  );
}
