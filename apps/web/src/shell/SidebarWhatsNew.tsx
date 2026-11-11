import { X } from "lucide-react";
import type { WhatsNewCardContent } from "../settings/useWhatsNewAfterUpdate";
import { OctantButton } from "../ui/base/OctantButton";
import { ApertureArt } from "./ApertureArt";

export interface SidebarWhatsNewProps {
  readonly content: WhatsNewCardContent;
  readonly onDismiss: () => void;
  readonly onOpenNotes: () => void;
}

/**
 * A quiet raised card at the foot of the full sidebar, shown once after an
 * update the person chose. It is not drawn on the icon rail, so nothing is
 * acknowledged until the sidebar is open and the person answers it.
 */
export function SidebarWhatsNew(props: SidebarWhatsNewProps) {
  return (
    <section aria-label="What's new" className="whats-new-card">
      <ApertureArt className="whats-new-card__art" />
      <div className="whats-new-card__dismiss">
        <OctantButton
          aria-label="Dismiss"
          onClick={props.onDismiss}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={12} />
        </OctantButton>
      </div>
      <div className="whats-new-card__body">
        <p className="whats-new-card__kicker">New · v{props.content.version}</p>
        <p className="whats-new-card__headline">{props.content.headline}</p>
        {props.content.summary === undefined ? null : (
          <p className="whats-new-card__summary">{props.content.summary}</p>
        )}
        <OctantButton onClick={props.onOpenNotes} size="sm" type="button" variant="ghost">
          Find out what's new
        </OctantButton>
      </div>
    </section>
  );
}
