import { OctantButton } from "../ui/base/OctantButton";
import type { ComposerNoticeItem } from "./ComposerNotice";

/**
 * The same saved-draft provenance and recovery affordance in all three modes,
 * for the composer's notice card.
 */
export function sideChatDraftNotice(props: {
  readonly count: number;
  readonly invalid: boolean;
  readonly onClear: () => void;
}): ComposerNoticeItem | undefined {
  if (props.invalid)
    return {
      key: "side-chat-draft",
      tone: "warning",
      text: "This saved draft’s Side Chat reference is unreadable. Clear the draft and return the reply again before sending or queuing.",
      action: (
        <OctantButton type="button" size="sm" variant="secondary" onClick={props.onClear}>
          Clear draft
        </OctantButton>
      ),
    };
  if (props.count === 0) return undefined;
  return {
    key: "side-chat-draft",
    tone: "neutral",
    text: `This editable draft includes ${
      props.count === 1 ? "a selected Side Chat reply" : `${props.count} selected Side Chat replies`
    }. Its source references will be checked when sent. Nothing has been sent or queued.`,
  };
}
