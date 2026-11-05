import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

/** The same saved-draft provenance and recovery affordance in all three modes. */
export function SideChatDraftNotice(props: {
  readonly count: number;
  readonly invalid: boolean;
  readonly onClear: () => void;
}) {
  if (props.invalid)
    return (
      <OctantAlert
        tone="warning"
        action={
          <OctantButton type="button" size="sm" variant="secondary" onClick={props.onClear}>
            Clear draft
          </OctantButton>
        }
      >
        This saved draft’s Side Chat reference is unreadable. Clear the draft and return the reply
        again before sending or queuing.
      </OctantAlert>
    );
  if (props.count === 0) return null;
  return (
    <p role="status">
      This editable draft includes{" "}
      {props.count === 1
        ? "a selected Side Chat reply"
        : `${props.count} selected Side Chat replies`}
      . Its source references will be checked when sent. Nothing has been sent or queued.
    </p>
  );
}
