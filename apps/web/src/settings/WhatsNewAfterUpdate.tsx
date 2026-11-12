import { WhatsNewAnnouncementDialog } from "./WhatsNewAnnouncementDialog";
import { WhatsNewDialog } from "./WhatsNewDialog";
import type { WhatsNewController } from "./useWhatsNewAfterUpdate";

/**
 * The shell's two modal surfaces for a release: the announcement, when one is
 * bundled, and the notes dialog either one opens. The sidebar draws the card.
 */
export function WhatsNewAfterUpdate(props: { readonly controller: WhatsNewController }) {
  const controller = props.controller;
  return (
    <>
      <WhatsNewAnnouncementDialog
        announcements={controller.announcements}
        onNotNow={controller.dismiss}
        onOpenNotes={controller.openNotes}
        restoreFocus={controller.restoreFocus}
      />
      <WhatsNewDialog
        document={controller.document}
        onClose={controller.closeNotes}
        open={controller.notesOpen}
        restoreFocus={controller.restoreFocus}
      />
    </>
  );
}
