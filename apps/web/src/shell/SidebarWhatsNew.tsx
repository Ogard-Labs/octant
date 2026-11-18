import { ArrowRight, X } from "../ui/icons";
import type { WhatsNewCardContent } from "../settings/useWhatsNewAfterUpdate";
import { OctantButton } from "../ui/base/OctantButton";
import { ApertureArt } from "./ApertureArt";
import { SIDEBAR_ACCOUNT_TRIGGER_SELECTOR } from "./SidebarProfile";

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
  // The pressed button leaves with the card, which would drop focus to the
  // page. Focus goes to the person's account control, the nearest one that
  // stays: the profile row under the card, or, with the icon rail beside the
  // sidebar, the rail's account face, which is outside the sidebar.
  const leave = (answer: () => void) => () => {
    document.querySelector<HTMLElement>(SIDEBAR_ACCOUNT_TRIGGER_SELECTOR)?.focus();
    answer();
  };
  return (
    <section aria-label="What's new" className="whats-new-card">
      <ApertureArt className="whats-new-card__art" />
      <div className="whats-new-card__dismiss">
        <OctantButton
          aria-label="Dismiss"
          onClick={leave(props.onDismiss)}
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
        <OctantButton onClick={leave(props.onOpenNotes)} size="sm" type="button" variant="ghost">
          Find out what's new
          <ArrowRight aria-hidden="true" size={12} />
        </OctantButton>
      </div>
    </section>
  );
}
